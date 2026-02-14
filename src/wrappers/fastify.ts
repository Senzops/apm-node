import { client } from '../core/client';
import { SenzorOptions } from '../core/types';

export const senzorPlugin = (fastify: any, options: SenzorOptions, done: Function) => {

  if (options && options.apiKey) {
    client.init(options);
  }

  // 1. Start Trace
  fastify.addHook('onRequest', (request: any, reply: any, next: Function) => {
    // FIX: Wrap next in a closure to satisfy TS types
    client.startTrace({
      method: request.method,
      path: request.raw.url || request.url,
      ip: request.ip,
      userAgent: request.headers['user-agent']
    }, () => next());
  });

  // 2. Capture Errors
  fastify.addHook('onError', (request: any, reply: any, error: any, next: Function) => {
    client.captureError(error);
    next();
  });

  // 3. End Trace
  fastify.addHook('onResponse', (request: any, reply: any, next: Function) => {
    const route = request.routeOptions?.url || request.routerPath || 'UNKNOWN';
    client.endTrace(reply.statusCode, { route });
    next();
  });

  done();
};