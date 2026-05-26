import { SenzorOptions } from '../core/types';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// Net (TCP) Instrumentation
//
// Instruments Node.js core `net` module:
//   - net.connect() / net.createConnection()  — TCP connection spans
//   - net.Socket.prototype.connect()          — socket-level connection
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
 *   - connect(path, cb)        — IPC / Unix domain socket
 *   - connect({ path }, cb)    — IPC / Unix domain socket
 */
const normalizeConnectArgs = (
  args: any[]
): { host: string; port: number | string; isIPC: boolean } => {
  const first = args[0];

  // Object form: { port, host } or { path }
  if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
    if (first.path) {
      return { host: first.path, port: 'ipc', isIPC: true };
    }
    return {
      host: first.host || 'localhost',
      port: first.port || 0,
      isIPC: false,
    };
  }

  // String form: path (IPC)
  if (typeof first === 'string' && !Number.isFinite(Number(first))) {
    return { host: first, port: 'ipc', isIPC: true };
  }

  // Numeric form: port, [host]
  const port = Number(first) || 0;
  const host = typeof args[1] === 'string' ? args[1] : 'localhost';
  return { host, port, isIPC: false };
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
        const { host, port, isIPC } = normalizeConnectArgs(args);

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
          const socket = original.apply(this, args);

          let ended = false;
          const endOnce = (status: number, meta: Record<string, any> = {}) => {
            if (ended) return;
            ended = true;
            span.end(status, meta);
          };

          // Connection established successfully
          socket.once('connect', () => {
            endOnce(0, {
              'net.peer.address': socket.remoteAddress,
              'net.peer.port': socket.remotePort,
              'net.local.address': socket.localAddress,
              'net.local.port': socket.localPort,
            });
          });

          // Connection failed
          socket.once('error', (err: any) => {
            endOnce(500, {
              'error.message': err?.message,
              'error.type': err?.code || err?.name || 'NetError',
              'net.error_code': err?.code,
            });
          });

          // Connection timed out
          socket.once('timeout', () => {
            endOnce(504, {
              'error.message': 'Connection timed out',
              'error.type': 'TimeoutError',
            });
          });

          // Connection closed before establishing
          socket.once('close', (hadError: boolean) => {
            if (hadError) {
              endOnce(500, {
                'error.message': 'Connection closed with error',
              });
            } else {
              endOnce(0);
            }
          });

          return socket;
        });
      }
  );
};

/**
 * Patch net.connect() and net.createConnection() factory functions.
 * These create a new Socket and immediately call socket.connect().
 * Since we patch Socket.prototype.connect, these are automatically covered.
 * However, we add a thin wrapper for consistency in span naming.
 */
const patchNetFactories = (netModule: any, options?: SenzorOptions) => {
  // net.connect and net.createConnection are usually the same function
  // Since we patch Socket.prototype.connect, the factory functions are
  // automatically instrumented. No additional patching needed.
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
  patchNetFactories(net, options);
};
