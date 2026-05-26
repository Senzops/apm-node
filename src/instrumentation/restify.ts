import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// Restify Instrumentation
//
// Instruments the `restify` HTTP framework at the server layer:
//   - Server route registration methods (get, post, put, del, patch, head, opts)
//     to wrap route handlers and generate spans per request.
//   - Server.prototype.use() to optionally capture middleware spans.
//
// Restify handler signature: (req, res, next) — same as Express/Connect.
// Route path is available at registration time via the route config.
//
// Captured attributes:
//   - http.route: registered route path
//   - http.method: HTTP method
//   - restify.type: 'route_handler' | 'middleware'
//   - restify.version: route version (if versioned routes)
//   - framework: 'restify'
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'post', 'put', 'del', 'patch', 'head', 'opts'] as const;

/** Normalize restify method name to HTTP method. */
const METHOD_MAP: Record<string, string> = {
  get: 'GET', post: 'POST', put: 'PUT', del: 'DELETE',
  patch: 'PATCH', head: 'HEAD', opts: 'OPTIONS',
};

// ---------------------------------------------------------------------------
// Handler wrapping
// ---------------------------------------------------------------------------

const wrapHandler = (
  handler: Function,
  method: string,
  path: string,
  type: 'route_handler' | 'middleware',
  options?: SenzorOptions
): Function => {
  if (typeof handler !== 'function') return handler;
  if ((handler as any).__senzorWrapped) return handler;

  const wrapped = function wrappedRestifyHandler(this: any, req: any, res: any, next: any) {
    const httpMethod = METHOD_MAP[method] || method.toUpperCase();
    const routePath = path || req?.route?.path || req?.getPath?.() || req?.url?.split('?')[0] || '/';

    const spanName = type === 'middleware'
      ? `Restify middleware ${handler.name || 'anonymous'}`
      : `Restify ${httpMethod} ${routePath}`;

    const span = startCapturedSpan(
      spanName,
      'function',
      {
        'restify.type': type,
        'http.route': routePath,
        'http.method': httpMethod,
        framework: 'restify',
      },
      options
    );

    if (!span) return handler.call(this, req, res, next);

    return runWithCapturedSpan(span, () => {
      // Wrap next() to end span when handler passes control
      const wrappedNext = function (...args: any[]) {
        const hasError = args.length > 0 && args[0] instanceof Error;
        if (hasError) {
          const err = args[0];
          span.end(err?.statusCode || 500, {
            'error.message': err.message,
            'error.type': err.name || 'Error',
          });
        } else {
          span.end(0);
        }
        return next?.(...args);
      };

      try {
        const result = handler.call(this, req, res, wrappedNext);

        // Handle async handlers returning promises
        if (result && typeof result.then === 'function') {
          return result.then(
            (val: any) => val,
            (error: any) => {
              span.end(error?.statusCode || 500, {
                'error.message': error?.message,
                'error.type': error?.name || 'Error',
              });
              throw error;
            }
          );
        }

        return result;
      } catch (error: any) {
        span.end(error?.statusCode || 500, {
          'error.message': error?.message,
          'error.type': error?.name || 'Error',
        });
        throw error;
      }
    });
  };

  (wrapped as any).__senzorWrapped = true;
  return wrapped;
};

// ---------------------------------------------------------------------------
// Server route method patching
// ---------------------------------------------------------------------------

const patchRestifyServer = (restify: any, options?: SenzorOptions) => {
  // restify.createServer() returns a Server instance
  // We need to patch Server.prototype

  let ServerProto: any;

  // Try to get Server prototype from a temp server
  try {
    const tempServer = restify.createServer({ name: '__senzor_probe' });
    ServerProto = Object.getPrototypeOf(tempServer);
    // Close the temp server immediately
    try { tempServer.close(); } catch { }
  } catch { }

  // Fallback: try restify.Server
  if (!ServerProto) {
    ServerProto = restify?.Server?.prototype;
  }

  if (!ServerProto) return;

  // Patch route registration methods
  for (const method of HTTP_METHODS) {
    if (typeof ServerProto[method] !== 'function') continue;

    patchMethod(
      ServerProto,
      method,
      `senzor.restify.server.${method}`,
      (original) =>
        function patchedRouteMethod(this: any, ...args: any[]) {
          // Restify route methods accept:
          //   server.get(path, handler1, handler2, ...)
          //   server.get({ path, version }, handler1, handler2, ...)
          //   server.get(path, [handler1, handler2])

          let path = '/';

          // Extract path from first argument
          if (typeof args[0] === 'string') {
            path = args[0];
          } else if (args[0] && typeof args[0] === 'object') {
            path = args[0].path || args[0].url || '/';
          }

          // Wrap all handler arguments
          for (let i = 0; i < args.length; i++) {
            if (typeof args[i] === 'function') {
              args[i] = wrapHandler(args[i], method, path, 'route_handler', options);
            } else if (Array.isArray(args[i])) {
              args[i] = args[i].map((h: any) =>
                typeof h === 'function' ? wrapHandler(h, method, path, 'route_handler', options) : h
              );
            }
          }

          return original.apply(this, args);
        }
    );
  }

  // Patch use() for middleware spans (optional)
  if (options?.captureMiddlewareSpans !== false && typeof ServerProto.use === 'function') {
    patchMethod(
      ServerProto,
      'use',
      'senzor.restify.server.use',
      (original) =>
        function patchedUse(this: any, ...args: any[]) {
          for (let i = 0; i < args.length; i++) {
            if (typeof args[i] === 'function') {
              args[i] = wrapHandler(args[i], 'use', '*', 'middleware', options);
            } else if (Array.isArray(args[i])) {
              args[i] = args[i].map((h: any) =>
                typeof h === 'function' ? wrapHandler(h, 'use', '*', 'middleware', options) : h
              );
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

export const instrumentRestify = (options?: SenzorOptions) => {
  hookRequire('restify', (exports: any) => {
    patchRestifyServer(exports, options);
  });
};
