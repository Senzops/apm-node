import { client } from '../core/client';

// 1. Request Handler (Place before routes)
export const expressMiddleware = () => {
  return (req: any, res: any, next: () => void) => {
    client.startTrace({
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'],
      headers: req.headers
    }, () => {

      // Auto-detect status code on finish
      res.once('finish', () => {
        try {
          let route = 'UNKNOWN';
          // Express populates req.route only if a route matched
          if (req.route && req.route.path) {
            route = (req.baseUrl || '') + req.route.path;
          } else if (res.statusCode === 404) {
            route = 'Not Found';
          } else {
            route = req.path || 'Wildcard';
          }

          client.endTrace(res.statusCode, { route });
        } catch (e) { /* Fail open */ }
      });

      next();
    });
  };
};

// 2. Error Handler (Place after routes)
// This is required in Express to capture the actual Error Object (Stack Trace)
export const expressErrorHandler = () => {
  return (err: any, req: any, res: any, next: (err?: any) => void) => {

    // 1. Capture the exception context
    client.captureError(err);

    // 2. Pass it to the next error handler (don't swallow it)
    next(err);
  };
};