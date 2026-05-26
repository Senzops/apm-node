import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// Connect Instrumentation
//
// Instruments the `connect` middleware framework — the foundation that
// Express was originally built on. Many production apps still use
// Connect directly for lightweight HTTP services.
//
// Patches the connect app's use() method to wrap every middleware
// function with a span capturing execution time and errors.
//
// Connect middleware signature: (req, res, next) or (err, req, res, next)
//
// Captured attributes:
//   - connect.type: 'middleware'
//   - connect.name: middleware function name
//   - connect.route: mount path (if provided)
//   - framework: 'connect'
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Middleware wrapping
// ---------------------------------------------------------------------------

const wrapMiddleware = (
  fn: Function,
  route: string,
  options?: SenzorOptions
): Function => {
  if (typeof fn !== 'function') return fn;
  if ((fn as any).__senzorWrapped) return fn;

  const middlewareName = fn.name || 'anonymous';
  const isErrorHandler = fn.length >= 4;

  let wrapped: Function;

  if (isErrorHandler) {
    // Error-handling middleware: (err, req, res, next)
    wrapped = function wrappedConnectErrorMiddleware(
      this: any, err: any, req: any, res: any, next: any
    ) {
      const span = startCapturedSpan(
        `Connect error ${middlewareName}`,
        'function',
        {
          'connect.type': 'error_middleware',
          'connect.name': middlewareName,
          'connect.route': route,
          framework: 'connect',
        },
        options
      );

      if (!span) return fn.call(this, err, req, res, next);

      return runWithCapturedSpan(span, () => {
        const wrappedNext = function (...args: any[]) {
          const hasError = args.length > 0 && args[0] instanceof Error;
          span.end(hasError ? 500 : 0, hasError ? { 'error.message': args[0].message } : {});
          return next?.(...args);
        };

        try {
          const result = fn.call(this, err, req, res, wrappedNext);
          if (result && typeof result.then === 'function') {
            return result.catch((error: any) => {
              span.end(500, { 'error.message': error?.message });
              throw error;
            });
          }
          return result;
        } catch (error: any) {
          span.end(500, { 'error.message': error?.message });
          throw error;
        }
      });
    };
  } else {
    // Standard middleware: (req, res, next)
    wrapped = function wrappedConnectMiddleware(
      this: any, req: any, res: any, next: any
    ) {
      const span = startCapturedSpan(
        `Connect ${middlewareName}`,
        'function',
        {
          'connect.type': 'middleware',
          'connect.name': middlewareName,
          'connect.route': route,
          'http.route': route !== '/' ? route : undefined,
          framework: 'connect',
        },
        options
      );

      if (!span) return fn.call(this, req, res, next);

      return runWithCapturedSpan(span, () => {
        const wrappedNext = function (...args: any[]) {
          const hasError = args.length > 0 && args[0] instanceof Error;
          span.end(hasError ? 500 : 0, hasError ? { 'error.message': args[0].message } : {});
          return next?.(...args);
        };

        try {
          const result = fn.call(this, req, res, wrappedNext);
          if (result && typeof result.then === 'function') {
            return result.catch((error: any) => {
              span.end(500, { 'error.message': error?.message });
              throw error;
            });
          }
          return result;
        } catch (error: any) {
          span.end(500, { 'error.message': error?.message });
          throw error;
        }
      });
    };
  }

  // Preserve original function length for Connect's error handler detection
  Object.defineProperty(wrapped, 'length', { value: fn.length });
  (wrapped as any).__senzorWrapped = true;

  return wrapped;
};

// ---------------------------------------------------------------------------
// app.use() patching
// ---------------------------------------------------------------------------

const patchConnectApp = (connectModule: any, options?: SenzorOptions) => {
  if (typeof connectModule !== 'function') return;

  // connect() returns an app. We need to patch the app's prototype.
  // Connect apps have use() on their prototype chain via proto.

  // Create a probe app to get the prototype
  let appProto: any;

  try {
    const app = connectModule();
    appProto = Object.getPrototypeOf(app);
  } catch { }

  if (!appProto) return;

  // Patch use()
  if (typeof appProto.use === 'function') {
    patchMethod(
      appProto,
      'use',
      'senzor.connect.app.use',
      (original) =>
        function patchedUse(this: any, ...args: any[]) {
          // use() accepts:
          //   use(fn)
          //   use(route, fn)
          //   use(route, fn1, fn2, ...)

          let route = '/';
          let startIdx = 0;

          if (typeof args[0] === 'string') {
            route = args[0];
            startIdx = 1;
          }

          // Wrap all function arguments
          for (let i = startIdx; i < args.length; i++) {
            if (typeof args[i] === 'function') {
              args[i] = wrapMiddleware(args[i], route, options);
            }
          }

          return original.apply(this, args);
        }
    );
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentConnect = (options?: SenzorOptions) => {
  hookRequire('connect', (exports: any) => {
    patchConnectApp(exports, options);

    if (exports?.default) {
      patchConnectApp(exports.default, options);
    }
  });
};
