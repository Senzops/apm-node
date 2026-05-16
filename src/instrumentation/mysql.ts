import { getSqlOperation, normalizeSql } from '../core/sanitizer';
import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

const extractSql = (args: any[]): string | undefined => {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first && typeof first.sql === 'string') return first.sql;
  return undefined;
};

const patchSqlMethod = (
  proto: any,
  method: 'query' | 'execute',
  library: string,
  options?: SenzorOptions
) => {
  patchMethod(
    proto,
    method,
    `senzor.${library}.${method}`,
    (original) =>
      function patchedMysqlMethod(this: any, ...args: any[]) {
        const sql = extractSql(args);
        const operation = getSqlOperation(sql) || method.toUpperCase();
        const span = startCapturedSpan(
          `MySQL ${operation}`,
          'db',
          {
            query: normalizeSql(sql, options),
            operation,
            'db.system.name': 'mysql',
            'db.operation.name': operation,
            'db.query.text': normalizeSql(sql, options),
            library
          },
          options
        );

        if (!span) return original.apply(this, args);

        const callbackIndex = args.findIndex(
          (arg) => typeof arg === 'function'
        );
        if (callbackIndex >= 0) {
          const originalCallback = args[callbackIndex];
          args[callbackIndex] = function wrappedMysqlCallback(
            this: unknown,
            err: any,
            rows: any
          ) {
            span.end(err ? 500 : 0, {
              error: err?.message,
              'error.type': err?.name,
              rowCount: Array.isArray(rows) ? rows.length : undefined
            });
            return originalCallback.apply(this, arguments as any);
          };
        }

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.apply(this, args);

            if (result && typeof result.then === 'function') {
              return result.then(
                (value: any) => {
                  const rows = Array.isArray(value) ? value[0] : value;
                  span.end(0, {
                    rowCount: Array.isArray(rows) ? rows.length : undefined
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

            if (
              callbackIndex < 0 &&
              result &&
              typeof result.once === 'function'
            ) {
              result.once('end', () => span.end(0));
              result.once('error', (error: Error) =>
                span.end(500, {
                  error: error.message,
                  'error.type': error.name
                })
              );
            } else if (callbackIndex < 0) {
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

const patchKnownPrototypes = (
  mysql: any,
  library: string,
  options?: SenzorOptions
) => {
  [
    mysql?.Connection?.prototype,
    mysql?.Pool?.prototype,
    mysql?.PoolConnection?.prototype,
    mysql?.PromiseConnection?.prototype,
    mysql?.PromisePool?.prototype,
    mysql?.default?.Connection?.prototype,
    mysql?.default?.Pool?.prototype
  ].forEach((proto) => {
    patchSqlMethod(proto, 'query', library, options);
    patchSqlMethod(proto, 'execute', library, options);
  });
};

const patchFactories = (
  mysql: any,
  library: string,
  options?: SenzorOptions
) => {
  ['createConnection', 'createPool'].forEach((factory) => {
    patchMethod(
      mysql,
      factory,
      `senzor.${library}.${factory}`,
      (original) =>
        function patchedMysqlFactory(this: any, ...args: any[]) {
          const client = original.apply(this, args);
          patchSqlMethod(client, 'query', library, options);
          patchSqlMethod(client, 'execute', library, options);
          patchSqlMethod(Object.getPrototypeOf(client), 'query', library, options);
          patchSqlMethod(Object.getPrototypeOf(client), 'execute', library, options);
          return client;
        }
    );
  });
};

const patchMysql = (
  mysql: any,
  library: string,
  options?: SenzorOptions
) => {
  patchKnownPrototypes(mysql, library, options);
  patchFactories(mysql, library, options);
};

export const instrumentMysql = (options?: SenzorOptions) => {
  hookRequire('mysql', (exports: any) => patchMysql(exports, 'mysql', options));
  hookRequire('mysql2', (exports: any) => patchMysql(exports, 'mysql2', options));
};
