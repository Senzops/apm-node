import { normalizePath } from '../core/normalizer';
import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { invokeWithFrameworkSpan } from './framework';

const LAYER_PATCHED = Symbol.for('senzor.express.layer.patched');

const routeMethods = new Set([
  'checkout',
  'copy',
  'delete',
  'get',
  'head',
  'lock',
  'merge',
  'mkactivity',
  'mkcol',
  'move',
  'm-search',
  'notify',
  'options',
  'patch',
  'post',
  'purge',
  'put',
  'report',
  'search',
  'subscribe',
  'trace',
  'unlock',
  'unsubscribe'
]);

const stringifyPath = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (value instanceof RegExp) return value.toString();
  if (Array.isArray(value)) {
    return value.map(stringifyPath).filter(Boolean).join(',');
  }
  if (typeof value === 'number') return String(value);
  return undefined;
};

const getLayerPath = (args: any[]): string | undefined => {
  for (const arg of args) {
    if (typeof arg === 'function') return undefined;
    const path = stringifyPath(arg);
    if (path) return path;
  }

  return undefined;
};

const getRequestRoute = (
  req: any,
  layer: any,
  layerPath?: string
): string | undefined => {
  const routePath = stringifyPath(layer?.route?.path);
  if (routePath) {
    const baseUrl = req?.baseUrl || '';
    return `${baseUrl}${routePath}` || routePath;
  }

  if (req?.route?.path) {
    return `${req.baseUrl || ''}${req.route.path}`;
  }

  if (layerPath) {
    const baseUrl = req?.baseUrl || '';
    return `${baseUrl}${layerPath}` || layerPath;
  }

  const path = req?.originalUrl || req?.url || req?.path;
  return path ? normalizePath(String(path).split('?')[0]) : undefined;
};

const getLayerType = (
  layer: any,
  original: Function,
  forcedType?: 'middleware' | 'router' | 'request_handler' | 'error_handler'
) => {
  if (forcedType) return forcedType;
  if (original.length === 4) return 'error_handler' as const;
  if (layer?.route) return 'request_handler' as const;
  if (layer?.name === 'router' || layer?.handle?.stack || layer?.handle?.name === 'router') {
    return 'router' as const;
  }
  return 'middleware' as const;
};

const getRouteMethod = (layer: any, req: any): string | undefined => {
  if (layer?.route?.methods) {
    const method = Object.keys(layer.route.methods).find(
      (candidate) => layer.route.methods[candidate]
    );
    if (method) return method.toUpperCase();
  }

  return req?.method;
};

const copyEnumerableProperties = (
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

const patchLayer = (
  layer: any,
  layerPath: string | undefined,
  options?: SenzorOptions,
  forcedType?: 'middleware' | 'router' | 'request_handler' | 'error_handler'
) => {
  if (!layer || layer[LAYER_PATCHED] || typeof layer.handle !== 'function') {
    return;
  }

  Object.defineProperty(layer, LAYER_PATCHED, {
    value: true,
    enumerable: false
  });

  patchMethod(
    layer,
    'handle',
    'senzor.express.layer.handle',
    (original) => {
      const layerType = getLayerType(layer, original, forcedType);
      const handlerName =
        original.name ||
        layer.name ||
        layerType;

      if (original.length === 4) {
        const wrapped = function senzorExpressErrorHandler(
          this: unknown,
          err: any,
          req: any,
          res: any,
          next: Function
        ) {
          const route = getRequestRoute(req, layer, layerPath);
          return invokeWithFrameworkSpan(
            original,
            this,
            [err, req, res, next],
            {
              framework: 'express',
              type: 'error_handler',
              name: `express.error_handler ${route || handlerName}`,
              route,
              method: getRouteMethod(layer, req),
              layerPath,
              handlerName,
              request: req,
              response: res,
              attributes: {
                'express.type': 'error_handler',
                'express.layer.name': layer.name,
                error: err?.message,
                'error.type': err?.name || typeof err
              }
            },
            options,
            {
              callbackIndex: 3,
              callbackCompletesSpan: true,
              responseEndsSpan: true
            }
          );
        };

        copyEnumerableProperties(original, wrapped);
        return wrapped;
      }

      const wrapped = function senzorExpressLayer(
        this: unknown,
        req: any,
        res: any,
        next: Function
      ) {
        const route = getRequestRoute(req, layer, layerPath);
        const method = getRouteMethod(layer, req);
        const displayRoute = route || layerPath || handlerName;
        const name =
          layerType === 'request_handler'
            ? `express.request_handler ${method || ''} ${displayRoute}`.trim()
            : `express.${layerType} ${displayRoute}`;

        return invokeWithFrameworkSpan(
          original,
          this,
          [req, res, next],
          {
            framework: 'express',
            type: layerType,
            name,
            route,
            method,
            layerPath,
            handlerName,
            request: req,
            response: res,
            attributes: {
              'express.type': layerType,
              'express.layer.name': layer.name,
              'http.route': route
            }
          },
          options,
          {
            callbackIndex: 2,
            callbackCompletesSpan: true,
            responseEndsSpan: true
          }
        );
      };

      copyEnumerableProperties(original, wrapped);
      return wrapped;
    }
  );
};

const patchRouteMethodHandlers = (
  route: any,
  routePath: string | undefined,
  options?: SenzorOptions
) => {
  if (!route || route.__senzorRouteMethodsPatched) return;

  Object.defineProperty(route, '__senzorRouteMethodsPatched', {
    value: true,
    enumerable: false
  });

  for (const method of routeMethods) {
    if (typeof route[method] !== 'function') continue;

    patchMethod(
      route,
      method,
      `senzor.express.route.${method}`,
      (original) =>
        function patchedExpressRouteMethod(this: any, ...args: any[]) {
          const result = original.apply(this, args);
          const stack = this?.stack || [];

          for (const layer of stack) {
          patchLayer(layer, routePath, options, 'request_handler');
          }

          return result;
        }
    );
  }
};

const patchExpress = (
  expressModule: any,
  options?: SenzorOptions
) => {
  if (!expressModule) return;

  const routerProto =
    typeof expressModule?.Router?.prototype?.route === 'function'
      ? expressModule.Router.prototype
      : expressModule.Router;

  patchMethod(
    routerProto,
    'route',
    'senzor.express.router.route',
    (original) =>
      function patchedExpressRoute(this: any, ...args: any[]) {
        const route = original.apply(this, args);
        const routePath = getLayerPath(args);
        const layer = this?.stack?.[this.stack.length - 1];

        patchLayer(layer, routePath, options, 'router');
        patchRouteMethodHandlers(route, routePath, options);

        return route;
      }
  );

  patchMethod(
    routerProto,
    'use',
    'senzor.express.router.use',
    (original) =>
      function patchedExpressRouterUse(this: any, ...args: any[]) {
        const result = original.apply(this, args);
        const layer = this?.stack?.[this.stack.length - 1];
        patchLayer(layer, getLayerPath(args), options);
        return result;
      }
  );

  patchMethod(
    expressModule.application,
    'use',
    'senzor.express.application.use',
    (original) =>
      function patchedExpressApplicationUse(this: any, ...args: any[]) {
        const router = this?.router || this?._router;
        const result = original.apply(this, args);
        const activeRouter = this?.router || this?._router || router;
        const layer = activeRouter?.stack?.[activeRouter.stack.length - 1];
        patchLayer(layer, getLayerPath(args), options);
        return result;
      }
  );
};

export const instrumentExpress = (options?: SenzorOptions) => {
  hookRequire('express', (exports: any) => {
    patchExpress(exports, options);
    if (exports?.default) patchExpress(exports.default, options);
  });
};
