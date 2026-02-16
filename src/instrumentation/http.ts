import http from 'http';
import https from 'https';
import { URL } from 'url';
import { Context } from '../core/context';
import { randomUUID } from 'crypto';

const shimmer = (module: any, methodName: string, wrapper: (original: Function) => Function) => {
  if (!module[methodName]) return;
  const original = module[methodName];
  module[methodName] = wrapper(original);
};

// --- FETCH INSTRUMENTATION (Node 18+ / Edge) ---
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
    else if (input && (input as any).url) urlStr = (input as any).url;

    // 2. Infinite Loop Guard
    if (ingestHost && urlStr.includes(ingestHost)) {
      return originalFetch(input, init);
    }

    // 3. Context Check
    const trace = Context.current();
    if (!trace) {
      return originalFetch(input, init);
    }

    // 4. Prepare Metadata & ID
    const method = (init?.method || 'GET').toUpperCase();
    const startTime = performance.now() - trace.startTime;
    const spanStartAbs = performance.now();
    const spanId = randomUUID(); // New ID for this specific outbound call

    let hostname = 'unknown';
    try { hostname = new URL(urlStr).hostname; } catch (e) { }

    if (debug) console.log(`[Senzor] Fetch: ${method} ${hostname}`);

    // 5. Inject Distributed Tracing Headers
    // We need to clone init or create it to avoid mutating original ref unexpectedly
    const newInit = { ...init };
    if (!newInit.headers) {
      newInit.headers = {};
    }

    // Handle different Header formats (Headers object vs plain object)
    if (newInit.headers instanceof Headers) {
      newInit.headers.set('x-senzor-trace-id', trace.id);
      newInit.headers.set('x-senzor-parent-span-id', spanId);
    } else if (Array.isArray(newInit.headers)) {
      newInit.headers.push(['x-senzor-trace-id', trace.id]);
      newInit.headers.push(['x-senzor-parent-span-id', spanId]);
    } else {
      // Plain object
      (newInit.headers as any)['x-senzor-trace-id'] = trace.id;
      (newInit.headers as any)['x-senzor-parent-span-id'] = spanId;
    }

    try {
      // 6. Execute Fetch
      const response = await originalFetch(input, newInit);

      // 7. Record Span
      const duration = performance.now() - spanStartAbs;
      Context.addSpan({
        spanId,
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
        spanId,
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

// --- HTTP/HTTPS INSTRUMENTATION ---
export const instrumentHttp = (ingestUrl: string, debug = false) => {
  let ingestHost = '';
  try { ingestHost = new URL(ingestUrl).hostname; } catch (e) { }

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
      const spanId = randomUUID(); // Generate ID

      let hostname = 'unknown';
      try { hostname = new URL(urlStr).hostname; } catch (e) { hostname = options.hostname || 'unknown'; }

      // Inject Headers
      if (!options.headers) options.headers = {};
      options.headers['x-senzor-trace-id'] = trace.id;
      options.headers['x-senzor-parent-span-id'] = spanId;

      const req = original.apply(this, args);

      const captureSpan = (res: any, error?: Error) => {
        const duration = performance.now() - spanStartAbs;
        Context.addSpan({
          spanId,
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
        res.once('close', () => captureSpan(res)); // Safety if stream not consumed
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