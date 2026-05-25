import { client } from '../core/client';
import { getRoute, normalizePath } from '../core/normalizer';
import { getClientIp } from '../utils/getClientIp';

export interface NitroApp {
  h3App: {
    handler: (event: any) => Promise<any>;
    stack: any[];
  };
  hooks: any;
  [key: string]: any;
}

export const nitroPlugin = (nitroApp: NitroApp) => {
  if (!nitroApp.h3App || !nitroApp.h3App.handler) return;

  const originalHandler = nitroApp.h3App.handler;

  nitroApp.h3App.handler = async (event: any) => {
    const req = event.node?.req || event.req;
    const path = req?.originalUrl || req?.url || (event.path as string) || '/';
    const method = req?.method || (event.method as string) || 'GET';

    const headers = req?.headers || {};

    return client.startTrace({
      method,
      path,
      route: normalizePath(path),
      ip: getClientIp({ headers, socket: req?.socket }),
      userAgent: headers['user-agent'],
      headers
    }, async () => {
      let status = 200;
      try {
        const response = await originalHandler(event);

        if (event.node?.res?.statusCode) status = event.node.res.statusCode;
        if (response?.status) status = response.status;

        client.endTrace(status, { route: getRoute(event, path) });
        return response;
      } catch (err: any) {
        status = err.statusCode || err.status || 500;
        client.captureError(err);
        client.endTrace(status, { route: getRoute(event, path) });
        throw err;
      } finally {
        const cfCtx = event.context?.cloudflare?.context || event.context?.cf || event.context;
        const waitUntil = cfCtx?.waitUntil || event.waitUntil;

        if (waitUntil && typeof waitUntil === 'function') {
          waitUntil(client.flush());
        } else {
          client.flush().catch(() => {});
        }
      }
    });
  };
};
