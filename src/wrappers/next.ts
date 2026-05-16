import { client } from '../core/client';
import { normalizePath } from '../core/normalizer';
import { invokeWithFrameworkSpan } from '../instrumentation/framework';
import { getClientIp } from '../utils/getClientIp';

// --- App Router Wrapper ---
export const wrapNextRoute = (handler: Function) => {
  return async (req: Request | any, context?: any) => {

    // Extract info from Web Standard Request
    const url = req.url ? new URL(req.url) : { pathname: '/' };
    const method = req.method || 'GET';

    // Header Extraction
    let headers: Record<string, string> = {};
    let ua: string | undefined;
    let ip: string | undefined;

    if (typeof req.headers.get === 'function') {
      // It's a Web Request Object
      ua = req.headers.get('user-agent');
      ip = req.headers.get('x-forwarded-for');

      // Convert to plain object for trace context extraction
      req.headers.forEach((value: string, key: string) => {
        headers[key] = value;
      });
    } else {
      // It's a Node Request Object (rare in App router but possible)
      headers = req.headers;
      ua = headers['user-agent'];
      ip = headers['x-forwarded-for'] as string;
    }

    return client.startTrace({
      method,
      path: url.pathname,
      userAgent: ua,
      ip: ip || getClientIp(req),
      headers: headers // Pass extracted headers
    }, async () => {
      try {
        const route = normalizePath(url.pathname);
        const response = await invokeWithFrameworkSpan(
          handler,
          undefined,
          [req, context],
          {
            framework: 'next',
            type: 'route_handler',
            name: `next.app_route_handler ${method} ${route}`,
            route,
            method,
            request: req,
            attributes: {
              'next.router': 'app',
              'http.route': route,
              'url.path': url.pathname
            }
          },
          undefined,
          {
            callbackCompletesSpan: false,
            responseEndsSpan: false
          }
        );
        const status = response?.status || 200;

        client.endTrace(status, { route });
        return response;
      } catch (err: any) {
        client.captureError(err);
        client.endTrace(500, { route: normalizePath(url.pathname) });
        throw err;
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
      ip: getClientIp(req),
      headers: req.headers // Standard Node headers work fine
    }, async () => {

      const done = () => {
        client.endTrace(res.statusCode || 200, { route: normalizePath(path) });
      };

      res.once('finish', done);
      res.once('close', done);

      try {
        const route = normalizePath(path);
        return await invokeWithFrameworkSpan(
          handler,
          undefined,
          [req, res],
          {
            framework: 'next',
            type: 'route_handler',
            name: `next.pages_api_handler ${req.method || 'GET'} ${route}`,
            route,
            method: req.method || 'GET',
            request: req,
            response: res,
            attributes: {
              'next.router': 'pages',
              'http.route': route
            }
          },
          undefined,
          {
            callbackCompletesSpan: false,
            responseEndsSpan: true
          }
        );
      } catch (e: any) {
        client.captureError(e);
        throw e;
      }
    });
  };
};
