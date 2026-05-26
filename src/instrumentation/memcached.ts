import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// Memcached Instrumentation
//
// Instruments the `memcached` npm package (the most popular pure-JS
// Memcached client for Node.js, used by production deployments).
//
// Patches Memcached.prototype command methods:
//   - get(), gets(), getMulti()        — read operations
//   - set(), add(), replace(), cas()   — write operations
//   - append(), prepend()              — mutation operations
//   - incr(), decr()                   — counter operations
//   - del() / delete()                 — delete operations
//   - touch()                          — TTL refresh
//   - stats(), version(), items()      — admin/info operations
//   - flush()                          — cache flush
//
// All memcached operations are callback-based. The callback is always
// the last argument: fn(err, result).
//
// Captured attributes (OTel semantic conventions):
//   - db.system.name: 'memcached'
//   - db.operation.name: GET, SET, DELETE, etc.
//   - db.memcached.key: cache key (if single key)
//   - db.memcached.key_count: number of keys (for multi-key ops)
//   - server.address: memcached server(s)
// ---------------------------------------------------------------------------

/** Commands to instrument, grouped by signature pattern. */
const KEY_VALUE_COMMANDS = ['set', 'add', 'replace', 'append', 'prepend'] as const;
const KEY_ONLY_COMMANDS = ['get', 'gets', 'del', 'delete', 'touch'] as const;
const KEY_NUMBER_COMMANDS = ['incr', 'decr'] as const;
const CAS_COMMAND = ['cas'] as const;
const MULTI_KEY_COMMANDS = ['getMulti'] as const;
const NO_KEY_COMMANDS = ['stats', 'version', 'items', 'flush'] as const;

/** Get server address string from a Memcached instance. */
const getServerAddress = (client: any): string | undefined => {
  try {
    const servers = client?.servers;
    if (Array.isArray(servers) && servers.length > 0) {
      return servers.length === 1 ? servers[0] : `${servers[0]} (+${servers.length - 1})`;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// Generic command wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a callback-based memcached command.
 * The callback is always the last argument in memcached commands.
 */
const wrapCommand = (
  proto: any,
  commandName: string,
  getSpanMeta: (args: any[]) => Record<string, any>,
  options?: SenzorOptions
) => {
  if (typeof proto[commandName] !== 'function') return;

  patchMethod(
    proto,
    commandName,
    `senzor.memcached.${commandName}`,
    (original) =>
      function patchedCommand(this: any, ...args: any[]) {
        const operation = commandName.toUpperCase();
        const serverAddress = getServerAddress(this);
        const extraMeta = getSpanMeta(args);

        const span = startCapturedSpan(
          `Memcached ${operation}`,
          'db',
          {
            'db.system.name': 'memcached',
            'db.operation.name': operation,
            'server.address': serverAddress,
            library: 'memcached',
            ...extraMeta,
          },
          options
        );

        if (!span) return original.apply(this, args);

        // Wrap the callback (always last argument)
        const callbackIndex = args.length - 1;
        if (callbackIndex >= 0 && typeof args[callbackIndex] === 'function') {
          const originalCb = args[callbackIndex];
          args[callbackIndex] = function (err: any, ...results: any[]) {
            if (err) {
              span.end(500, {
                'error.message': typeof err === 'string' ? err : err?.message,
                'error.type': err?.name || 'MemcachedError',
              });
            } else {
              span.end(0);
            }
            return originalCb.call(this, err, ...results);
          };
        } else {
          // No callback — end span immediately
          span.end(0);
        }

        return runWithCapturedSpan(span, () => {
          try {
            return original.apply(this, args);
          } catch (error: any) {
            span.end(500, { 'error.message': error?.message });
            throw error;
          }
        });
      }
  );
};

// ---------------------------------------------------------------------------
// Memcached prototype patching
// ---------------------------------------------------------------------------

const patchMemcachedClient = (Memcached: any, options?: SenzorOptions) => {
  const proto = Memcached?.prototype;
  if (!proto) return;

  // key-value commands: command(key, value, lifetime, callback)
  for (const cmd of KEY_VALUE_COMMANDS) {
    wrapCommand(proto, cmd, (args) => ({
      'db.memcached.key': typeof args[0] === 'string' ? args[0] : undefined,
    }), options);
  }

  // key-only commands: command(key, callback) or command(key, ttl, callback)
  for (const cmd of KEY_ONLY_COMMANDS) {
    wrapCommand(proto, cmd, (args) => ({
      'db.memcached.key': typeof args[0] === 'string' ? args[0] : undefined,
    }), options);
  }

  // key-number commands: command(key, amount, callback)
  for (const cmd of KEY_NUMBER_COMMANDS) {
    wrapCommand(proto, cmd, (args) => ({
      'db.memcached.key': typeof args[0] === 'string' ? args[0] : undefined,
    }), options);
  }

  // cas: cas(key, value, cas, lifetime, callback)
  for (const cmd of CAS_COMMAND) {
    wrapCommand(proto, cmd, (args) => ({
      'db.memcached.key': typeof args[0] === 'string' ? args[0] : undefined,
    }), options);
  }

  // multi-key commands: command(keys, callback) where keys is string[]
  for (const cmd of MULTI_KEY_COMMANDS) {
    wrapCommand(proto, cmd, (args) => ({
      'db.memcached.key_count': Array.isArray(args[0]) ? args[0].length : undefined,
    }), options);
  }

  // no-key commands: command(callback)
  for (const cmd of NO_KEY_COMMANDS) {
    wrapCommand(proto, cmd, () => ({}), options);
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentMemcached = (options?: SenzorOptions) => {
  hookRequire('memcached', (exports: any) => {
    // memcached exports the constructor directly
    patchMemcachedClient(exports, options);

    // Handle default export
    if (exports?.default?.prototype) {
      patchMemcachedClient(exports.default, options);
    }
  });
};
