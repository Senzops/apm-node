import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { wrapFrameworkHandlerWithArity } from './framework';

const FACTORY_PATCHED = Symbol.for('senzor.fastify.factory.patched');
const INSTANCE_PATCHED = Symbol.for('senzor.fastify.instance.patched');

const lifecycleHookNames = new Set([
  'onRequest',
  'preParsing',
  'preValidation',
  'preHandler',
  'preSerialization',
  'onSend',
  'onResponse',
  'onError',
  'onTimeout',
  'onRequestAbort'
]);

const routeLifecycleKeys = [
  'onRequest',
  'preParsing',
  'preValidation',
  'preHandler',
  'preSerialization',
  'onSend',
  'onResponse',
  'onError'
];

const getRoute = (request: any, fallback?: string): string | undefined =>
  request?.routeOptions?.url ||
  request?.routerPath ||
  request?.context?.config?.url ||
  fallback;

const wrapHook = (
  hookName: string,
  handler: any,
  options?: SenzorOptions,
  route?: string
) => {
  if (typeof handler !== 'function') return handler;

  return wrapFrameworkHandlerWithArity(
    handler,
    (_thisArg, args) => {
      const request = args[0];
      const reply = args[1];
      const currentRoute = getRoute(request, route);

      return {
        framework: 'fastify',
        type: hookName === 'onError' ? 'error_handler' : 'lifecycle_hook',
        name: `fastify.${hookName} ${currentRoute || request?.url || ''}`.trim(),
        route: currentRoute,
        method: request?.method,
        handlerName: handler.name || hookName,
        request,
        response: reply?.raw || reply,
        attributes: {
          'fastify.hook': hookName,
          'fastify.type': hookName === 'onError' ? 'error_handler' : 'lifecycle_hook',
          'http.route': currentRoute,
          url: request?.url
        }
      };
    },
    options,
    {
      callbackCompletesSpan: true,
      responseEndsSpan: false
    }
  );
};

const wrapRouteHandler = (
  handler: any,
  options?: SenzorOptions,
  route?: string
) => {
  if (typeof handler !== 'function') return handler;

  return wrapFrameworkHandlerWithArity(
    handler,
    (_thisArg, args) => {
      const request = args[0];
      const reply = args[1];
      const currentRoute = getRoute(request, route);

      return {
        framework: 'fastify',
        type: 'route_handler',
        name: `fastify.route_handler ${request?.method || ''} ${currentRoute || request?.url || ''}`.trim(),
        route: currentRoute,
        method: request?.method,
        handlerName: handler.name || 'handler',
        request,
        response: reply?.raw || reply,
        attributes: {
          'fastify.type': 'route_handler',
          'http.route': currentRoute,
          url: request?.url
        }
      };
    },
    options,
    {
      callbackCompletesSpan: true,
      responseEndsSpan: true
    }
  );
};

const wrapMaybeArray = (
  value: any,
  wrap: (handler: any) => any
) => {
  if (Array.isArray(value)) return value.map(wrap);
  return wrap(value);
};

const patchFastifyInstance = (
  instance: any,
  options?: SenzorOptions
) => {
  if (!instance || instance[INSTANCE_PATCHED]) return instance;

  Object.defineProperty(instance, INSTANCE_PATCHED, {
    value: true,
    enumerable: false
  });

  patchMethod(
    instance,
    'addHook',
    'senzor.fastify.addHook',
    (original) =>
      function patchedFastifyAddHook(this: any, hookName: string, handler: any) {
        if (lifecycleHookNames.has(hookName)) {
          return original.call(this, hookName, wrapHook(hookName, handler, options));
        }

        return original.apply(this, arguments as any);
      }
  );

  patchMethod(
    instance,
    'route',
    'senzor.fastify.route',
    (original) =>
      function patchedFastifyRoute(this: any, routeOptions: any) {
        if (!routeOptions || typeof routeOptions !== 'object') {
          return original.apply(this, arguments as any);
        }

        const nextRouteOptions = { ...routeOptions };
        const route =
          nextRouteOptions.url ||
          nextRouteOptions.path ||
          nextRouteOptions.routePath;

        if (nextRouteOptions.handler) {
          nextRouteOptions.handler = wrapRouteHandler(
            nextRouteOptions.handler,
            options,
            route
          );
        }

        for (const key of routeLifecycleKeys) {
          if (nextRouteOptions[key]) {
            nextRouteOptions[key] = wrapMaybeArray(
              nextRouteOptions[key],
              (handler) => wrapHook(key, handler, options, route)
            );
          }
        }

        return original.call(this, nextRouteOptions);
      }
  );

  patchMethod(
    instance,
    'setErrorHandler',
    'senzor.fastify.setErrorHandler',
    (original) =>
      function patchedFastifySetErrorHandler(this: any, handler: any) {
        return original.call(
          this,
          wrapFrameworkHandlerWithArity(
            handler,
            (_thisArg, args) => {
              const request = args[1];
              const reply = args[2];
              const route = getRoute(request);

              return {
                framework: 'fastify',
                type: 'error_handler',
                name: `fastify.error_handler ${route || request?.url || ''}`.trim(),
                route,
                method: request?.method,
                handlerName: handler?.name || 'errorHandler',
                request,
                response: reply?.raw || reply,
                attributes: {
                  'fastify.type': 'error_handler',
                  error: args[0]?.message,
                  'error.type': args[0]?.name || typeof args[0]
                }
              };
            },
            options,
            {
              callbackCompletesSpan: true,
              responseEndsSpan: true
            }
          )
        );
      }
  );

  return instance;
};

const copyFactoryProperties = (
  source: any,
  target: any
) => {
  for (const key of Reflect.ownKeys(source)) {
    if (['length', 'name', 'prototype'].includes(String(key))) continue;

    try {
      Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)!);
    } catch { }
  }
};

const wrapFastifyFactory = (
  factory: any,
  options?: SenzorOptions
) => {
  if (typeof factory !== 'function' || factory[FACTORY_PATCHED]) {
    return factory;
  }

  const wrapped = function senzorFastifyFactory(this: unknown, ...args: any[]) {
    const instance = factory.apply(this, args);
    return patchFastifyInstance(instance, options);
  };

  copyFactoryProperties(factory, wrapped);

  Object.defineProperty(wrapped, FACTORY_PATCHED, {
    value: true,
    enumerable: false
  });

  const mutableWrapped = wrapped as any;

  if (mutableWrapped.fastify === factory) {
    mutableWrapped.fastify = mutableWrapped;
  }
  if (mutableWrapped.default === factory) {
    mutableWrapped.default = mutableWrapped;
  }

  return mutableWrapped;
};

export const instrumentFastify = (options?: SenzorOptions) => {
  hookRequire('fastify', (exports: any) => {
    if (typeof exports === 'function') {
      return wrapFastifyFactory(exports, options);
    }

    if (exports?.fastify) {
      exports.fastify = wrapFastifyFactory(exports.fastify, options);
    }
    if (exports?.default) {
      exports.default = wrapFastifyFactory(exports.default, options);
    }

    return exports;
  });
};

export const instrumentFastifyInstance = (
  instance: any,
  options?: SenzorOptions
) => patchFastifyInstance(instance, options);
