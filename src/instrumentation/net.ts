import { SenzorOptions } from '../core/types';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// Net (TCP) Instrumentation
//
// Instruments Node.js core `net` module:
//   - net.Socket.prototype.connect() — socket-level connection spans
//
// Captures TCP connection establishment latency and peer information.
// Follows OTel semantic conventions: net.peer.name, net.peer.port, net.transport
//
// NOTE: This instrumentation only captures connection establishment, not
// data transfer. This prevents excessive span noise while still providing
// visibility into network bottlenecks (slow connects, timeouts, refused).
// ---------------------------------------------------------------------------

/**
 * Normalize connection options from the various net.connect() signatures:
 *   - connect(port, host, cb)
 *   - connect({ port, host }, cb)
 *   - connect(path, cb)              — IPC / Unix domain socket
 *   - connect({ path }, cb)          — IPC / Unix domain socket
 *   - connect([options, cb])         — Node.js internal normalized format
 *   - connect([port, host, cb])      — Node.js internal normalized format
 */
const normalizeConnectArgs = (
  args: any[]
): { host: string; port: number | string; isIPC: boolean } | null => {
  try {
    let first = args[0];

    // Node.js internally calls socket.connect(normalizedArray) where
    // normalizedArray is [options, cb]. Unwrap the array.
    if (Array.isArray(first)) {
      first = first[0];
      if (first === undefined || first === null) {
        return { host: 'localhost', port: 0, isIPC: false };
      }
    }

    // Object form: { port, host } or { path }
    if (typeof first === 'object' && first !== null) {
      if (first.path) {
        return { host: String(first.path), port: 'ipc', isIPC: true };
      }
      return {
        host: String(first.host || 'localhost'),
        port: typeof first.port === 'number' ? first.port : (parseInt(String(first.port), 10) || 0),
        isIPC: false,
      };
    }

    // String form: path (IPC) — non-numeric strings are treated as Unix socket paths
    if (typeof first === 'string') {
      const asNum = Number(first);
      if (!Number.isFinite(asNum)) {
        return { host: first, port: 'ipc', isIPC: true };
      }
      // Numeric string — treat as port
      const host = typeof args[1] === 'string' ? args[1] : 'localhost';
      return { host, port: asNum, isIPC: false };
    }

    // Numeric form: port, [host]
    if (typeof first === 'number') {
      const host = typeof args[1] === 'string' ? args[1] : 'localhost';
      return { host, port: first, isIPC: false };
    }

    // Unrecognized format — skip instrumentation
    return null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

const patchSocketConnect = (netModule: any, options?: SenzorOptions) => {
  const socketProto = netModule?.Socket?.prototype;
  if (!socketProto) return;

  patchMethod(
    socketProto,
    'connect',
    'senzor.net.socket.connect',
    (original) =>
      function patchedSocketConnect(this: any, ...args: any[]) {
        const parsed = normalizeConnectArgs(args);

        // If we can't parse the args, pass through to original without instrumentation
        if (!parsed) return original.apply(this, args);

        const { host, port, isIPC } = parsed;

        const spanName = isIPC
          ? `TCP connect ${host}`
          : `TCP connect ${host}:${port}`;

        const span = startCapturedSpan(
          spanName,
          'custom',
          {
            'net.peer.name': host,
            'net.peer.port': isIPC ? undefined : port,
            'net.transport': isIPC ? 'unix' : 'tcp',
            'network.transport': isIPC ? 'unix' : 'tcp',
          },
          options
        );

        if (!span) return original.apply(this, args);

        return runWithCapturedSpan(span, () => {
          try {
            const socket = original.apply(this, args);

            if (!socket || typeof socket.once !== 'function') {
              span.end(0);
              return socket;
            }

            let ended = false;
            const endOnce = (status: number, meta: Record<string, any> = {}) => {
              if (ended) return;
              ended = true;
              span.end(status, meta);
            };

            socket.once('connect', () => {
              endOnce(0, {
                'net.peer.address': socket.remoteAddress,
                'net.peer.port': socket.remotePort,
                'net.local.address': socket.localAddress,
                'net.local.port': socket.localPort,
              });
            });

            socket.once('error', (err: any) => {
              endOnce(500, {
                'error.message': err?.message,
                'error.type': err?.code || err?.name || 'NetError',
                'net.error_code': err?.code,
              });
            });

            socket.once('timeout', () => {
              endOnce(504, {
                'error.message': 'Connection timed out',
                'error.type': 'TimeoutError',
              });
            });

            socket.once('close', (hadError: boolean) => {
              if (hadError) {
                endOnce(500, { 'error.message': 'Connection closed with error' });
              } else {
                endOnce(0);
              }
            });

            return socket;
          } catch (err) {
            span.end(500, { 'error.message': (err as Error)?.message, 'error.type': (err as Error)?.name });
            throw err;
          }
        });
      }
  );
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentNet = (options?: SenzorOptions) => {
  let net: any;
  try {
    net = require('net');
  } catch {
    return;
  }

  if (!net) return;

  patchSocketConnect(net, options);
};
