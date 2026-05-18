import { client } from '../core/client';
import { SenzorOptions } from '../core/types';
import { instrumentFastifyInstance } from '../instrumentation/fastify';
import { getClientIp } from '../utils/getClientIp';

export const senzorPlugin = (fastify: any, options: SenzorOptions, done: Function) => {
  if (options && options.apiKey) {
    client.init(options);
  }

  instrumentFastifyInstance(fastify, options);

  fastify.addHook('onRequest', function senzorOnRequest(request: any, reply: any, next: Function) {
    client.startTrace({
      method: request.method,
      path: request.raw.url || request.url,
      ip: getClientIp(request),
      userAgent: request.headers['user-agent'],
      headers: request.headers // Pass headers
    }, () => next());
  });

  fastify.addHook('onError', function senzorOnError(request: any, reply: any, error: any, next: Function) {
    client.captureError(error);
    next();
  });

  fastify.addHook('onResponse', function senzorOnResponse(request: any, reply: any, next: Function) {
    const route = request.routeOptions?.url || request.routerPath || 'UNKNOWN';
    client.endTrace(reply.statusCode, { route });
    next();
  });

  done();
};
