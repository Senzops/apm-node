import { normalizePath } from '../core/normalizer';
import { SenzorOptions } from '../core/types';
import { SENZOR_INTERNAL_HEADER } from '../utils/internal';
import { generateTraceparent } from '../utils/traceContext';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

const hasInternalHeader = (headers: any): boolean => {
  if (!headers) return false;
  if (Array.isArray(headers)) {
    return headers.some(
      ([key, value]) =>
        String(key).toLowerCase() === SENZOR_INTERNAL_HEADER &&
        String(value).toLowerCase() === 'true'
    );
  }

  return Object.entries(headers).some(
    ([key, value]) =>
      key.toLowerCase() === SENZOR_INTERNAL_HEADER &&
      String(value).toLowerCase() === 'true'
  );
};

const setHeader = (headers: any, key: string, value: string) => {
  if (Array.isArray(headers)) {
    headers.push([key, value]);
    return headers;
  }

  const nextHeaders = { ...(headers || {}) };
  const existingKey = Object.keys(nextHeaders).find(
    (header) => header.toLowerCase() === key.toLowerCase()
  );
  nextHeaders[existingKey || key] = value;
  return nextHeaders;
};

const getUrlDetails = (input: any) => {
  try {
    const url = new URL(String(input));
    return {
      url: url.toString(),
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`
    };
  } catch {
    return {
      url: String(input || ''),
      hostname: 'unknown',
      path: '/'
    };
  }
};

const patchRequestLike = (
  target: any,
  methodName: string,
  patchKey: string,
  options?: SenzorOptions
) => {
  patchMethod(
    target,
    methodName,
    patchKey,
    (original) =>
      function patchedUndiciRequest(this: any, input: any, opts?: any, cb?: any) {
        if (hasInternalHeader(opts?.headers)) {
          return original.apply(this, arguments as any);
        }

        // Skip if the request already has Senzor trace headers injected by
        // the fetch instrumentation (Node.js fetch delegates to undici internally).
        const existingHeaders = opts?.headers;
        if (existingHeaders) {
          let hasTrace = false;
          if (typeof Headers !== 'undefined' && existingHeaders instanceof Headers) {
            hasTrace = existingHeaders.has('x-senzor-trace-id');
          } else if (Array.isArray(existingHeaders)) {
            hasTrace = existingHeaders.some(([k]: [string, string]) => String(k).toLowerCase() === 'x-senzor-trace-id');
          } else if (typeof existingHeaders === 'object') {
            hasTrace = Object.keys(existingHeaders).some(k => k.toLowerCase() === 'x-senzor-trace-id');
          }
          if (hasTrace) return original.apply(this, arguments as any);
        }

        const details = getUrlDetails(input?.origin ? input.origin : input);
        const method = String(opts?.method || 'GET').toUpperCase();
        const span = startCapturedSpan(
          `${method} ${details.hostname}`,
          'http',
          {
            url: details.url,
            method,
            route: normalizePath(details.path),
            library: 'undici',
            'http.request.method': method,
            'url.full': details.url,
            'url.path': details.path,
            'server.address': details.hostname
          },
          options
        );

        if (!span) return original.apply(this, arguments as any);

        const nextOptions = { ...(opts || {}) };
        nextOptions.headers = setHeader(
          nextOptions.headers,
          'traceparent',
          generateTraceparent(span.trace!.id, span.spanId)
        );
        nextOptions.headers = setHeader(
          nextOptions.headers,
          'x-senzor-trace-id',
          span.trace!.id
        );
        nextOptions.headers = setHeader(
          nextOptions.headers,
          'x-senzor-parent-span-id',
          span.spanId
        );

        const wrappedCallback =
          typeof cb === 'function'
            ? function wrappedUndiciCallback(this: unknown, err: any, data: any) {
              span.end(err ? 500 : data?.statusCode || 0, {
                error: err?.message,
                'error.type': err?.name,
                'http.response.status_code': data?.statusCode
              });
              return cb.apply(this, arguments as any);
            }
            : cb;

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.call(
              this,
              input,
              nextOptions,
              wrappedCallback
            );

            if (result && typeof result.then === 'function') {
              return result.then(
                (value: any) => {
                  span.end(value?.statusCode || value?.status || 0, {
                    'http.response.status_code':
                      value?.statusCode || value?.status
                  });
                  return value;
                },
                (error: any) => {
                  span.end(500, {
                    error: error?.message,
                    'error.type': error?.name || 'Error'
                  });
                  throw error;
                }
              );
            }

            if (typeof wrappedCallback !== 'function') {
              span.end(0);
            }

            return result;
          } catch (error: any) {
            span.end(500, {
              error: error?.message,
              'error.type': error?.name || 'Error'
            });
            throw error;
          }
        });
      }
  );
};

const patchUndici = (undici: any, options?: SenzorOptions) => {
  patchRequestLike(undici, 'request', 'senzor.undici.request', options);
  patchRequestLike(undici, 'stream', 'senzor.undici.stream', options);
  patchRequestLike(undici, 'pipeline', 'senzor.undici.pipeline', options);

  [
    undici?.Client?.prototype,
    undici?.Pool?.prototype,
    undici?.Agent?.prototype,
    undici?.ProxyAgent?.prototype
  ].forEach((proto, index) => {
    patchRequestLike(
      proto,
      'request',
      `senzor.undici.dispatcher.${index}.request`,
      options
    );
  });
};

export const instrumentUndici = (options?: SenzorOptions) => {
  hookRequire('undici', (exports: any) => patchUndici(exports, options));
};
