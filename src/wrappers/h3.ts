import { client } from '../core/client';
import { getRoute } from '../core/normalizer';
import { invokeWithFrameworkSpan } from '../instrumentation/framework';
import { getClientIp } from '../utils/getClientIp';

type EventHandler = (event: any) => any;

export const wrapH3 = (handler: EventHandler) => {
  return (event: any) => {
    const req = event.node.req;
    const path = req.originalUrl || req.url || '/';

    return client.startTrace({
      method: req.method || 'GET',
      path: path,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      headers: req.headers // Pass headers
    }, async () => {
      try {
        const route = getRoute(event, path);
        const response = await invokeWithFrameworkSpan(
          handler,
          undefined,
          [event],
          {
            framework: 'h3',
            type: 'event_handler',
            name: `h3.event_handler ${req.method || 'GET'} ${route}`,
            route,
            method: req.method || 'GET',
            request: req,
            response: event.node.res,
            attributes: {
              'h3.type': 'event_handler',
              'http.route': route
            }
          },
          undefined,
          {
            callbackCompletesSpan: false,
            responseEndsSpan: false
          }
        );
        let status = 200;
        if (event.node.res.statusCode) status = event.node.res.statusCode;
        if (response && response.statusCode) status = response.statusCode;

        client.endTrace(status, { route });
        return response;
      } catch (err: any) {
        client.captureError(err);
        const status = err.statusCode || err.status || 500;
        client.endTrace(status, { route: getRoute(event, path) });
        throw err;
      }
    });
  };
};
