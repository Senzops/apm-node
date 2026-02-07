import { client } from '../core/client';

export const expressMiddleware = () => {
  return (req: any, res: any, next: () => void) => {
    // Start Timer (High Precision)
    const start = performance.now();

    // Hook into response finish
    res.once('finish', () => {
      try {
        const duration = performance.now() - start;

        // Route Normalization Logic
        // Express stores route info in req.route
        let route = 'UNKNOWN';

        if (req.route && req.route.path) {
          // Combined baseUrl (if mounted on /api) + path (/:id)
          route = (req.baseUrl || '') + req.route.path;
        } else if (res.statusCode === 404) {
          route = 'Not Found';
        } else {
          // Fallback for unmapped routes or static files
          route = req.path || 'Wildcard';
        }

        client.track({
          method: req.method,
          route: route,
          path: req.originalUrl || req.url,
          status: res.statusCode,
          duration: duration,
          ip: req.ip || req.socket?.remoteAddress,
          userAgent: req.headers['user-agent'],
        });
      } catch (e) {
        // Fail open
      }
    });

    next();
  };
};