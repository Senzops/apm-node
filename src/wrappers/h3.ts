import { client } from '../core/client';
import { getRoute } from '../core/normalizer';

// Types for H3 (Mocked to avoid heavy peer dependencies)
type EventHandler = (event: any) => any;

export const wrapH3 = (handler: EventHandler) => {
  return async (event: any) => {
    const start = performance.now();
    let status = 200;
    let error: any = null;

    try {
      const response = await handler(event);
      // Try to determine status from response or event
      if (event.node?.res?.statusCode) {
        status = event.node.res.statusCode;
      }
      return response;
    } catch (err: any) {
      error = err;
      status = err.statusCode || err.status || 500;
      throw err;
    } finally {
      // Non-blocking collection
      const duration = performance.now() - start;
      const req = event.node.req;

      const path = req.originalUrl || req.url || '/';

      client.track({
        method: req.method || 'GET',
        route: getRoute(event, path), // H3 often attaches context to event
        path: path,
        status: status,
        duration: duration,
        ip: getIp(req),
        userAgent: req.headers['user-agent'],
      });

      // If serverless, we might need to await flush, but for general H3 usage (Node preset)
      // we assume the process stays alive or uses ctx.waitUntil
    }
  };
};

const getIp = (req: any) => {
  return req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
};