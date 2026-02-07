import { client, SenzorOptions } from './core/client';
import { expressMiddleware } from './middleware/express';

// Main Facade
const Senzor = {
  init: (options: SenzorOptions) => client.init(options),
  flush: () => client.flush(),
  track: client.track.bind(client),

  // Middleware Adapters
  requestHandler: expressMiddleware,
  // Add other adapters here later (e.g. h3Handler, fastifyPlugin)
};

export default Senzor;
export { Senzor };