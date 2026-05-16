import { Context } from '../core/context';
import { SenzorOptions } from '../core/types';
import { CapturedSpan, runWithCapturedSpan, startCapturedSpan } from './span';

export type FrameworkSpanType =
  | 'middleware'
  | 'router'
  | 'request_handler'
  | 'route_handler'
  | 'controller_handler'
  | 'lifecycle_hook'
  | 'error_handler'
  | 'event_handler';

export interface FrameworkSpanInfo {
  framework: string;
  type: FrameworkSpanType;
  name: string;
  route?: string;
  method?: string;
  layerPath?: string;
  handlerName?: string;
  request?: any;
  response?: any;
  attributes?: Record<string, unknown>;
}

interface InvokeOptions {
  callbackIndex?: number;
  callbackCompletesSpan?: boolean;
  responseEndsSpan?: boolean;
}

const ignoredNextValues = new Set([undefined, null, 'route', 'router']);

export const shouldCaptureFrameworkSpan = (
  type: FrameworkSpanType,
  options?: SenzorOptions
): boolean => {
  if (options?.frameworkSpans === false) return false;
  if (type === 'middleware' && options?.captureMiddlewareSpans === false) return false;
  if (type === 'router' && options?.captureRouterSpans === false) return false;
  if (type === 'lifecycle_hook' && options?.captureLifecycleHookSpans === false) return false;
  if (options?.ignoreFrameworkSpanTypes?.includes(type)) return false;
  return true;
};

const statusFrom = (
  info: FrameworkSpanInfo,
  fallback = 0
): number => {
  const res = info.response;
  return (
    res?.statusCode ||
    res?.status ||
    res?.raw?.statusCode ||
    res?.status_code ||
    fallback
  );
};

const isPromiseLike = (value: unknown): value is Promise<unknown> =>
  Boolean(value && typeof (value as any).then === 'function');

const runWithParentOf = <T>(
  span: CapturedSpan,
  fn: () => T
): T => {
  if (!span.parentSpanId) return fn();
  return Context.withActiveSpan(span.parentSpanId, fn);
};

const copyFunctionProperties = (
  source: Function,
  target: Function
) => {
  for (const key in source as any) {
    try {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        get() {
          return (source as any)[key];
        },
        set(value) {
          (source as any)[key] = value;
        }
      });
    } catch { }
  }
};

export const invokeWithFrameworkSpan = (
  handler: Function,
  thisArg: unknown,
  args: any[],
  info: FrameworkSpanInfo,
  options?: SenzorOptions,
  invokeOptions: InvokeOptions = {}
) => {
  if (!shouldCaptureFrameworkSpan(info.type, options) || !Context.current()) {
    return handler.apply(thisArg, args);
  }

  const span = startCapturedSpan(
    info.name,
    'function',
    {
      framework: info.framework,
      'senzor.framework': info.framework,
      'senzor.framework.type': info.type,
      'http.route': info.route,
      route: info.route,
      method: info.method,
      layerPath: info.layerPath,
      handlerName: info.handlerName,
      ...info.attributes
    },
    options
  );

  if (!span) return handler.apply(thisArg, args);

  let ended = false;
  const cleanup: Array<() => void> = [];

  const endSpan = (
    status = statusFrom(info),
    meta: Record<string, unknown> = {}
  ) => {
    if (ended) return;
    ended = true;

    for (const clean of cleanup) {
      try { clean(); } catch { }
    }

    span.end(status, meta);
  };

  const res = info.response;
  if (invokeOptions.responseEndsSpan !== false && res?.once) {
    const onFinish = () =>
      endSpan(statusFrom(info), { completion: 'response.finish' });
    const onClose = () =>
      endSpan(statusFrom(info), { completion: 'response.close' });

    res.once('finish', onFinish);
    res.once('close', onClose);

    cleanup.push(() => {
      try { res.removeListener?.('finish', onFinish); } catch { }
      try { res.removeListener?.('close', onClose); } catch { }
    });
  }

  const callbackIndex =
    invokeOptions.callbackIndex ??
    args.findIndex((arg) => typeof arg === 'function');

  if (
    invokeOptions.callbackCompletesSpan !== false &&
    callbackIndex >= 0 &&
    typeof args[callbackIndex] === 'function'
  ) {
    const originalCallback = args[callbackIndex];
    args[callbackIndex] = function wrappedFrameworkCallback(
      this: unknown,
      ...callbackArgs: any[]
    ) {
      const maybeError = callbackArgs[0];
      const hasError = !ignoredNextValues.has(maybeError);

      endSpan(hasError ? 500 : statusFrom(info), {
        completion: 'callback',
        error: hasError ? String(maybeError?.message || maybeError) : undefined,
        'error.type': hasError
          ? maybeError?.name || typeof maybeError
          : undefined
      });

      return runWithParentOf(span, () =>
        originalCallback.apply(this, callbackArgs)
      );
    };
  }

  return runWithCapturedSpan(span, () => {
    try {
      const result = handler.apply(thisArg, args);

      if (isPromiseLike(result)) {
        return result.then(
          (value) => {
            endSpan(statusFrom(info), { completion: 'promise.resolve' });
            return value;
          },
          (error) => {
            endSpan(500, {
              completion: 'promise.reject',
              error: error?.message,
              'error.type': error?.name || 'Error'
            });
            throw error;
          }
        );
      }

      if (callbackIndex < 0 && invokeOptions.responseEndsSpan === false) {
        endSpan(statusFrom(info), { completion: 'sync.return' });
      }

      return result;
    } catch (error: any) {
      endSpan(500, {
        completion: 'throw',
        error: error?.message,
        'error.type': error?.name || 'Error'
      });
      throw error;
    }
  });
};

export const wrapFrameworkHandler = <T extends Function>(
  handler: T,
  getInfo: (thisArg: unknown, args: any[]) => FrameworkSpanInfo,
  options?: SenzorOptions,
  invokeOptions: InvokeOptions = {}
): T => {
  if (typeof handler !== 'function') return handler;

  const wrapped = function wrappedFrameworkHandler(
    this: unknown,
    ...args: any[]
  ) {
    return invokeWithFrameworkSpan(
      handler,
      this,
      args,
      getInfo(this, args),
      options,
      invokeOptions
    );
  };

  copyFunctionProperties(handler, wrapped);
  return wrapped as unknown as T;
};

export const wrapFrameworkHandlerWithArity = <T extends Function>(
  handler: T,
  getInfo: (thisArg: unknown, args: any[]) => FrameworkSpanInfo,
  options?: SenzorOptions,
  invokeOptions: InvokeOptions = {}
): T => {
  if (typeof handler !== 'function') return handler;

  const invoke = (thisArg: unknown, args: any[]) =>
    invokeWithFrameworkSpan(
      handler,
      thisArg,
      args,
      getInfo(thisArg, args),
      options,
      invokeOptions
    );

  let wrapped: Function;

  switch (handler.length) {
    case 4:
      wrapped = function wrapped4(this: unknown, a: any, b: any, c: any, d: any) {
        return invoke(this, [a, b, c, d]);
      };
      break;
    case 3:
      wrapped = function wrapped3(this: unknown, a: any, b: any, c: any) {
        return invoke(this, [a, b, c]);
      };
      break;
    case 2:
      wrapped = function wrapped2(this: unknown, a: any, b: any) {
        return invoke(this, [a, b]);
      };
      break;
    case 1:
      wrapped = function wrapped1(this: unknown, a: any) {
        return invoke(this, [a]);
      };
      break;
    default:
      wrapped = function wrapped0(this: unknown) {
        return invoke(this, Array.from(arguments));
      };
      break;
  }

  copyFunctionProperties(handler, wrapped);
  return wrapped as unknown as T;
};
