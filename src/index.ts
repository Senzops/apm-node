import { client } from './core/client';
import { expressMiddleware, expressErrorHandler } from './middleware/express';
import { wrapH3 } from './wrappers/h3';
import { wrapNextRoute, wrapNextPages } from './wrappers/next';
import { wrapWorker } from './wrappers/worker';
import { wrapLambda } from './wrappers/lambda';
import { nitroPlugin } from './wrappers/nitro';
import { senzorPlugin } from './wrappers/fastify';
import { SenzorOptions } from './core/types';

const Senzor = {
  preload: (options: Partial<SenzorOptions> = {}) => client.preload(options),
  init: (options: SenzorOptions) => client.init(options),
  flush: () => client.flush(),
  track: client.track.bind(client),
  startSpan: client.startSpan.bind(client),
  captureException: client.captureError.bind(client),

  // Task Monitoring
  wrapTask: client.wrapTask.bind(client),
  startTask: client.startTask.bind(client),

  // Express
  requestHandler: expressMiddleware,
  errorHandler: expressErrorHandler,

  // Next
  wrapNextRoute,
  wrapNextPages,

  // H3
  wrapH3,

  // Fastify
  fastifyPlugin: senzorPlugin,

  // Cloudflare Workers
  worker: wrapWorker,

  // AWS Lambda
  wrapLambda,

  // Nitro / Nuxt
  nitroPlugin
};

export default Senzor;
export { Senzor };
