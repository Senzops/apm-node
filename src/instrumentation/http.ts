import http from 'http';
import https from 'https';
import { URL } from 'url';
import { Context } from '../core/context';
import { randomUUID } from 'crypto';
import { generateTraceparent } from '../utils/traceContext';

const shimmer = (module: any, methodName: string, wrapper: (original: Function) => Function) => {
  if (!module[methodName]) return;
  const original = module[methodName];
  module[methodName] = wrapper(original);
};

// 16-char hex for W3C standard spans
const generateSpanId = () => randomUUID().replace(/-/g, '').slice(0, 16);

// --- FETCH INSTRUMENTATION ---
export const instrumentFetch = (ingestUrl: string, debug = false) => {
  if (!globalThis.fetch) return;

  let ingestHost = '';
  try { ingestHost = new URL(ingestUrl).hostname; } catch (e) { }

  const originalFetch = globalThis.fetch;

  // @ts-ignore
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let urlStr = '';
    if (typeof input === 'string') urlStr = input;
    else if (input instanceof URL) urlStr = input.toString();
    else if (input && (input as any).url) urlStr = (input as any).url;

    if (ingestHost && urlStr.includes(ingestHost)) {
      return originalFetch(input, init);
    }

    const trace = Context.current();
    if (!trace) {
      return originalFetch(input, init);
    }

    const method = (init?.method || 'GET').toUpperCase();
    const startTime = performance.now() - trace.startTime;
    const spanStartAbs = performance.now();
    const spanId = generateSpanId();

    let hostname = 'unknown';
    try { hostname = new URL(urlStr).hostname; } catch (e) { }

    const newInit = { ...init } as RequestInit;
    if (!newInit.headers) newInit.headers = {};

    const setHeader = (key: string, value: string) => {
      if (newInit.headers instanceof Headers) {
        newInit.headers.set(key, value);
      } else if (Array.isArray(newInit.headers)) {
        newInit.headers.push([key, value]);
      } else {
        (newInit.headers as any)[key] = value;
      }
    };

    // W3C Trace Context Injection
    setHeader('traceparent', generateTraceparent(trace.id, spanId));

    // Legacy fallback for older Senzor services
    setHeader('x-senzor-trace-id', trace.id);
    setHeader('x-senzor-parent-span-id', spanId);

    try {
      const response = await originalFetch(input, newInit);
      const duration = performance.now() - spanStartAbs;
      Context.addSpan({ spanId, name: `${method} ${hostname}`, type: 'http', startTime, duration, status: response.status, meta: { url: urlStr, method, library: 'fetch' } });
      return response;
    } catch (err: any) {
      const duration = performance.now() - spanStartAbs;
      Context.addSpan({ spanId, name: `${method} ${hostname}`, type: 'http', startTime, duration, status: 500, meta: { error: err.message, url: urlStr, library: 'fetch' } });
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
      let optionsIndex = 0;

      if (typeof args[0] === 'string' || args[0] instanceof URL) {
        urlStr = args[0].toString();
        optionsIndex = 1;
      } else {
        optionsIndex = 0;
      }

      if (!args[optionsIndex] || typeof args[optionsIndex] !== 'object') {
        args[optionsIndex] = {};
      }
      options = args[optionsIndex];

      if (!urlStr) {
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
      const spanId = generateSpanId();

      let hostname = 'unknown';
      try { hostname = new URL(urlStr).hostname; } catch (e) { hostname = options.hostname || 'unknown'; }

      if (!options.headers) options.headers = {};

      // W3C Trace Context Injection
      options.headers['traceparent'] = generateTraceparent(trace.id, spanId);

      // Legacy fallback
      options.headers['x-senzor-trace-id'] = trace.id;
      options.headers['x-senzor-parent-span-id'] = spanId;

      if (debug) console.log(`[Senzor] Injecting W3C traceparent headers to ${urlStr}`);

      const req = original.apply(this, args);

      const captureSpan = (res: any, error?: Error) => {
        const duration = performance.now() - spanStartAbs;
        Context.addSpan({ spanId, name: `${method} ${hostname}`, type: 'http', startTime, duration, status: error ? 500 : res?.statusCode || 0, meta: { url: urlStr, method, library: 'http' } });
      };

      req.on('response', (res: any) => {
        res.once('end', () => captureSpan(res));
        res.once('close', () => captureSpan(res));
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