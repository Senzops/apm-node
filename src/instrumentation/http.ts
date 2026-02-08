import http from 'http';
import https from 'https';
import { URL } from 'url';
import { Context } from '../core/context';

// Helper to safely wrap modules
const shimmer = (module: any, methodName: string, wrapper: (original: Function) => Function) => {
  if (!module[methodName]) return;
  const original = module[methodName];
  module[methodName] = wrapper(original);
};

export const instrumentHttp = (ingestUrl: string) => {
  const ingestHost = new URL(ingestUrl).hostname;

  const requestWrapper = (original: Function) => {
    return function (this: any, ...args: any[]) {
      // 1. Parse Arguments to get URL
      let options: any = {};
      let urlStr = '';

      if (typeof args[0] === 'string' || args[0] instanceof URL) {
        urlStr = args[0].toString();
        options = args[1] || {};
      } else {
        options = args[0] || {};
        const protocol = options.protocol || 'http:';
        const host = options.hostname || options.host || 'localhost';
        const path = options.path || '/';
        urlStr = `${protocol}//${host}${path}`;
      }

      // 2. SAFETY GUARD: Ignore calls to Senzor Ingest API (Prevent Infinite Loop)
      if (urlStr.includes(ingestHost) || (options.hostname && options.hostname.includes(ingestHost))) {
        return original.apply(this, args);
      }

      // 3. Check if we are inside an Active Trace
      // If we are not handling a user request, don't trace background http calls
      const trace = Context.current();
      if (!trace) {
        return original.apply(this, args);
      }

      // 4. Start Span
      const method = (options.method || 'GET').toUpperCase();
      const startTime = performance.now() - trace.startTime; // Relative to trace start
      const spanStartAbs = performance.now();

      // 5. Execute Request
      const req = original.apply(this, args);

      // 6. Hook into Response/Error
      req.on('response', (res: any) => {
        // Wait for end of stream to calculate full duration (TTFB + Download)
        res.on('end', () => {
          const duration = performance.now() - spanStartAbs;
          
          Context.addSpan({
            name: `${method} ${new URL(urlStr).hostname}`, // e.g. "GET api.stripe.com"
            type: 'http',
            startTime,
            duration,
            status: res.statusCode,
            meta: {
              url: urlStr,
              method: method,
            }
          });
        });
      });

      req.on('error', (err: Error) => {
        const duration = performance.now() - spanStartAbs;
        Context.addSpan({
          name: `${method} ${urlStr}`,
          type: 'http',
          startTime,
          duration,
          status: 500, // Client Error
          meta: { error: err.message }
        });
      });

      return req;
    };
  };

  // Apply patches
  shimmer(http, 'request', requestWrapper);
  shimmer(http, 'get', requestWrapper);
  shimmer(https, 'request', requestWrapper);
  shimmer(https, 'get', requestWrapper);
};