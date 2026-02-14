import { client } from '../core/client';
import { normalizePath } from '../core/normalizer';

// --- App Router Wrapper ---
export const wrapNextRoute = (handler: Function) => {
  return async (req: Request | any, context?: any) => {
    const url = req.url ? new URL(req.url) : { pathname: '/' };
    const method = req.method || 'GET';
    const ua = req.headers.get ? req.headers.get('user-agent') : undefined;
    const ip = req.headers.get ? req.headers.get('x-forwarded-for') : undefined;

    return client.startTrace({
      method,
      path: url.pathname,
      userAgent: ua,
      ip: ip
    }, async () => {
      try {
        const response = await handler(req, context);
        const status = response?.status || 200;
        client.endTrace(status, { route: normalizePath(url.pathname) });
        return response;
      } catch (err: any) {
        // AUTOMATIC ERROR CAPTURE
        client.captureError(err);
        client.endTrace(500, { route: normalizePath(url.pathname) });
        throw err; // Re-throw so Next.js handles the error page
      }
    });
  };
};

// --- Pages Router Wrapper ---
export const wrapNextPages = (handler: Function) => {
  return async (req: any, res: any) => {
    const path = req.url ? req.url.split('?')[0] : '/';

    return client.startTrace({
      method: req.method || 'GET',
      path: path,
      userAgent: req.headers['user-agent'],
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
    }, async () => {

      const done = () => {
        client.endTrace(res.statusCode || 200, { route: normalizePath(path) });
      };

      res.once('finish', done);
      res.once('close', done);

      try {
        return await handler(req, res);
      } catch (e: any) {
        // AUTOMATIC ERROR CAPTURE
        client.captureError(e);
        // Note: In Pages dir, we rely on 'finish' listener above to close trace, 
        // but capturing here ensures the error data is attached.
        throw e;
      }
    });
  };
};