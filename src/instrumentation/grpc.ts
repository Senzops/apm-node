import { SenzorOptions } from '../core/types';
import { Context } from '../core/context';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';
import { generateTraceparent, parseTraceparent } from '../utils/traceContext';

// ---------------------------------------------------------------------------
// gRPC Instrumentation
//
// Instruments @grpc/grpc-js for both client (unary + streaming) and server
// (unary + streaming) calls. Follows OTel RPC semantic conventions.
//
// Client spans:  rpc.system=grpc, rpc.service, rpc.method, rpc.grpc.status_code
// Server spans:  Creates a root trace per incoming RPC call
// ---------------------------------------------------------------------------

/** gRPC status code to human-readable name (subset for common codes). */
const GRPC_STATUS_NAMES: Record<number, string> = {
  0: 'OK',
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
};

/** Map gRPC status code → HTTP-equivalent status for span.status. */
const grpcStatusToHttp = (code: number): number => {
  if (code === 0) return 0; // OK
  if (code === 1) return 499; // CANCELLED → Client Closed Request
  if (code === 3 || code === 9 || code === 11) return 400; // INVALID_ARGUMENT, FAILED_PRECONDITION, OUT_OF_RANGE
  if (code === 4) return 504; // DEADLINE_EXCEEDED
  if (code === 5) return 404; // NOT_FOUND
  if (code === 6) return 409; // ALREADY_EXISTS
  if (code === 7) return 403; // PERMISSION_DENIED
  if (code === 8) return 429; // RESOURCE_EXHAUSTED
  if (code === 10) return 409; // ABORTED
  if (code === 12) return 501; // UNIMPLEMENTED
  if (code === 16) return 401; // UNAUTHENTICATED
  return 500; // UNKNOWN, INTERNAL, UNAVAILABLE, DATA_LOSS, etc.
};

/** Parse a gRPC full method path like /package.ServiceName/MethodName */
const parseGrpcMethod = (fullPath: string): { service: string; method: string } => {
  const parts = fullPath.replace(/^\//, '').split('/');
  return {
    service: parts[0] || 'unknown',
    method: parts[1] || 'unknown',
  };
};

// ---------------------------------------------------------------------------
// Metadata propagation helpers
// ---------------------------------------------------------------------------

const TRACEPARENT_KEY = 'traceparent';
const SENZOR_TRACE_KEY = 'x-senzor-trace-id';
const SENZOR_SPAN_KEY = 'x-senzor-parent-span-id';

/** Inject trace context into gRPC metadata (client-side). */
const injectMetadata = (metadata: any, traceId: string, spanId: string) => {
  try {
    if (metadata && typeof metadata.set === 'function') {
      metadata.set(TRACEPARENT_KEY, generateTraceparent(traceId, spanId));
      metadata.set(SENZOR_TRACE_KEY, traceId);
      metadata.set(SENZOR_SPAN_KEY, spanId);
    }
  } catch { /* metadata immutable — skip silently */ }
};

/** Extract trace context from incoming gRPC metadata (server-side). */
const extractFromMetadata = (
  metadata: any
): { traceId?: string; parentSpanId?: string } => {
  try {
    if (!metadata || typeof metadata.get !== 'function') return {};

    const traceparent = metadata.get(TRACEPARENT_KEY);
    const tp = Array.isArray(traceparent) ? traceparent[0] : traceparent;
    if (tp) {
      const parsed = parseTraceparent(String(tp));
      if (parsed) return parsed;
    }

    const traceId = metadata.get(SENZOR_TRACE_KEY);
    const parentSpanId = metadata.get(SENZOR_SPAN_KEY);
    return {
      traceId: Array.isArray(traceId) ? traceId[0] : traceId || undefined,
      parentSpanId: Array.isArray(parentSpanId) ? parentSpanId[0] : parentSpanId || undefined,
    };
  } catch {
    return {};
  }
};

// ---------------------------------------------------------------------------
// Client interceptor
// ---------------------------------------------------------------------------

/**
 * Creates a gRPC client interceptor that wraps each outbound RPC call in a
 * child span and propagates trace context via metadata.
 */
const createClientInterceptor = (options?: SenzorOptions) => {
  return (methodOptions: any, nextCall: any) => {
    const trace = Context.current();
    if (!trace) return nextCall(methodOptions);

    const { service, method } = parseGrpcMethod(methodOptions.method_definition?.path || '');
    const fullMethod = methodOptions.method_definition?.path || `/${service}/${method}`;

    const span = startCapturedSpan(
      `gRPC ${service}/${method}`,
      'http',
      {
        'rpc.system': 'grpc',
        'rpc.service': service,
        'rpc.method': method,
        'rpc.grpc.full_method': fullMethod,
        'network.transport': 'tcp',
      },
      options
    );

    if (!span) return nextCall(methodOptions);

    // Clone method options to inject metadata
    const newMethodOptions = { ...methodOptions };

    return runWithCapturedSpan(span, () => {
      const interceptingCall = new (getInterceptingCall())(nextCall(newMethodOptions));

      // We need a requester that injects metadata on start and captures status on close
      const requester = {
        start: (metadata: any, listener: any, next: (metadata: any, listener: any) => void) => {
          injectMetadata(metadata, trace.id, span.spanId);

          const wrappedListener = {
            onReceiveMetadata: (metadata: any, next: (metadata: any) => void) => {
              next(metadata);
            },
            onReceiveMessage: (message: any, next: (message: any) => void) => {
              next(message);
            },
            onReceiveStatus: (status: any, next: (status: any) => void) => {
              const grpcCode = status?.code ?? 0;
              span.end(grpcStatusToHttp(grpcCode), {
                'rpc.grpc.status_code': grpcCode,
                'rpc.grpc.status_text': GRPC_STATUS_NAMES[grpcCode] || 'UNKNOWN',
                ...(status?.details ? { 'error.message': status.details } : {}),
              });
              next(status);
            },
          };

          next(metadata, wrappedListener);
        },
        sendMessage: (message: any, next: (message: any) => void) => {
          next(message);
        },
        halfClose: (next: () => void) => {
          next();
        },
        cancel: (message: string, next: () => void) => {
          span.end(grpcStatusToHttp(1), {
            'rpc.grpc.status_code': 1,
            'rpc.grpc.status_text': 'CANCELLED',
            'error.message': message || 'Call cancelled',
          });
          next();
        },
      };

      return interceptingCall;
    });
  };
};

// Cache the InterceptingCall class
let _InterceptingCall: any = null;
const getInterceptingCall = (): any => {
  if (_InterceptingCall) return _InterceptingCall;
  try {
    const grpc = require('@grpc/grpc-js');
    _InterceptingCall = grpc.InterceptingCall;
  } catch { }
  return _InterceptingCall;
};

// ---------------------------------------------------------------------------
// Client-side patching (simpler approach: patch makeUnaryRequest etc.)
// ---------------------------------------------------------------------------

const patchClientMethods = (grpc: any, options?: SenzorOptions) => {
  const clientProto = grpc?.Client?.prototype;
  if (!clientProto) return;

  // Patch makeUnaryRequest — the core method all unary stubs resolve to
  patchMethod(
    clientProto,
    'makeUnaryRequest',
    'senzor.grpc.client.makeUnaryRequest',
    (original) =>
      function patchedMakeUnaryRequest(this: any, method: string, ...args: any[]) {
        const trace = Context.current();
        if (!trace) return original.call(this, method, ...args);

        const { service, method: rpcMethod } = parseGrpcMethod(method);

        const span = startCapturedSpan(
          `gRPC ${service}/${rpcMethod}`,
          'http',
          {
            'rpc.system': 'grpc',
            'rpc.service': service,
            'rpc.method': rpcMethod,
            'rpc.grpc.full_method': method,
            'network.transport': 'tcp',
          },
          options
        );

        if (!span) return original.call(this, method, ...args);

        // args: [serialize, deserialize, argument, metadata, options, callback]
        // Inject trace context into metadata
        let metadataIdx = -1;
        let callbackIdx = -1;

        for (let i = 0; i < args.length; i++) {
          if (args[i] && typeof args[i] === 'object' && typeof args[i].set === 'function' && typeof args[i].get === 'function') {
            metadataIdx = i;
          }
          if (typeof args[i] === 'function' && i === args.length - 1) {
            callbackIdx = i;
          }
        }

        // Inject into metadata if found
        if (metadataIdx >= 0) {
          injectMetadata(args[metadataIdx], trace.id, span.spanId);
        }

        // Wrap callback to capture status
        if (callbackIdx >= 0) {
          const originalCallback = args[callbackIdx];
          args[callbackIdx] = function wrappedGrpcCallback(err: any, response: any) {
            if (err) {
              const grpcCode = err.code ?? 2;
              span.end(grpcStatusToHttp(grpcCode), {
                'rpc.grpc.status_code': grpcCode,
                'rpc.grpc.status_text': GRPC_STATUS_NAMES[grpcCode] || 'UNKNOWN',
                'error.message': err.details || err.message,
                'error.type': err.name || 'GrpcError',
              });
            } else {
              span.end(0, {
                'rpc.grpc.status_code': 0,
                'rpc.grpc.status_text': 'OK',
              });
            }
            return originalCallback.call(this, err, response);
          };
        }

        return runWithCapturedSpan(span, () => {
          try {
            const call = original.call(this, method, ...args);

            // If no callback was provided, the call returns a ClientUnaryCall
            // which emits 'status' and 'error' events
            if (callbackIdx < 0 && call && typeof call.on === 'function') {
              let ended = false;
              call.on('status', (status: any) => {
                if (ended) return;
                ended = true;
                const grpcCode = status?.code ?? 0;
                span.end(grpcStatusToHttp(grpcCode), {
                  'rpc.grpc.status_code': grpcCode,
                  'rpc.grpc.status_text': GRPC_STATUS_NAMES[grpcCode] || 'UNKNOWN',
                });
              });
              call.on('error', (err: any) => {
                if (ended) return;
                ended = true;
                const grpcCode = err?.code ?? 2;
                span.end(grpcStatusToHttp(grpcCode), {
                  'rpc.grpc.status_code': grpcCode,
                  'error.message': err?.details || err?.message,
                  'error.type': err?.name || 'GrpcError',
                });
              });
            }

            return call;
          } catch (error: any) {
            span.end(500, {
              'rpc.grpc.status_code': 13,
              'rpc.grpc.status_text': 'INTERNAL',
              'error.message': error?.message,
              'error.type': error?.name || 'Error',
            });
            throw error;
          }
        });
      }
  );

  // Patch makeClientStreamRequest
  patchMethod(
    clientProto,
    'makeClientStreamRequest',
    'senzor.grpc.client.makeClientStreamRequest',
    (original) =>
      function patchedMakeClientStreamRequest(this: any, method: string, ...args: any[]) {
        const trace = Context.current();
        if (!trace) return original.call(this, method, ...args);

        const { service, method: rpcMethod } = parseGrpcMethod(method);
        const span = startCapturedSpan(
          `gRPC ${service}/${rpcMethod} (client-stream)`,
          'http',
          {
            'rpc.system': 'grpc',
            'rpc.service': service,
            'rpc.method': rpcMethod,
            'rpc.grpc.full_method': method,
            'rpc.grpc.call_type': 'client_stream',
            'network.transport': 'tcp',
          },
          options
        );

        if (!span) return original.call(this, method, ...args);

        // Inject metadata
        for (let i = 0; i < args.length; i++) {
          if (args[i] && typeof args[i] === 'object' && typeof args[i].set === 'function' && typeof args[i].get === 'function') {
            injectMetadata(args[i], trace.id, span.spanId);
            break;
          }
        }

        // Wrap callback
        for (let i = args.length - 1; i >= 0; i--) {
          if (typeof args[i] === 'function') {
            const originalCallback = args[i];
            args[i] = function wrappedCallback(err: any, response: any) {
              if (err) {
                const grpcCode = err.code ?? 2;
                span.end(grpcStatusToHttp(grpcCode), {
                  'rpc.grpc.status_code': grpcCode,
                  'error.message': err.details || err.message,
                });
              } else {
                span.end(0, { 'rpc.grpc.status_code': 0 });
              }
              return originalCallback.call(this, err, response);
            };
            break;
          }
        }

        return runWithCapturedSpan(span, () => {
          try {
            return original.call(this, method, ...args);
          } catch (error: any) {
            span.end(500, { 'error.message': error?.message, 'error.type': error?.name });
            throw error;
          }
        });
      }
  );

  // Patch makeServerStreamRequest
  patchMethod(
    clientProto,
    'makeServerStreamRequest',
    'senzor.grpc.client.makeServerStreamRequest',
    (original) =>
      function patchedMakeServerStreamRequest(this: any, method: string, ...args: any[]) {
        const trace = Context.current();
        if (!trace) return original.call(this, method, ...args);

        const { service, method: rpcMethod } = parseGrpcMethod(method);
        const span = startCapturedSpan(
          `gRPC ${service}/${rpcMethod} (server-stream)`,
          'http',
          {
            'rpc.system': 'grpc',
            'rpc.service': service,
            'rpc.method': rpcMethod,
            'rpc.grpc.full_method': method,
            'rpc.grpc.call_type': 'server_stream',
            'network.transport': 'tcp',
          },
          options
        );

        if (!span) return original.call(this, method, ...args);

        // Inject metadata
        for (let i = 0; i < args.length; i++) {
          if (args[i] && typeof args[i] === 'object' && typeof args[i].set === 'function') {
            injectMetadata(args[i], trace.id, span.spanId);
            break;
          }
        }

        return runWithCapturedSpan(span, () => {
          try {
            const call = original.call(this, method, ...args);

            if (call && typeof call.on === 'function') {
              let ended = false;
              call.on('status', (status: any) => {
                if (ended) return;
                ended = true;
                const grpcCode = status?.code ?? 0;
                span.end(grpcStatusToHttp(grpcCode), {
                  'rpc.grpc.status_code': grpcCode,
                  'rpc.grpc.status_text': GRPC_STATUS_NAMES[grpcCode] || 'UNKNOWN',
                });
              });
              call.on('error', (err: any) => {
                if (ended) return;
                ended = true;
                span.end(grpcStatusToHttp(err?.code ?? 2), {
                  'rpc.grpc.status_code': err?.code ?? 2,
                  'error.message': err?.details || err?.message,
                });
              });
            }

            return call;
          } catch (error: any) {
            span.end(500, { 'error.message': error?.message, 'error.type': error?.name });
            throw error;
          }
        });
      }
  );

  // Patch makeBidiStreamRequest
  patchMethod(
    clientProto,
    'makeBidiStreamRequest',
    'senzor.grpc.client.makeBidiStreamRequest',
    (original) =>
      function patchedMakeBidiStreamRequest(this: any, method: string, ...args: any[]) {
        const trace = Context.current();
        if (!trace) return original.call(this, method, ...args);

        const { service, method: rpcMethod } = parseGrpcMethod(method);
        const span = startCapturedSpan(
          `gRPC ${service}/${rpcMethod} (bidi-stream)`,
          'http',
          {
            'rpc.system': 'grpc',
            'rpc.service': service,
            'rpc.method': rpcMethod,
            'rpc.grpc.full_method': method,
            'rpc.grpc.call_type': 'bidi_stream',
            'network.transport': 'tcp',
          },
          options
        );

        if (!span) return original.call(this, method, ...args);

        for (let i = 0; i < args.length; i++) {
          if (args[i] && typeof args[i] === 'object' && typeof args[i].set === 'function') {
            injectMetadata(args[i], trace.id, span.spanId);
            break;
          }
        }

        return runWithCapturedSpan(span, () => {
          try {
            const call = original.call(this, method, ...args);

            if (call && typeof call.on === 'function') {
              let ended = false;
              call.on('status', (status: any) => {
                if (ended) return;
                ended = true;
                const grpcCode = status?.code ?? 0;
                span.end(grpcStatusToHttp(grpcCode), {
                  'rpc.grpc.status_code': grpcCode,
                });
              });
              call.on('error', (err: any) => {
                if (ended) return;
                ended = true;
                span.end(grpcStatusToHttp(err?.code ?? 2), {
                  'rpc.grpc.status_code': err?.code ?? 2,
                  'error.message': err?.details || err?.message,
                });
              });
            }

            return call;
          } catch (error: any) {
            span.end(500, { 'error.message': error?.message, 'error.type': error?.name });
            throw error;
          }
        });
      }
  );
};

// ---------------------------------------------------------------------------
// Server-side patching
// ---------------------------------------------------------------------------

const patchServerRegister = (grpc: any, client: any, options?: SenzorOptions) => {
  const serverProto = grpc?.Server?.prototype;
  if (!serverProto) return;

  patchMethod(
    serverProto,
    'register',
    'senzor.grpc.server.register',
    (original) =>
      function patchedRegister(
        this: any,
        name: string,
        handler: any,
        serialize: any,
        deserialize: any,
        type: any
      ) {
        if (typeof handler !== 'function') {
          return original.call(this, name, handler, serialize, deserialize, type);
        }

        const wrappedHandler = function (this: any, call: any, callback?: any) {
          const { service, method } = parseGrpcMethod(name);
          const metadata = call?.metadata;
          const parentCtx = extractFromMetadata(metadata);

          const span = startCapturedSpan(
            `gRPC ${service}/${method}`,
            'http',
            {
              'rpc.system': 'grpc',
              'rpc.service': service,
              'rpc.method': method,
              'rpc.grpc.full_method': name,
              'rpc.grpc.call_type': type || 'unary',
              'server.type': 'grpc',
              ...(parentCtx.traceId ? { 'parent.trace_id': parentCtx.traceId } : {}),
            },
            options
          );

          if (!span) {
            return handler.call(this, call, callback);
          }

          // Wrap callback for unary/client-streaming handlers
          if (typeof callback === 'function') {
            const wrappedCallback = function (err: any, response: any, trailer?: any, flags?: any) {
              if (err) {
                const grpcCode = err.code ?? 2;
                span.end(grpcStatusToHttp(grpcCode), {
                  'rpc.grpc.status_code': grpcCode,
                  'rpc.grpc.status_text': GRPC_STATUS_NAMES[grpcCode] || 'UNKNOWN',
                  'error.message': err.details || err.message,
                  'error.type': err.name || 'GrpcError',
                });
              } else {
                span.end(0, {
                  'rpc.grpc.status_code': 0,
                  'rpc.grpc.status_text': 'OK',
                });
              }
              return callback(err, response, trailer, flags);
            };

            return runWithCapturedSpan(span, () => {
              try {
                return handler.call(this, call, wrappedCallback);
              } catch (error: any) {
                span.end(500, {
                  'rpc.grpc.status_code': 13,
                  'error.message': error?.message,
                  'error.type': error?.name || 'Error',
                });
                throw error;
              }
            });
          }

          // Server-streaming / bidi-streaming: listen to call events
          return runWithCapturedSpan(span, () => {
            try {
              const result = handler.call(this, call);

              if (call && typeof call.on === 'function') {
                let ended = false;
                const endOnce = (status: number, meta: Record<string, any>) => {
                  if (ended) return;
                  ended = true;
                  span.end(status, meta);
                };

                call.on('error', (err: any) => {
                  const grpcCode = err?.code ?? 2;
                  endOnce(grpcStatusToHttp(grpcCode), {
                    'rpc.grpc.status_code': grpcCode,
                    'error.message': err?.details || err?.message,
                  });
                });

                call.on('end', () => {
                  endOnce(0, { 'rpc.grpc.status_code': 0 });
                });

                call.on('cancelled', () => {
                  endOnce(grpcStatusToHttp(1), {
                    'rpc.grpc.status_code': 1,
                    'rpc.grpc.status_text': 'CANCELLED',
                  });
                });
              }

              return result;
            } catch (error: any) {
              span.end(500, {
                'rpc.grpc.status_code': 13,
                'error.message': error?.message,
                'error.type': error?.name || 'Error',
              });
              throw error;
            }
          });
        };

        return original.call(this, name, wrappedHandler, serialize, deserialize, type);
      }
  );
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentGrpc = (client: any, options?: SenzorOptions) => {
  hookRequire('@grpc/grpc-js', (exports: any) => {
    patchClientMethods(exports, options);
    patchServerRegister(exports, client, options);
  });
};
