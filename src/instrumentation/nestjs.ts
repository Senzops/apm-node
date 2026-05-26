import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// NestJS Instrumentation
//
// Instruments @nestjs/core at the router execution layer:
//   - RouterExecutionContext.prototype.create() — wraps the handler factory
//     so every controller method invocation generates a span with:
//       nestjs.controller, nestjs.method, nestjs.route, http.route
//
// This captures the full NestJS request lifecycle including guards,
// interceptors, pipes, and the controller method execution.
//
// Works with both Express and Fastify adapters since we patch at the
// NestJS layer above the HTTP adapter.
// ---------------------------------------------------------------------------

/** Extract a human-readable name from a NestJS controller class. */
const getControllerName = (instance: any): string => {
  if (!instance) return 'UnknownController';
  return instance.constructor?.name || 'UnknownController';
};

// ---------------------------------------------------------------------------
// RouterExecutionContext patching
// ---------------------------------------------------------------------------

const patchRouterExecutionContext = (nestCore: any, options?: SenzorOptions) => {
  // Try to access RouterExecutionContext from the module
  let RouterExecutionContext: any;

  try {
    RouterExecutionContext = require('@nestjs/core/router/router-execution-context')?.RouterExecutionContext;
  } catch { }

  // Fallback: search in exports
  if (!RouterExecutionContext) {
    RouterExecutionContext = nestCore?.RouterExecutionContext;
  }

  if (!RouterExecutionContext?.prototype?.create) return;

  patchMethod(
    RouterExecutionContext.prototype,
    'create',
    'senzor.nestjs.routerExecutionContext.create',
    (original) =>
      function patchedCreate(
        this: any,
        instance: any,
        callback: Function,
        methodName: string,
        moduleKey: string,
        requestMethod: number,
        ...rest: any[]
      ) {
        const handler = original.call(this, instance, callback, methodName, moduleKey, requestMethod, ...rest);

        if (typeof handler !== 'function') return handler;

        const controllerName = getControllerName(instance);

        return function wrappedNestHandler(this: any, req: any, res: any, next: any) {
          // Extract route from request
          const route = req?.route?.path || req?.url?.split('?')[0] || '/';

          const span = startCapturedSpan(
            `NestJS ${controllerName}.${methodName}`,
            'function',
            {
              'nestjs.controller': controllerName,
              'nestjs.method': methodName,
              'nestjs.module': moduleKey,
              'nestjs.type': 'request_handler',
              'http.route': route,
            },
            options
          );

          if (!span) return handler.call(this, req, res, next);

          return runWithCapturedSpan(span, () => {
            try {
              const result = handler.call(this, req, res, next);

              if (result && typeof result.then === 'function') {
                return result.then(
                  (val: any) => {
                    span.end(0);
                    return val;
                  },
                  (error: any) => {
                    span.end(500, {
                      'error.message': error?.message,
                      'error.type': error?.name || 'Error',
                    });
                    throw error;
                  }
                );
              }

              span.end(0);
              return result;
            } catch (error: any) {
              span.end(500, {
                'error.message': error?.message,
                'error.type': error?.name || 'Error',
              });
              throw error;
            }
          });
        };
      }
  );
};

// ---------------------------------------------------------------------------
// RouterExplorer patching (alternative / complementary)
// ---------------------------------------------------------------------------

const patchRouterExplorer = (nestCore: any, options?: SenzorOptions) => {
  let RouterExplorer: any;

  try {
    RouterExplorer = require('@nestjs/core/router/router-explorer')?.RouterExplorer;
  } catch { }

  if (!RouterExplorer) {
    RouterExplorer = nestCore?.RouterExplorer;
  }

  if (!RouterExplorer?.prototype?.applyCallbackToRouter) return;

  patchMethod(
    RouterExplorer.prototype,
    'applyCallbackToRouter',
    'senzor.nestjs.routerExplorer.applyCallbackToRouter',
    (original) =>
      function patchedApplyCallback(
        this: any,
        router: any,
        routeDefinition: any,
        instanceWrapper: any,
        moduleKey: string,
        ...rest: any[]
      ) {
        // Extract metadata before registration
        const methodName = routeDefinition?.methodName || 'unknown';
        const path = routeDefinition?.path || '/';
        const requestMethod = routeDefinition?.requestMethod;

        const controllerName = instanceWrapper?.metatype?.name
          || instanceWrapper?.name
          || 'UnknownController';

        // Let NestJS register the route normally
        const result = original.call(this, router, routeDefinition, instanceWrapper, moduleKey, ...rest);

        // Log registration for debug
        if (options?.debug) {
          console.log(`[Senzor] NestJS route registered: ${controllerName}.${methodName} → ${path}`);
        }

        return result;
      }
  );
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentNestJS = (options?: SenzorOptions) => {
  hookRequire('@nestjs/core', (exports: any) => {
    patchRouterExecutionContext(exports, options);
    patchRouterExplorer(exports, options);
  });

  // Also try the specific sub-module paths (varies by NestJS version)
  hookRequire('@nestjs/core/router/router-execution-context', (exports: any) => {
    if (exports?.RouterExecutionContext?.prototype?.create) {
      patchMethod(
        exports.RouterExecutionContext.prototype,
        'create',
        'senzor.nestjs.rec.create.direct',
        (original) =>
          function patchedCreateDirect(
            this: any,
            instance: any,
            callback: Function,
            methodName: string,
            moduleKey: string,
            requestMethod: number,
            ...rest: any[]
          ) {
            const handler = original.call(this, instance, callback, methodName, moduleKey, requestMethod, ...rest);
            if (typeof handler !== 'function') return handler;

            const controllerName = getControllerName(instance);

            return function wrappedHandler(this: any, req: any, res: any, next: any) {
              const route = req?.route?.path || req?.url?.split('?')[0] || '/';

              const span = startCapturedSpan(
                `NestJS ${controllerName}.${methodName}`,
                'function',
                {
                  'nestjs.controller': controllerName,
                  'nestjs.method': methodName,
                  'nestjs.module': moduleKey,
                  'nestjs.type': 'request_handler',
                  'http.route': route,
                },
                options
              );

              if (!span) return handler.call(this, req, res, next);

              return runWithCapturedSpan(span, () => {
                try {
                  const result = handler.call(this, req, res, next);
                  if (result && typeof result.then === 'function') {
                    return result.then(
                      (val: any) => { span.end(0); return val; },
                      (err: any) => { span.end(500, { 'error.message': err?.message }); throw err; }
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
          }
      );
    }
  });
};
