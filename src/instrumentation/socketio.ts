import { Context } from '../core/context';
import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod, isPatched } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// Socket.IO Instrumentation
//
// Instruments socket.io (server-side):
//   - Socket.prototype.emit()  — outbound event spans (server → client)
//   - Socket.prototype.on()    — wraps event handlers with receive spans
//   - Namespace.prototype.emit() — broadcast event spans
//
// Instruments socket.io-client (client-side):
//   - Socket.prototype.emit()  — outbound event spans (client → server)
//   - Socket.prototype.on()    — wraps event handlers with receive spans
//
// Follows OTel messaging semantic conventions:
//   messaging.system = socket.io
//   messaging.destination.name = event name
//   messaging.operation.name = send | receive
// ---------------------------------------------------------------------------

/** Events to never instrument (internal socket.io events). */
const IGNORED_EVENTS = new Set([
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'newListener',
  'removeListener',
  'error',
  'ping',
  'pong',
  'connection',
]);

/** Check if an event should be instrumented. */
const shouldInstrument = (event: string): boolean => {
  if (typeof event !== 'string') return false;
  return !IGNORED_EVENTS.has(event);
};

// ---------------------------------------------------------------------------
// Emit patching (outbound events)
// ---------------------------------------------------------------------------

const patchEmit = (
  proto: any,
  patchKey: string,
  side: 'server' | 'client',
  options?: SenzorOptions
) => {
  patchMethod(
    proto,
    'emit',
    patchKey,
    (original) =>
      function patchedEmit(this: any, event: string, ...args: any[]) {
        if (!shouldInstrument(event)) {
          return original.call(this, event, ...args);
        }

        const trace = Context.current();
        if (!trace) return original.call(this, event, ...args);

        const namespace = this.nsp?.name || this.name || '/';

        const span = startCapturedSpan(
          `Socket.IO ${side} emit ${event}`,
          'messaging',
          {
            'messaging.system': 'socket.io',
            'messaging.destination.name': event,
            'messaging.operation.name': 'send',
            'messaging.socketio.namespace': namespace,
            'messaging.socketio.side': side,
            'messaging.socketio.event': event,
          },
          options
        );

        if (!span) return original.call(this, event, ...args);

        // Check if last arg is an acknowledgement callback
        const lastArg = args[args.length - 1];
        const hasAck = typeof lastArg === 'function';

        if (hasAck) {
          const originalAck = lastArg;
          args[args.length - 1] = function wrappedAck(...ackArgs: any[]) {
            span.end(0, { 'messaging.socketio.acknowledged': true });
            return originalAck.apply(this, ackArgs);
          };
        }

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.call(this, event, ...args);

            if (!hasAck) {
              // Fire-and-forget emit — end span immediately
              span.end(0);
            }

            return result;
          } catch (error: any) {
            span.end(500, {
              'error.message': error?.message,
              'error.type': error?.name || 'SocketIOError',
            });
            throw error;
          }
        });
      }
  );
};

// ---------------------------------------------------------------------------
// On patching (inbound event handlers)
// ---------------------------------------------------------------------------

const patchOn = (
  proto: any,
  patchKey: string,
  side: 'server' | 'client',
  options?: SenzorOptions
) => {
  patchMethod(
    proto,
    'on',
    patchKey,
    (original) =>
      function patchedOn(this: any, event: string, listener: any) {
        if (!shouldInstrument(event) || typeof listener !== 'function') {
          return original.call(this, event, listener);
        }

        const namespace = this.nsp?.name || this.name || '/';

        const wrappedListener = function (this: any, ...args: any[]) {
          const span = startCapturedSpan(
            `Socket.IO ${side} receive ${event}`,
            'messaging',
            {
              'messaging.system': 'socket.io',
              'messaging.destination.name': event,
              'messaging.operation.name': 'receive',
              'messaging.socketio.namespace': namespace,
              'messaging.socketio.side': side,
              'messaging.socketio.event': event,
            },
            options
          );

          if (!span) return listener.apply(this, args);

          return runWithCapturedSpan(span, () => {
            try {
              const result = listener.apply(this, args);

              // Handle async handlers
              if (result && typeof result.then === 'function') {
                return result.then(
                  (val: any) => {
                    span.end(0);
                    return val;
                  },
                  (error: any) => {
                    span.end(500, {
                      'error.message': error?.message,
                      'error.type': error?.name || 'Error',
                    });
                    throw error;
                  }
                );
              }

              span.end(0);
              return result;
            } catch (error: any) {
              span.end(500, {
                'error.message': error?.message,
                'error.type': error?.name || 'Error',
              });
              throw error;
            }
          });
        };

        // Preserve the original listener reference for removeListener support
        (wrappedListener as any).__senzorOriginal = listener;

        return original.call(this, event, wrappedListener);
      }
  );
};

// ---------------------------------------------------------------------------
// Server-side patching
// ---------------------------------------------------------------------------

const patchServerSocket = (socketio: any, options?: SenzorOptions) => {
  // Socket.prototype (individual socket)
  const SocketClass = socketio?.Socket;
  if (SocketClass?.prototype) {
    patchEmit(SocketClass.prototype, 'senzor.socketio.server.socket.emit', 'server', options);
    patchOn(SocketClass.prototype, 'senzor.socketio.server.socket.on', 'server', options);
  }

  // Namespace.prototype (broadcast to namespace/room)
  const NamespaceClass = socketio?.Namespace;
  if (NamespaceClass?.prototype) {
    patchEmit(NamespaceClass.prototype, 'senzor.socketio.server.namespace.emit', 'server', options);
  }
};

// ---------------------------------------------------------------------------
// Client-side patching
// ---------------------------------------------------------------------------

const patchClientSocket = (clientModule: any, options?: SenzorOptions) => {
  // socket.io-client exports a Socket class or io function
  const SocketClass = clientModule?.Socket || clientModule?.io?.Socket;
  if (SocketClass?.prototype) {
    patchEmit(SocketClass.prototype, 'senzor.socketio.client.emit', 'client', options);
    patchOn(SocketClass.prototype, 'senzor.socketio.client.on', 'client', options);
  }

  // Some versions export Manager too
  if (clientModule?.Manager?.prototype) {
    // Manager handles reconnection events, but we don't need to patch those
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentSocketIO = (options?: SenzorOptions) => {
  // Server-side socket.io
  hookRequire('socket.io', (exports: any) => {
    // socket.io exports a Server class. Socket and Namespace are properties of the module
    patchServerSocket(exports, options);

    // In some versions, Socket is exported from a sub-module
    if (!exports.Socket) {
      try {
        const socketModule = require('socket.io/dist/socket');
        if (socketModule?.Socket?.prototype) {
          patchEmit(socketModule.Socket.prototype, 'senzor.socketio.server.socket.emit', 'server', options);
          patchOn(socketModule.Socket.prototype, 'senzor.socketio.server.socket.on', 'server', options);
        }
      } catch { }
    }

    if (!exports.Namespace) {
      try {
        const nsModule = require('socket.io/dist/namespace');
        if (nsModule?.Namespace?.prototype) {
          patchEmit(nsModule.Namespace.prototype, 'senzor.socketio.server.namespace.emit', 'server', options);
        }
      } catch { }
    }
  });

  // Client-side socket.io-client
  hookRequire('socket.io-client', (exports: any) => {
    patchClientSocket(exports, options);
  });
};
