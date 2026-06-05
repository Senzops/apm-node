import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

const getCommandName = (command: any): string => {
  if (typeof command === 'string') return command.toUpperCase();
  if (Array.isArray(command)) return String(command[0] || 'COMMAND').toUpperCase();
  if (command?.name) return String(command.name).toUpperCase();
  if (Array.isArray(command?.args)) return String(command.args[0] || 'COMMAND').toUpperCase();
  return 'COMMAND';
};

// ---------------------------------------------------------------------------
// BullMQ Detection
// ---------------------------------------------------------------------------
// BullMQ requires `maxRetriesPerRequest: null` on every ioredis connection it
// creates. Normal application ioredis instances never set this (default is 20).
// We use this as a reliable signal to skip instrumentation on BullMQ's internal
// connections, which prevents interference with BullMQ's lock renewal timers.
const SKIP_FLAG = Symbol.for('senzor.redis.skip');

const isBullMQConnection = (instance: any): boolean => {
  if (instance?.[SKIP_FLAG]) return true;
  try {
    const opts = instance?.options || instance?.__redisOptions;
    if (opts && opts.maxRetriesPerRequest === null) {
      instance[SKIP_FLAG] = true;
      return true;
    }
  } catch {}
  return false;
};

// ---------------------------------------------------------------------------
// Per-Instance sendCommand Patch
// ---------------------------------------------------------------------------

const INSTANCE_PATCHED = Symbol.for('senzor.redis.instance.patched');

const patchInstanceSendCommand = (
  instance: any,
  label: string,
  options?: SenzorOptions
) => {
  if (!instance || instance[INSTANCE_PATCHED]) return;
  if (typeof instance.sendCommand !== 'function') return;

  const original = instance.sendCommand;

  instance.sendCommand = function patchedRedisSendCommand(command: any, ...args: any[]) {
    const commandName = getCommandName(command);
    const span = startCapturedSpan(
      `Redis ${commandName}`,
      'db',
      {
        command: commandName,
        operation: commandName,
        'db.system.name': 'redis',
        'db.operation.name': commandName,
        library: label
      },
      options
    );

    if (!span) return original.apply(this, arguments as any);

    return runWithCapturedSpan(span, () => {
      try {
        const result = original.call(this, command, ...args);
        if (result && typeof result.then === 'function') {
          return result.then(
            (value: any) => {
              span.end(0);
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

        span.end(0);
        return result;
      } catch (error: any) {
        span.end(500, {
          error: error?.message,
          'error.type': error?.name || 'Error'
        });
        throw error;
      }
    });
  };

  Object.defineProperty(instance, INSTANCE_PATCHED, { value: true, enumerable: false });
};

// ---------------------------------------------------------------------------
// node-redis (createClient / createCluster)
// ---------------------------------------------------------------------------

const patchCreatedClient = (
  client: any,
  label: string,
  options?: SenzorOptions
) => {
  patchInstanceSendCommand(client, label, options);
  return client;
};

const patchRedisPackage = (redis: any, options?: SenzorOptions) => {
  ['createClient', 'createCluster'].forEach((factory) => {
    patchMethod(
      redis,
      factory,
      `senzor.redis.${factory}`,
      (original) =>
        function patchedRedisFactory(this: any, ...args: any[]) {
          const client = original.apply(this, args);
          return patchCreatedClient(client, 'redis', options);
        }
    );
  });
};

// ---------------------------------------------------------------------------
// ioredis — Constructor-level hook (skip BullMQ connections)
// ---------------------------------------------------------------------------

const patchIORedisPackage = (ioredis: any, options?: SenzorOptions) => {
  // Patch the constructor to intercept instance creation.
  // BullMQ connections (maxRetriesPerRequest: null) are detected and skipped.
  // All other connections get per-instance sendCommand instrumentation.
  const targets = [ioredis, ioredis?.default, ioredis?.Redis].filter(Boolean);

  for (const target of targets) {
    if (!target?.prototype || target.__senzorConstructorPatched) continue;

    const OriginalConstructor = target;

    // Intercept 'connect' and 'ready' events to patch after construction
    // because ioredis options aren't fully resolved until after super() completes.
    const originalConnect = target.prototype.connect;
    if (typeof originalConnect === 'function' && !target.prototype.__senzorConnectPatched) {
      target.prototype.connect = function patchedConnect(this: any, ...args: any[]) {
        if (!isBullMQConnection(this)) {
          patchInstanceSendCommand(this, 'ioredis', options);
        }
        return originalConnect.apply(this, args);
      };
      target.prototype.__senzorConnectPatched = true;
    }

    // Also patch on the 'ready' event for lazy-connect instances
    const originalOn = target.prototype.on;
    if (typeof originalOn === 'function' && !target.prototype.__senzorOnPatched) {
      target.prototype.on = function patchedOn(this: any, event: string, ...args: any[]) {
        // Patch on first event registration — instance options are resolved by now
        if (!this[INSTANCE_PATCHED] && !isBullMQConnection(this)) {
          patchInstanceSendCommand(this, 'ioredis', options);
        }
        return originalOn.call(this, event, ...args);
      };
      target.prototype.__senzorOnPatched = true;
    }

    target.__senzorConstructorPatched = true;
  }

  // Cluster client — same pattern
  if (ioredis?.Cluster?.prototype && !ioredis.Cluster.__senzorConstructorPatched) {
    const clusterProto = ioredis.Cluster.prototype;
    const originalClusterConnect = clusterProto.connect;
    if (typeof originalClusterConnect === 'function') {
      clusterProto.connect = function patchedClusterConnect(this: any, ...args: any[]) {
        patchInstanceSendCommand(this, 'ioredis-cluster', options);
        return originalClusterConnect.apply(this, args);
      };
    }
    ioredis.Cluster.__senzorConstructorPatched = true;
  }
};

export const instrumentRedis = (options?: SenzorOptions) => {
  hookRequire('redis', (exports: any) => patchRedisPackage(exports, options));
  hookRequire('ioredis', (exports: any) => patchIORedisPackage(exports, options));
};
