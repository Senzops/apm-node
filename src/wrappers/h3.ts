import { client } from '../core/client';
import { getRoute } from '../core/normalizer';

// Minimal types for H3 to avoid peer-deps
type EventHandler = (event: any) => any;

export const wrapH3 = (handler: EventHandler) => {
  return (event: any) => {
    const req = event.node.req;
    const path = req.originalUrl || req.url || '/';

    // Start Trace Context
    return client.startTrace({
      method: req.method || 'GET',
      path: path,
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'],
    }, async () => {
      try {
        const response = await handler(event);

        // H3/Nitro response status
        let status = 200;
        if (event.node.res.statusCode) status = event.node.res.statusCode;
        // Check if response is an error object
        if (response && response.statusCode) status = response.statusCode;

        client.endTrace(status, { route: getRoute(event, path) });
        return response;
      } catch (err: any) {
        const status = err.statusCode || err.status || 500;
        client.endTrace(status, { route: getRoute(event, path) });
        throw err;
      }
    });
  };
};