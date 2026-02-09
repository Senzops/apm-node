import http from 'http';
import https from 'https';
import { URL } from 'url';
import { Context } from '../core/context';

const shimmer = (module: any, methodName: string, wrapper: (original: Function) => Function) => {
  if (!module[methodName]) return;
  const original = module[methodName];
  module[methodName] = wrapper(original);
};

// --- Native Fetch Instrumentation (Node 18+) ---
export const instrumentFetch = (ingestUrl: string, debug = false) => {
  if (!globalThis.fetch) return;

  let ingestHost = '';
  try { ingestHost = new URL(ingestUrl).hostname; } catch (e) { }

  const originalFetch = globalThis.fetch;

  // @ts-ignore
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    // 1. Extract URL
    let urlStr = '';
    if (typeof input === 'string') urlStr = input;
    else if (input instanceof URL) urlStr = input.toString();
    else if (input && input.url) urlStr = input.url; // Request object

    // 2. Infinite Loop Guard
    if (ingestHost && urlStr.includes(ingestHost)) {
      return originalFetch(input, init);
    }

    // 3. Context Check
    const trace = Context.current();
    if (!trace) {
      return originalFetch(input, init);
    }

    // 4. Start Span
    const method = (init?.method || 'GET').toUpperCase();
    const startTime = performance.now() - trace.startTime;
    const spanStartAbs = performance.now();
    let hostname = 'unknown';
    try { hostname = new URL(urlStr).hostname; } catch (e) { }

    if (debug) console.log(`[Senzor] Tracking Fetch: ${method} ${hostname}`);

    try {
      const response = await originalFetch(input, init);

      // 5. End Span
      const duration = performance.now() - spanStartAbs;
      Context.addSpan({
        name: `${method} ${hostname}`,
        type: 'http',
        startTime,
        duration,
        status: response.status,
        meta: { url: urlStr, method, library: 'fetch' }
      });

      return response;
    } catch (err: any) {
      const duration = performance.now() - spanStartAbs;
      Context.addSpan({
        name: `${method} ${hostname}`,
        type: 'http',
        startTime,
        duration,
        status: 500,
        meta: { error: err.message, url: urlStr, library: 'fetch' }
      });
      throw err;
    }
  };
};

// --- Standard HTTP/HTTPS Instrumentation ---
export const instrumentHttp = (ingestUrl: string, debug = false) => {
  let ingestHost = '';
  try {
    ingestHost = new URL(ingestUrl).hostname;
  } catch (e) { }

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

      if (ingestHost && (urlStr.includes(ingestHost) || (options.hostname && options.hostname.includes(ingestHost)))) {
        return original.apply(this, args);
      }

      const trace = Context.current();
      if (!trace) return original.apply(this, args);

      const method = (options.method || 'GET').toUpperCase();
      const startTime = performance.now() - trace.startTime;
      const spanStartAbs = performance.now();
      let hostname = 'unknown';
      try { hostname = new URL(urlStr).hostname; } catch (e) { hostname = options.hostname || 'unknown'; }

      const req = original.apply(this, args);

      const captureSpan = (res: any, error?: Error) => {
        const duration = performance.now() - spanStartAbs;
        Context.addSpan({
          name: `${method} ${hostname}`,
          type: 'http',
          startTime,
          duration,
          status: error ? 500 : res?.statusCode || 0,
          meta: { url: urlStr, method, library: 'http' }
        });
      };

      req.on('response', (res: any) => {
        res.once('end', () => captureSpan(res));
        res.once('error', (err: Error) => captureSpan(res, err));
      });

      req.on('error', (err: Error) => captureSpan(null, err));

      return req;
    };
  };

  shimmer(http, 'request', requestWrapper);
  shimmer(http, 'get', requestWrapper);
  shimmer(https, 'request', requestWrapper);
  shimmer(https, 'get', requestWrapper);
};