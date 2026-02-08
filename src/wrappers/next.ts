import { client } from '../core/client';
import { normalizePath } from '../core/normalizer';

// --- App Router Wrapper (Route Handlers) ---
export const wrapNextRoute = (handler: Function) => {
  return async (req: Request | any, context?: any) => {
    // 1. Extract Info
    const url = req.url ? new URL(req.url) : { pathname: '/' };
    const method = req.method || 'GET';
    const ua = req.headers.get ? req.headers.get('user-agent') : undefined;
    const ip = req.headers.get ? req.headers.get('x-forwarded-for') : undefined;

    // 2. Run in Context
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
        client.endTrace(500, { route: normalizePath(url.pathname) });
        throw err;
      }
    });
  };
};

// --- Pages Router Wrapper (API Routes) ---
export const wrapNextPages = (handler: Function) => {
  return async (req: any, res: any) => {
    const path = req.url ? req.url.split('?')[0] : '/';
    
    // 1. Run in Context
    return client.startTrace({
      method: req.method || 'GET',
      path: path,
      userAgent: req.headers['user-agent'],
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
    }, async () => {
      
      // 2. Hook Response
      const done = () => {
        client.endTrace(res.statusCode || 200, { route: normalizePath(path) });
      };
      
      res.once('finish', done);
      res.once('close', done); // Fallback if finish doesn't fire

      // 3. Execute
      try {
        return await handler(req, res);
      } catch (e) {
        // Next.js Pages router usually handles errors internally, 
        // but we ensure we catch sync errors here
        throw e;
      }
    });
  };
};