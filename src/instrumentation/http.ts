import http from 'http';
import https from 'https';
import { URL } from 'url';
import type { SenzorClient } from '../core/client';
import { Context } from '../core/context';
import { getRoute, normalizePath } from '../core/normalizer';
import { sanitizeHeaders } from '../core/sanitizer';
import { SenzorOptions } from '../core/types';
import { getClientIp } from '../utils/getClientIp';
import { SENZOR_INTERNAL_HEADER } from '../utils/internal';
import { generateTraceparent } from '../utils/traceContext';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

const getDebug = (options?: SenzorOptions): boolean =>
  Boolean(options?.debug);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !(value instanceof URL) &&
  !(value instanceof Function) &&
  !Array.isArray(value);

const headerValue = (
  headers: unknown,
  key: string
): unknown => {
  if (!headers) return undefined;

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(key);
  }

  if (Array.isArray(headers)) {
    const found = headers.find(
      ([name]) => String(name).toLowerCase() === key.toLowerCase()
    );
    return found?.[1];
  }

  if (typeof headers === 'object') {
    const normalizedKey = key.toLowerCase();
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === normalizedKey) return value;
    }
  }

  return undefined;
};

const hasInternalHeader = (headers: unknown): boolean =>
  String(headerValue(headers, SENZOR_INTERNAL_HEADER) || '').toLowerCase() ===
  'true';

const shouldIgnoreUrl = (
  urlString: string,
  ingestUrl: string,
  headers?: unknown
): boolean => {
  if (hasInternalHeader(headers)) return true;
  if (!urlString) return false;

  try {
    const url = new URL(urlString);
    const ingest = new URL(ingestUrl);
    return (
      url.hostname === ingest.hostname &&
      url.pathname.startsWith('/api/ingest')
    );
  } catch {
    return ingestUrl ? urlString.includes(ingestUrl) : false;
  }
};

const cloneHeaders = (headers: unknown): Record<string, unknown> => {
  if (!headers) return {};

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const cloned: Record<string, unknown> = {};
    headers.forEach((value, key) => {
      cloned[key] = value;
    });
    return cloned;
  }

  if (Array.isArray(headers)) {
    return headers.reduce<Record<string, unknown>>((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});
  }

  if (typeof headers === 'object') {
    return { ...(headers as Record<string, unknown>) };
  }

  return {};
};

const setHeader = (
  headers: Record<string, unknown>,
  key: string,
  value: string
) => {
  const existingKey = Object.keys(headers).find(
    (header) => header.toLowerCase() === key.toLowerCase()
  );
  headers[existingKey || key] = value;
};

interface PreparedRequest {
  args: any[];
  options: Record<string, any>;
  url: string;
  method: string;
  hostname: string;
  path: string;
}

const prepareRequestArgs = (
  args: any[],
  defaultProtocol: 'http:' | 'https:'
): PreparedRequest => {
  const nextArgs = [...args];
  let optionsIndex = 0;
  let options: Record<string, any> = {};
  let urlFromArg: URL | null = null;

  if (typeof nextArgs[0] === 'string' || nextArgs[0] instanceof URL) {
    try {
      urlFromArg = new URL(nextArgs[0].toString());
    } catch {
      urlFromArg = null;
    }

    if (isPlainObject(nextArgs[1])) {
      optionsIndex = 1;
      options = {
        ...nextArgs[1],
        headers: cloneHeaders(nextArgs[1].headers)
      };
      nextArgs[1] = options;
    } else {
      optionsIndex = 1;
      options = { headers: {} };
      nextArgs.splice(1, 0, options);
    }
  } else if (isPlainObject(nextArgs[0])) {
    optionsIndex = 0;
    options = {
      ...nextArgs[0],
      headers: cloneHeaders(nextArgs[0].headers)
    };
    nextArgs[0] = options;
  } else {
    optionsIndex = 0;
    options = { headers: {} };
    nextArgs[0] = options;
  }

  if (!options.headers) options.headers = {};
  nextArgs[optionsIndex] = options;

  const protocol =
    options.protocol ||
    urlFromArg?.protocol ||
    (options.port === 443 ? 'https:' : defaultProtocol);
  const hostname =
    options.hostname ||
    options.host ||
    urlFromArg?.hostname ||
    'localhost';
  const path =
    options.path ||
    `${urlFromArg?.pathname || '/'}${urlFromArg?.search || ''}`;
  const url = urlFromArg
    ? urlFromArg.toString()
    : `${protocol}//${hostname}${path}`;
  const method = String(options.method || 'GET').toUpperCase();

  return {
    args: nextArgs,
    options,
    url,
    method,
    hostname: String(hostname).replace(/:\d+$/, ''),
    path
  };
};

const resolveIncomingRoute = (
  req: any,
  res: any,
  path: string
): string => {
  if (res?.statusCode === 404) return 'Not Found';

  try {
    return getRoute(req, path);
  } catch {
    return normalizePath(path);
  }
};

const patchIncomingServer = (
  proto: any,
  protocol: 'http' | 'https',
  client: SenzorClient,
  options?: SenzorOptions
) => {
  patchMethod(
    proto,
    'emit',
    `senzor.${protocol}.server`,
    (original) =>
      function patchedEmit(this: any, event: string, ...args: any[]) {
        if (event !== 'request') {
          return original.call(this, event, ...args);
        }

        const req = args[0];
        const res = args[1];

        if (!req || !res || Context.current()?.contextType === 'apm') {
          return original.call(this, event, ...args);
        }

        const rawPath = req.originalUrl || req.url || '/';
        const path = String(rawPath).split('?')[0] || '/';
        const headers = req.headers || {};

        if (hasInternalHeader(headers)) {
          return original.call(this, event, ...args);
        }

        return client.startTrace(
          {
            method: req.method || 'GET',
            path: rawPath,
            route: normalizePath(path),
            ip: getClientIp(req),
            userAgent: headers['user-agent'],
            headers,
            meta: {
              protocol,
              httpVersion: req.httpVersion,
              headers: options?.captureHeaders
                ? sanitizeHeaders(headers, options)
                : undefined
            }
          },
          () => {
            const trace = Context.current();
            let finalized = false;

            const finalize = (reason: 'finish' | 'close' | 'error') => {
              if (finalized || !trace) return;
              finalized = true;

              setImmediate(() => {
                if (trace.ended) return;

                Context.run(trace, () => {
                  client.endTrace(res.statusCode || 0, {
                    route: resolveIncomingRoute(req, res, path),
                    statusMessage: res.statusMessage,
                    meta: {
                      ...trace.data.meta,
                      endReason: reason
                    }
                  });
                });
              });
            };

            res.once('finish', () => finalize('finish'));
            res.once('close', () => finalize('close'));
            res.once('error', (error: Error) => {
              client.captureError(error, {
                instrumentation: `${protocol}.server`
              });
              finalize('error');
            });

            try {
              return original.call(this, event, ...args);
            } catch (error) {
              client.captureError(error, {
                instrumentation: `${protocol}.server`
              });
              finalize('error');
              throw error;
            }
          }
        );
      }
  );
};

const patchOutgoing = (
  moduleRef: typeof http | typeof https,
  protocol: 'http:' | 'https:',
  ingestUrl: string,
  options?: SenzorOptions
) => {
  const patchKeyPrefix = protocol === 'https:' ? 'senzor.https' : 'senzor.http';

  const requestWrapper = (original: Function) =>
    function patchedRequest(this: any, ...args: any[]) {
      const prepared = prepareRequestArgs(args, protocol);

      if (
        shouldIgnoreUrl(
          prepared.url,
          ingestUrl,
          prepared.options.headers
        )
      ) {
        return original.apply(this, args);
      }

      const trace = Context.current();
      if (!trace) return original.apply(this, args);

      const span = startCapturedSpan(
        `${prepared.method} ${prepared.hostname}`,
        'http',
        {
          url: prepared.url,
          method: prepared.method,
          library: protocol === 'https:' ? 'https' : 'http',
          'http.request.method': prepared.method,
          'url.full': prepared.url,
          'url.path': prepared.path,
          'server.address': prepared.hostname
        },
        options
      );

      if (span) {
        setHeader(
          prepared.options.headers,
          'traceparent',
          generateTraceparent(trace.id, span.spanId)
        );
        setHeader(prepared.options.headers, 'x-senzor-trace-id', trace.id);
        setHeader(
          prepared.options.headers,
          'x-senzor-parent-span-id',
          span.spanId
        );
      }

      const invoke = () => {
        const req = original.apply(this, prepared.args);
        if (!span || !req || typeof req.once !== 'function') {
          return req;
        }

        let completed = false;
        const endSpan = (
          status: number,
          extraMeta: Record<string, unknown> = {}
        ) => {
          if (completed) return;
          completed = true;
          span.end(status, extraMeta);
        };

        req.once('response', (res: any) => {
          const statusCode = res?.statusCode || 0;
          const finish = () =>
            endSpan(statusCode, {
              'http.response.status_code': statusCode
            });

          res.once('end', finish);
          res.once('close', finish);
          res.once('error', (error: Error) =>
            endSpan(500, {
              error: error.message,
              'error.type': error.name
            })
          );
        });

        req.once('timeout', () =>
          endSpan(504, {
            error: 'Request timed out',
            'error.type': 'TimeoutError'
          })
        );
        req.once('error', (error: Error) =>
          endSpan(500, {
            error: error.message,
            'error.type': error.name
          })
        );

        return req;
      };

      if (getDebug(options)) {
        console.log(`[Senzor] Injecting trace headers to ${prepared.url}`);
      }

      return runWithCapturedSpan(span, invoke);
    };

  patchMethod(
    moduleRef,
    'request',
    `${patchKeyPrefix}.request`,
    requestWrapper
  );
  patchMethod(
    moduleRef,
    'get',
    `${patchKeyPrefix}.get`,
    requestWrapper
  );
};

export const instrumentFetch = (
  ingestUrl: string,
  options?: SenzorOptions
) => {
  if (!globalThis.fetch) return;

  patchMethod(
    globalThis,
    'fetch',
    'senzor.fetch',
    (original) =>
      async function patchedFetch(
        this: any,
        input: any,
        init?: any
      ): Promise<Response> {
        const urlString =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input?.url || '';

        const originalHeaders = init?.headers || input?.headers;
        if (shouldIgnoreUrl(urlString, ingestUrl, originalHeaders)) {
          return original.call(this, input, init);
        }

        const trace = Context.current();
        if (!trace) return original.call(this, input, init);

        let hostname = 'unknown';
        let path = '/';
        try {
          const url = new URL(urlString);
          hostname = url.hostname;
          path = `${url.pathname}${url.search}`;
        } catch { }

        const method = String(
          init?.method || input?.method || 'GET'
        ).toUpperCase();
        const span = startCapturedSpan(
          `${method} ${hostname}`,
          'http',
          {
            url: urlString,
            method,
            library: 'fetch',
            'http.request.method': method,
            'url.full': urlString,
            'url.path': path,
            'server.address': hostname
          },
          options
        );

        if (!span) return original.call(this, input, init);

        const nextInit = { ...(init || {}) };
        const headers =
          typeof Headers !== 'undefined'
            ? new Headers(originalHeaders || undefined)
            : cloneHeaders(originalHeaders);

        if (typeof Headers !== 'undefined' && headers instanceof Headers) {
          headers.set('traceparent', generateTraceparent(trace.id, span.spanId));
          headers.set('x-senzor-trace-id', trace.id);
          headers.set('x-senzor-parent-span-id', span.spanId);
        } else {
          setHeader(headers as Record<string, unknown>, 'traceparent', generateTraceparent(trace.id, span.spanId));
          setHeader(headers as Record<string, unknown>, 'x-senzor-trace-id', trace.id);
          setHeader(headers as Record<string, unknown>, 'x-senzor-parent-span-id', span.spanId);
        }
        nextInit.headers = headers;

        return runWithCapturedSpan(span, async () => {
          try {
            const response = await original.call(this, input, nextInit);
            span.end(response.status, {
              'http.response.status_code': response.status
            });
            return response;
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

export const instrumentHttp = (
  client: SenzorClient,
  ingestUrl: string,
  options?: SenzorOptions
) => {
  patchIncomingServer(http.Server?.prototype, 'http', client, options);
  patchIncomingServer(https.Server?.prototype, 'https', client, options);

  patchOutgoing(http, 'http:', ingestUrl, options);
  patchOutgoing(https, 'https:', ingestUrl, options);
};
