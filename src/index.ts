import { client } from './core/client';
import { expressMiddleware } from './middleware/express';
import { wrapH3 } from './wrappers/h3';
import { wrapNextRoute, wrapNextPages } from './wrappers/next';
import { senzorPlugin } from './wrappers/fastify';
import { SenzorOptions } from './core/types';

const Senzor = {
  // Core
  init: (options: SenzorOptions) => client.init(options),
  flush: () => client.flush(),

  // Express / Connect
  requestHandler: expressMiddleware,

  // Next.js
  wrapNextRoute, // For App Router (Route Handlers)
  wrapNextPages, // For Pages Router (API Routes)

  // H3 / Nuxt / Nitro
  wrapH3,

  // Fastify
  fastifyPlugin: senzorPlugin
};

export default Senzor;
export { Senzor };