import { client } from '../core/client';
import { SenzorOptions } from '../core/types';

// We don't import Fastify types to keep zero-deps, but structure matches
export const senzorPlugin = (fastify: any, options: SenzorOptions, done: Function) => {

  // Init if options provided inline, otherwise assume global init
  if (options && options.apiKey) {
    client.init(options);
  }

  // Hook: On Request (Start Timer)
  fastify.addHook('onRequest', (request: any, reply: any, next: Function) => {
    request.senzorStart = performance.now();
    next();
  });

  // Hook: On Response (End Timer & Track)
  fastify.addHook('onResponse', (request: any, reply: any, next: Function) => {
    const duration = performance.now() - (request.senzorStart || performance.now());

    // Fastify provides 'routerPath' (e.g. /user/:id)
    const route = request.routeOptions?.url || request.routerPath;

    client.track({
      method: request.method,
      route: route || 'UNKNOWN',
      path: request.raw.url || request.url,
      status: reply.statusCode,
      duration: duration,
      ip: request.ip,
      userAgent: request.headers['user-agent']
    });

    next();
  });

  done();
};