import http from 'http';
import https from 'https';
import { URL } from 'url';
import { Context } from '../core/context';

const shimmer = (module: any, methodName: string, wrapper: (original: Function) => Function) => {
  if (!module[methodName]) return;
  const original = module[methodName];
  module[methodName] = wrapper(original);
};

export const instrumentHttp = (ingestUrl: string, debug = false) => {
  let ingestHost = '';
  try {
    ingestHost = new URL(ingestUrl).hostname;
    if (debug) console.log(`[Senzor] HTTP Instrumentation ignoring host: ${ingestHost}`);
  } catch (e) {
    // If invalid URL passed, we can't filter loop safely, so we might skip instrumentation
    if (debug) console.error('[Senzor] Invalid Ingest URL for HTTP instrumentation');
  }

  const requestWrapper = (original: Function) => {
    return function (this: any, ...args: any[]) {
      let options: any = {};
      let urlStr = '';

      if (typeof args[0] === 'string' || args[0] instanceof URL) {
        urlStr = args[0].toString();
        if (typeof args[1] === 'object' && args[1] !== null) options = args[1];
      } else {
        options = args[0] || {};
        const protocol = options.protocol || (options.port === 443 ? 'https:' : 'http:');
        const host = options.hostname || options.host || 'localhost';
        const path = options.path || '/';
        urlStr = `${protocol}//${host}${path}`;
      }

      // Safety Guard: Ignore calls to Senzor Ingest API
      if (ingestHost && (urlStr.includes(ingestHost) || (options.hostname && options.hostname.includes(ingestHost)))) {
        return original.apply(this, args);
      }

      const trace = Context.current();
      if (!trace) {
        // Not inside a tracked request
        return original.apply(this, args);
      }

      const method = (options.method || 'GET').toUpperCase();
      const startTime = performance.now() - trace.startTime;
      const spanStartAbs = performance.now();
      let hostname = 'unknown';
      try { hostname = new URL(urlStr).hostname; } catch (e) { hostname = options.hostname || 'unknown'; }

      if (debug) console.log(`[Senzor] Tracking HTTP: ${method} ${hostname}`);

      const req = original.apply(this, args);

      const captureSpan = (res: any, error?: Error) => {
        const duration = performance.now() - spanStartAbs;
        Context.addSpan({
          name: `${method} ${hostname}`,
          type: 'http',
          startTime,
          duration,
          status: error ? 500 : res?.statusCode || 0,
          meta: { url: urlStr, method }
        });
      };

      req.on('response', (res: any) => {
        // We capture on 'response' (headers received) to be safe.
        // Waiting for 'end' might miss requests where body isn't consumed.
        res.once('end', () => captureSpan(res));
        // Fallback if 'end' doesn't fire fast enough
        // setTimeout(() => captureSpan(res), 5000); 
      });

      req.on('error', (err: Error) => {
        captureSpan(null, err);
      });

      return req;
    };
  };

  shimmer(http, 'request', requestWrapper);
  shimmer(http, 'get', requestWrapper);
  shimmer(https, 'request', requestWrapper);
  shimmer(https, 'get', requestWrapper);
};