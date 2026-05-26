import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// Hapi Instrumentation
//
// Instruments @hapi/hapi at the route registration layer:
//   - Server.prototype.route() — wraps route handlers at registration time
//     so every request generates a span with:
//       hapi.route, hapi.method, http.route
//
// Captures the full handler execution including any route-level validation,
// payload parsing, and response formatting done by Hapi.
//
// The handler signature is always: (request, h) => response
// ---------------------------------------------------------------------------

/** HTTP method enum to string mapping for older Hapi versions. */
const METHOD_MAP: Record<number, string> = {
  0: 'GET', 1: 'HEAD', 2: 'POST', 3: 'PUT',
  4: 'DELETE', 5: 'OPTIONS', 6: 'PATCH',
};

const normalizeMethod = (method: any): string => {
  if (typeof method === 'string') return method.toUpperCase();
  if (typeof method === 'number') return METHOD_MAP[method] || 'UNKNOWN';
  return 'UNKNOWN';
};

// ---------------------------------------------------------------------------
// Handler wrapping
// ---------------------------------------------------------------------------

const wrapHandler = (
  handler: Function,
  routePath: string,
  routeMethod: string,
  options?: SenzorOptions
): Function => {
  if (typeof handler !== 'function') return handler;

  return function wrappedHapiHandler(this: any, request: any, h: any) {
    const method = normalizeMethod(routeMethod);
    const path = routePath || request?.route?.path || request?.path || '/';

    const span = startCapturedSpan(
      `Hapi ${method} ${path}`,
      'function',
      {
        'hapi.type': 'route_handler',
        'hapi.route': path,
        'hapi.method': method,
        'http.route': path,
        framework: 'hapi',
      },
      options
    );

    if (!span) return handler.call(this, request, h);

    return runWithCapturedSpan(span, () => {
      try {
        const result = handler.call(this, request, h);

        if (result && typeof result.then === 'function') {
          return result.then(
            (val: any) => {
              const statusCode = val?.statusCode || request?.response?.statusCode || 200;
              span.end(statusCode >= 400 ? statusCode : 0, {
                'http.response.status_code': statusCode,
              });
              return val;
            },
            (error: any) => {
              const statusCode = error?.output?.statusCode || 500;
              span.end(statusCode, {
                'error.message': error?.message,
                'error.type': error?.name || 'Error',
                'http.response.status_code': statusCode,
              });
              throw error;
            }
          );
        }

        span.end(0);
        return result;
      } catch (error: any) {
        const statusCode = error?.output?.statusCode || 500;
        span.end(statusCode, {
          'error.message': error?.message,
          'error.type': error?.name || 'Error',
          'http.response.status_code': statusCode,
        });
        throw error;
      }
    });
  };
};

// ---------------------------------------------------------------------------
// Route config processing
// ---------------------------------------------------------------------------

/**
 * Process a single route configuration object and wrap its handler.
 * Hapi route configs can have handler at config.handler or config.options.handler.
 */
const processRouteConfig = (config: any, options?: SenzorOptions): any => {
  if (!config) return config;

  const method = config.method || 'GET';
  const path = config.path || '/';

  // Clone config to avoid mutating user's original object
  const wrapped = { ...config };

  // Handler can be at config.handler or config.options.handler
  if (typeof wrapped.handler === 'function') {
    wrapped.handler = wrapHandler(wrapped.handler, path, method, options);
  } else if (wrapped.options && typeof wrapped.options.handler === 'function') {
    wrapped.options = { ...wrapped.options };
    wrapped.options.handler = wrapHandler(wrapped.options.handler, path, method, options);
  } else if (wrapped.config && typeof wrapped.config.handler === 'function') {
    // Legacy Hapi config location
    wrapped.config = { ...wrapped.config };
    wrapped.config.handler = wrapHandler(wrapped.config.handler, path, method, options);
  }

  return wrapped;
};

// ---------------------------------------------------------------------------
// Server.route() patching
// ---------------------------------------------------------------------------

const patchServerRoute = (serverProto: any, options?: SenzorOptions) => {
  if (!serverProto) return;

  patchMethod(
    serverProto,
    'route',
    'senzor.hapi.server.route',
    (original) =>
      function patchedRoute(this: any, routeConfig: any) {
        // server.route() accepts a single config or an array of configs
        if (Array.isArray(routeConfig)) {
          const wrappedConfigs = routeConfig.map((config: any) =>
            processRouteConfig(config, options)
          );
          return original.call(this, wrappedConfigs);
        }

        const wrappedConfig = processRouteConfig(routeConfig, options);
        return original.call(this, wrappedConfig);
      }
  );
};

// ---------------------------------------------------------------------------
// Extension point patching (for lifecycle span visibility)
// ---------------------------------------------------------------------------

const patchServerExt = (serverProto: any, options?: SenzorOptions) => {
  if (!serverProto) return;

  patchMethod(
    serverProto,
    'ext',
    'senzor.hapi.server.ext',
    (original) =>
      function patchedExt(this: any, event: any, method?: any, extOptions?: any) {
        // ext() can be called as:
        //   ext(event, method, options)  — single extension
        //   ext([{ type, method, options }])  — array of extensions
        //   ext({ type, method, options })  — single object

        if (typeof event === 'string' && typeof method === 'function') {
          const eventName = event;
          const originalMethod = method;

          const wrappedMethod = function (this: any, request: any, h: any) {
            const span = startCapturedSpan(
              `Hapi ext ${eventName}`,
              'function',
              {
                'hapi.type': 'lifecycle_hook',
                'hapi.hook': eventName,
                framework: 'hapi',
              },
              options
            );

            if (!span) return originalMethod.call(this, request, h);

            return runWithCapturedSpan(span, () => {
              try {
                const result = originalMethod.call(this, request, h);
                if (result && typeof result.then === 'function') {
                  return result.then(
                    (val: any) => { span.end(0); return val; },
                    (err: any) => {
                      span.end(500, { 'error.message': err?.message });
                      throw err;
                    }
                  );
                }
                span.end(0);
                return result;
              } catch (err: any) {
                span.end(500, { 'error.message': err?.message });
                throw err;
              }
            });
          };

          return original.call(this, event, wrappedMethod, extOptions);
        }

        // For array/object form, pass through unchanged (avoid complex nesting)
        return original.call(this, event, method, extOptions);
      }
  );
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentHapi = (options?: SenzorOptions) => {
  hookRequire('@hapi/hapi', (exports: any) => {
    // Hapi exports a Server class
    const Server = exports?.Server || exports?.server?.Server;

    if (Server?.prototype) {
      patchServerRoute(Server.prototype, options);

      // Only patch ext if framework spans are enabled
      if (options?.frameworkSpans !== false) {
        patchServerExt(Server.prototype, options);
      }
    }
  });

  // Also try the legacy 'hapi' package name (pre-scoped)
  hookRequire('hapi', (exports: any) => {
    const Server = exports?.Server || exports?.server?.Server;
    if (Server?.prototype) {
      patchServerRoute(Server.prototype, options);
      if (options?.frameworkSpans !== false) {
        patchServerExt(Server.prototype, options);
      }
    }
  });
};
