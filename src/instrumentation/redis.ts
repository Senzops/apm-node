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

const patchSendCommand = (
  target: any,
  label: string,
  options?: SenzorOptions
) => {
  patchMethod(
    target,
    'sendCommand',
    `senzor.redis.${label}.sendCommand`,
    (original) =>
      function patchedRedisSendCommand(this: any, command: any, ...args: any[]) {
        const commandName = getCommandName(command);
        const span = startCapturedSpan(
          `Redis ${commandName}`,
          'db',
          {
            command: commandName,
            operation: commandName,
            'db.system.name': label === 'ioredis' ? 'redis' : 'redis',
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
      }
  );
};

const patchCreatedClient = (
  client: any,
  label: string,
  options?: SenzorOptions
) => {
  patchSendCommand(client, label, options);
  patchSendCommand(Object.getPrototypeOf(client), label, options);
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

const patchIORedisPackage = (ioredis: any, options?: SenzorOptions) => {
  patchSendCommand(ioredis?.prototype, 'ioredis', options);
  patchSendCommand(ioredis?.Redis?.prototype, 'ioredis', options);
  patchSendCommand(ioredis?.Cluster?.prototype, 'ioredis-cluster', options);
  patchSendCommand(ioredis?.default?.prototype, 'ioredis', options);
};

export const instrumentRedis = (options?: SenzorOptions) => {
  hookRequire('redis', (exports: any) => patchRedisPackage(exports, options));
  hookRequire('ioredis', (exports: any) => patchIORedisPackage(exports, options));
};
