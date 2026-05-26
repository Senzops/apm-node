import { getSqlOperation, normalizeSql } from '../core/sanitizer';
import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// Knex.js Instrumentation
//
// Instruments the Knex query builder at two layers:
//   1. Client.prototype.query() — the final execution point for all queries.
//      Every .select(), .insert(), .where().update(), raw(), etc. funnels
//      through this method before hitting the underlying driver (pg, mysql,
//      sqlite3, mssql, oracledb).
//
//   2. Client.prototype._stream() — covers streaming queries.
//
// Captured span attributes (OTel semantic conventions):
//   - db.system.name: derived from client dialect (pg, mysql, sqlite3, etc.)
//   - db.operation.name: SELECT, INSERT, UPDATE, DELETE, etc.
//   - db.query.text: parameterized/normalized SQL
//   - db.collection.name: table name if detectable
//   - knex.method: Knex builder method (select, insert, update, del, raw)
// ---------------------------------------------------------------------------

/** Map knex dialect names to OTel db.system.name values. */
const DIALECT_MAP: Record<string, string> = {
  pg: 'postgresql',
  'pg-native': 'postgresql',
  mysql: 'mysql',
  mysql2: 'mysql',
  sqlite3: 'sqlite',
  'better-sqlite3': 'sqlite',
  mssql: 'mssql',
  oracledb: 'oracle',
  oracle: 'oracle',
  redshift: 'redshift',
  cockroachdb: 'cockroachdb',
};

/** Extract the database system from a Knex client instance. */
const getDbSystem = (client: any): string => {
  const dialect = client?.config?.client
    || client?.dialect
    || client?.driverName
    || 'unknown';

  const normalized = typeof dialect === 'string' ? dialect.toLowerCase() : 'unknown';
  return DIALECT_MAP[normalized] || normalized;
};

/** Extract table name from SQL statement. */
const extractTableName = (sql: string | undefined): string | undefined => {
  if (!sql) return undefined;
  // Match FROM table, INTO table, UPDATE table, JOIN table
  const match = sql.match(
    /(?:FROM|INTO|UPDATE|JOIN)\s+[`"[\]]?(\w+)[`"\]]?/i
  );
  return match?.[1] || undefined;
};

// ---------------------------------------------------------------------------
// Client.prototype.query patching
// ---------------------------------------------------------------------------

const patchKnexClient = (knexModule: any, options?: SenzorOptions) => {
  // Knex exports a factory function. The Client base class is at:
  //   knex.Client (in some versions)
  //   require('knex/lib/client') (internal)
  // We also intercept the factory to patch client instances.

  let ClientClass: any;

  // Try to get Client from the module
  ClientClass = knexModule?.Client;

  // Try the internal path
  if (!ClientClass) {
    try {
      ClientClass = require('knex/lib/client');
    } catch { }
  }

  if (!ClientClass?.prototype) return;

  // Patch query() — the core execution method
  patchMethod(
    ClientClass.prototype,
    'query',
    'senzor.knex.client.query',
    (original) =>
      function patchedQuery(this: any, connection: any, queryObj: any) {
        // queryObj contains { sql, bindings, method, options, ... }
        const sql = queryObj?.sql;
        const method = queryObj?.method || 'raw';
        const operation = getSqlOperation(sql) || method.toUpperCase();
        const dbSystem = getDbSystem(this);
        const tableName = extractTableName(sql);

        const span = startCapturedSpan(
          `Knex ${operation}`,
          'db',
          {
            'db.system.name': dbSystem,
            'db.operation.name': operation,
            'db.query.text': normalizeSql(sql, options),
            'db.collection.name': tableName,
            'knex.method': method,
            library: 'knex',
          },
          options
        );

        if (!span) return original.call(this, connection, queryObj);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.call(this, connection, queryObj);

            if (result && typeof result.then === 'function') {
              return result.then(
                (value: any) => {
                  const rowCount = Array.isArray(value)
                    ? value.length
                    : value?.rowCount ?? value?.affectedRows;

                  span.end(0, {
                    'db.response.row_count': rowCount,
                  });
                  return value;
                },
                (error: any) => {
                  span.end(500, {
                    'error.message': error?.message,
                    'error.type': error?.name || 'Error',
                    'db.error.code': error?.code,
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
              'db.error.code': error?.code,
            });
            throw error;
          }
        });
      }
  );

  // Patch _stream() — for streaming queries
  if (typeof ClientClass.prototype._stream === 'function') {
    patchMethod(
      ClientClass.prototype,
      '_stream',
      'senzor.knex.client._stream',
      (original) =>
        function patchedStream(this: any, connection: any, queryObj: any, stream: any, streamOptions: any) {
          const sql = queryObj?.sql;
          const operation = getSqlOperation(sql) || 'STREAM';
          const dbSystem = getDbSystem(this);

          const span = startCapturedSpan(
            `Knex STREAM ${operation}`,
            'db',
            {
              'db.system.name': dbSystem,
              'db.operation.name': `STREAM_${operation}`,
              'db.query.text': normalizeSql(sql, options),
              'knex.method': 'stream',
              library: 'knex',
            },
            options
          );

          if (!span) return original.call(this, connection, queryObj, stream, streamOptions);

          return runWithCapturedSpan(span, () => {
            try {
              const result = original.call(this, connection, queryObj, stream, streamOptions);

              if (result && typeof result.then === 'function') {
                return result.then(
                  (value: any) => { span.end(0); return value; },
                  (error: any) => {
                    span.end(500, { 'error.message': error?.message });
                    throw error;
                  }
                );
              }

              span.end(0);
              return result;
            } catch (error: any) {
              span.end(500, { 'error.message': error?.message });
              throw error;
            }
          });
        }
    );
  }
};

// ---------------------------------------------------------------------------
// Factory wrapping — ensure clients created via knex() get patched
// ---------------------------------------------------------------------------

const patchKnexFactory = (knexModule: any, options?: SenzorOptions) => {
  if (typeof knexModule !== 'function') return;

  // Knex's default export is the factory function
  // We can't replace the module export, but Client.prototype is shared
  // across all instances, so patching the prototype is sufficient.

  // Also try to patch via the factory's client property
  if (knexModule.Client?.prototype) {
    patchKnexClient(knexModule, options);
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentKnex = (options?: SenzorOptions) => {
  hookRequire('knex', (exports: any) => {
    patchKnexFactory(exports, options);
    patchKnexClient(exports, options);

    // Handle default exports
    if (exports?.default) {
      patchKnexFactory(exports.default, options);
      patchKnexClient(exports.default, options);
    }
  });

  // Also try the internal client module directly
  hookRequire('knex/lib/client', (exports: any) => {
    if (exports?.prototype) {
      patchKnexClient({ Client: exports }, options);
    }
  });
};
