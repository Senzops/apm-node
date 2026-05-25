import { client } from '../core/client';
import { normalizePath } from '../core/normalizer';
import { getClientIp } from '../utils/getClientIp';

type WorkerHandler = (request: Request, env: any, ctx: any) => Promise<Response>;

export const wrapWorker = (handler: WorkerHandler) => {
  return async (request: Request, env: any, ctx: any) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method || 'GET';

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return client.startTrace({
      method,
      path,
      route: normalizePath(path),
      ip: getClientIp({ headers }),
      userAgent: headers['user-agent'],
      headers
    }, async () => {
      let status = 500;
      try {
        const response = await handler(request, env, ctx);
        status = response.status;
        return response;
      } catch (err: any) {
        client.captureError(err);
        throw err;
      } finally {
        client.endTrace(status, { route: normalizePath(path) });

        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(client.flush());
        } else {
          await client.flush();
        }
      }
    });
  };
};
