import http from 'http';
import https from 'https';
import { URL } from 'url';
import { Context } from '../core/context';

const shimmer = (module: any, methodName: string, wrapper: (original: Function) => Function) => {
  if (!module[methodName]) return;
  const original = module[methodName];
  module[methodName] = wrapper(original);
};

export const instrumentHttp = (ingestUrl: string) => {
  let ingestHost = '';
  try {
    ingestHost = new URL(ingestUrl).hostname;
  } catch (e) {
    // Fallback if invalid URL provided, though init checks this
    ingestHost = 'api.senzor.dev';
  }

  const requestWrapper = (original: Function) => {
    return function (this: any, ...args: any[]) {
      // 1. Robust Argument Parsing
      // http.request(url, [options], [callback])
      // http.request(options, [callback])
      let options: any = {};
      let urlStr = '';

      // Check if first arg is URL-like
      if (typeof args[0] === 'string' || args[0] instanceof URL) {
        urlStr = args[0].toString();
        // If second arg is object, it's options. If function, it's callback.
        if (typeof args[1] === 'object' && args[1] !== null) {
          options = args[1];
        }
      } else {
        options = args[0] || {};
        const protocol = options.protocol || (options.port === 443 ? 'https:' : 'http:');
        const host = options.hostname || options.host || 'localhost';
        const path = options.path || '/';
        urlStr = `${protocol}//${host}${path}`;
      }

      // 2. Prevent Infinite Loops (Ignore calls to Senzor)
      if (urlStr.includes(ingestHost) || (options.hostname && options.hostname.includes(ingestHost))) {
        return original.apply(this, args);
      }

      // 3. Check Context
      const trace = Context.current();
      if (!trace) {
        // Debug mode would help here, but we can't access config easily.
        // If no trace context, we simply execute original.
        return original.apply(this, args);
      }

      // 4. Start Span
      const method = (options.method || 'GET').toUpperCase();
      const startTime = performance.now() - trace.startTime;
      const spanStartAbs = performance.now();
      const hostname = new URL(urlStr).hostname;

      // 5. Execute Original
      const req = original.apply(this, args);

      // 6. Capture Response
      req.on('response', (res: any) => {
        // We use 'once' to ensure we only record it once
        const onFinish = () => {
          const duration = performance.now() - spanStartAbs;

          Context.addSpan({
            name: `${method} ${hostname}`,
            type: 'http',
            startTime,
            duration,
            status: res.statusCode,
            meta: {
              url: urlStr,
              method: method,
            }
          });
        };

        // 'end' fires when data is consumed
        res.once('end', onFinish);
        // 'close' fires if connection closed early
        res.once('close', onFinish);
        // 'error' on response stream
        res.once('error', onFinish);
      });

      req.on('error', (err: Error) => {
        const duration = performance.now() - spanStartAbs;
        Context.addSpan({
          name: `${method} ${hostname}`,
          type: 'http',
          startTime,
          duration,
          status: 500,
          meta: { error: err.message, url: urlStr }
        });
      });

      return req;
    };
  };

  // Patch HTTP and HTTPS
  shimmer(http, 'request', requestWrapper);
  shimmer(http, 'get', requestWrapper);
  shimmer(https, 'request', requestWrapper);
  shimmer(https, 'get', requestWrapper);
};