import { client } from '../core/client';
import { normalizePath } from '../core/normalizer';

// --- App Router Wrapper (GET, POST, etc.) ---
export const wrapNextRoute = (handler: Function) => {
  return async (req: Request | any, context?: any) => {
    const start = performance.now();
    let status = 200;

    try {
      const response = await handler(req, context);
      if (response && typeof response.status === 'number') {
        status = response.status;
      }
      return response;
    } catch (err: any) {
      status = 500;
      throw err;
    } finally {
      const duration = performance.now() - start;

      // App Router Request is a standard Web Request object
      const url = req.url ? new URL(req.url) : { pathname: '/' };

      // In App Router, we often rely on file-system path, but context.params helps
      // For now, robust heuristic normalization is best
      const route = normalizePath(url.pathname);

      client.track({
        method: req.method || 'GET',
        route: route,
        path: url.pathname,
        status: status,
        duration: duration,
        userAgent: req.headers.get ? req.headers.get('user-agent') : undefined,
        // IP extraction from Web Request is tricky without headers
        ip: req.headers.get ? req.headers.get('x-forwarded-for') : undefined,
      });

      // Vercel/Serverless Flush Safety
      // We purposefully do NOT await flush here to avoid latency.
      // Ideally user configures transport to sync flush or uses waitUntil
    }
  };
};

// --- Pages Router Wrapper (req, res) ---
export const wrapNextPages = (handler: Function) => {
  return async (req: any, res: any) => {
    const start = performance.now();

    // Hook into response finish
    const done = () => {
      const duration = performance.now() - start;
      const path = req.url || '/';

      client.track({
        method: req.method || 'GET',
        route: normalizePath(path.split('?')[0]),
        path: path,
        status: res.statusCode || 200,
        duration: duration,
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
        userAgent: req.headers['user-agent']
      });
    };

    res.once('finish', done);
    // Handle error case if next/error isn't used
    res.once('close', done);

    return handler(req, res);
  };
};