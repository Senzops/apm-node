import { client } from '../core/client';

export const expressMiddleware = () => {
  return (req: any, res: any, next: () => void) => {
    // We MUST use startTrace to enable Auto-Instrumentation for this request
    client.startTrace({
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'],
    }, () => {

      res.once('finish', () => {
        try {
          let route = 'UNKNOWN';
          if (req.route && req.route.path) {
            route = (req.baseUrl || '') + req.route.path;
          } else if (res.statusCode === 404) {
            route = 'Not Found';
          } else {
            route = req.path || 'Wildcard';
          }

          client.endTrace(res.statusCode, { route });
        } catch (e) {
          // Fail open
        }
      });

      next();
    });
  };
};