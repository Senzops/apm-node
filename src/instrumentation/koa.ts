import { normalizePath } from '../core/normalizer';
import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { wrapFrameworkHandlerWithArity } from './framework';

const routerMethods = [
  'all',
  'del',
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put'
];

const stringifyPath = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (value instanceof RegExp) return value.toString();
  if (Array.isArray(value)) {
    return value.map(stringifyPath).filter(Boolean).join(',');
  }
  return undefined;
};

const getPathFromArgs = (args: any[]): string | undefined => {
  for (const arg of args) {
    if (typeof arg === 'function') return undefined;
    const path = stringifyPath(arg);
    if (path) return path;
  }

  return undefined;
};

const wrapKoaMiddleware = (
  middleware: any,
  options?: SenzorOptions,
  layerPath?: string,
  layerType: 'middleware' | 'router' | 'route_handler' = 'middleware',
  method?: string
) => {
  if (typeof middleware !== 'function') return middleware;

  return wrapFrameworkHandlerWithArity(
    middleware,
    (_thisArg, args) => {
      const ctx = args[0];
      const route =
        ctx?._matchedRoute ||
        ctx?.matched?.[0]?.path ||
        layerPath ||
        normalizePath(ctx?.path || ctx?.request?.path || '/');
      const actualMethod = method || ctx?.method || ctx?.request?.method;
      const handlerName = middleware.name || layerType;

      return {
        framework: 'koa',
        type: layerType,
        name:
          layerType === 'route_handler'
            ? `koa.request_handler ${actualMethod || ''} ${route}`.trim()
            : `koa.${layerType} ${route || handlerName}`,
        route,
        method: actualMethod,
        layerPath,
        handlerName,
        request: ctx?.req || ctx?.request,
        response: ctx?.res || ctx?.response,
        attributes: {
          'koa.type': layerType,
          'http.route': route,
          path: ctx?.path || ctx?.request?.path
        }
      };
    },
    options,
    {
      callbackCompletesSpan: false,
      responseEndsSpan: false
    }
  );
};

const patchKoaApplication = (
  koa: any,
  options?: SenzorOptions
) => {
  const proto = koa?.prototype || koa?.default?.prototype;
  if (!proto) return;

  patchMethod(
    proto,
    'use',
    'senzor.koa.application.use',
    (original) =>
      function patchedKoaUse(this: any, middleware: any) {
        return original.call(
          this,
          wrapKoaMiddleware(middleware, options, undefined, 'middleware')
        );
      }
  );
};

const patchKoaRouter = (
  routerModule: any,
  options?: SenzorOptions
) => {
  const Router =
    routerModule?.Router ||
    routerModule?.default ||
    routerModule;
  const proto = Router?.prototype;
  if (!proto) return;

  patchMethod(
    proto,
    'use',
    'senzor.koa.router.use',
    (original) =>
      function patchedKoaRouterUse(this: any, ...args: any[]) {
        const layerPath = getPathFromArgs(args);
        const nextArgs = args.map((arg) =>
          typeof arg === 'function'
            ? wrapKoaMiddleware(arg, options, layerPath, 'router')
            : arg
        );
        return original.apply(this, nextArgs);
      }
  );

  for (const method of routerMethods) {
    patchMethod(
      proto,
      method,
      `senzor.koa.router.${method}`,
      (original) =>
        function patchedKoaRouterMethod(this: any, ...args: any[]) {
          const layerPath = getPathFromArgs(args);
          const nextArgs = args.map((arg) =>
            typeof arg === 'function'
              ? wrapKoaMiddleware(
                arg,
                options,
                layerPath,
                'route_handler',
                method.toUpperCase()
              )
              : arg
          );

          return original.apply(this, nextArgs);
        }
    );
  }
};

export const instrumentKoa = (options?: SenzorOptions) => {
  hookRequire('koa', (exports: any) => {
    patchKoaApplication(exports, options);
  });

  hookRequire('@koa/router', (exports: any) => {
    patchKoaRouter(exports, options);
  });

  hookRequire('koa-router', (exports: any) => {
    patchKoaRouter(exports, options);
  });
};
