import { getSqlOperation, normalizeSql } from '../core/sanitizer';
import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// Tedious (SQL Server / MSSQL) Instrumentation
//
// Instruments the `tedious` package — the primary pure-JS driver for
// Microsoft SQL Server used by node-mssql, Knex (mssql dialect),
// TypeORM, Sequelize, and Prisma (sqlserver provider).
//
// Patches Connection.prototype methods:
//   - execSql()       — standard parameterized queries
//   - execSqlBatch()  — raw SQL batch execution
//   - execBulkLoad()  — bulk insert operations
//   - callProcedure() — stored procedure calls
//   - prepare()       — prepared statement creation
//   - execute()       — prepared statement execution
//
// Also instruments `mssql` (node-mssql) — the popular high-level wrapper
// around tedious — by patching Request.prototype.query/execute/batch.
//
// Captured attributes (OTel semantic conventions):
//   - db.system.name: 'mssql'
//   - db.operation.name: operation type
//   - db.query.text: normalized SQL
//   - db.namespace: database name
//   - server.address: SQL Server hostname
//   - server.port: SQL Server port
// ---------------------------------------------------------------------------

/** Extract connection metadata from a tedious Connection instance. */
const getConnectionMeta = (connection: any): Record<string, any> => {
  const config = connection?.config;
  if (!config) return {};

  const meta: Record<string, any> = {
    'db.system.name': 'mssql',
  };

  if (config.server) meta['server.address'] = config.server;
  if (config.options?.port) meta['server.port'] = config.options.port;
  if (config.options?.database) meta['db.namespace'] = config.options.database;

  return meta;
};

// ---------------------------------------------------------------------------
// Connection method patching
// ---------------------------------------------------------------------------

const patchTediousConnection = (tedious: any, options?: SenzorOptions) => {
  const Connection = tedious?.Connection;
  if (!Connection?.prototype) return;

  const proto = Connection.prototype;

  // --- execSql(request) ---
  patchMethod(
    proto,
    'execSql',
    'senzor.tedious.connection.execSql',
    (original) =>
      function patchedExecSql(this: any, request: any) {
        const sql = request?.sqlTextOrProcedure;
        const operation = getSqlOperation(sql) || 'QUERY';
        const connMeta = getConnectionMeta(this);

        const span = startCapturedSpan(
          `MSSQL ${operation}`,
          'db',
          {
            ...connMeta,
            'db.operation.name': operation,
            'db.query.text': normalizeSql(sql, options),
            'tedious.method': 'execSql',
            library: 'tedious',
          },
          options
        );

        if (!span) return original.call(this, request);

        return runWithCapturedSpan(span, () => {
          wrapTediousRequest(request, span);
          return original.call(this, request);
        });
      }
  );

  // --- execSqlBatch(request) ---
  patchMethod(
    proto,
    'execSqlBatch',
    'senzor.tedious.connection.execSqlBatch',
    (original) =>
      function patchedExecSqlBatch(this: any, request: any) {
        const sql = request?.sqlTextOrProcedure;
        const operation = getSqlOperation(sql) || 'BATCH';
        const connMeta = getConnectionMeta(this);

        const span = startCapturedSpan(
          `MSSQL BATCH ${operation}`,
          'db',
          {
            ...connMeta,
            'db.operation.name': `BATCH_${operation}`,
            'db.query.text': normalizeSql(sql, options),
            'tedious.method': 'execSqlBatch',
            library: 'tedious',
          },
          options
        );

        if (!span) return original.call(this, request);

        return runWithCapturedSpan(span, () => {
          wrapTediousRequest(request, span);
          return original.call(this, request);
        });
      }
  );

  // --- callProcedure(request) ---
  patchMethod(
    proto,
    'callProcedure',
    'senzor.tedious.connection.callProcedure',
    (original) =>
      function patchedCallProcedure(this: any, request: any) {
        const procName = request?.sqlTextOrProcedure || 'unknown';
        const connMeta = getConnectionMeta(this);

        const span = startCapturedSpan(
          `MSSQL CALL ${procName}`,
          'db',
          {
            ...connMeta,
            'db.operation.name': 'CALL',
            'db.query.text': procName,
            'db.collection.name': procName,
            'tedious.method': 'callProcedure',
            library: 'tedious',
          },
          options
        );

        if (!span) return original.call(this, request);

        return runWithCapturedSpan(span, () => {
          wrapTediousRequest(request, span);
          return original.call(this, request);
        });
      }
  );

  // --- execBulkLoad(bulkLoad, rows, callback) ---
  patchMethod(
    proto,
    'execBulkLoad',
    'senzor.tedious.connection.execBulkLoad',
    (original) =>
      function patchedExecBulkLoad(this: any, bulkLoad: any, ...args: any[]) {
        const tableName = bulkLoad?.table || 'unknown';
        const connMeta = getConnectionMeta(this);

        const span = startCapturedSpan(
          `MSSQL BULK INSERT ${tableName}`,
          'db',
          {
            ...connMeta,
            'db.operation.name': 'BULK_INSERT',
            'db.collection.name': tableName,
            'tedious.method': 'execBulkLoad',
            library: 'tedious',
          },
          options
        );

        if (!span) return original.call(this, bulkLoad, ...args);

        return runWithCapturedSpan(span, () => {
          // Wrap the bulkLoad callback
          if (bulkLoad && typeof bulkLoad.callback === 'function') {
            const originalCallback = bulkLoad.callback;
            bulkLoad.callback = function (err: any, rowCount: any) {
              if (err) {
                span.end(500, {
                  'error.message': err.message,
                  'error.type': err.name || 'Error',
                });
              } else {
                span.end(0, { 'db.response.row_count': rowCount });
              }
              return originalCallback.call(this, err, rowCount);
            };
          } else {
            // If no callback on bulkLoad, try wrapping the last arg
            const lastIdx = args.length - 1;
            if (lastIdx >= 0 && typeof args[lastIdx] === 'function') {
              const cb = args[lastIdx];
              args[lastIdx] = function (err: any, rowCount: any) {
                if (err) {
                  span.end(500, { 'error.message': err.message });
                } else {
                  span.end(0, { 'db.response.row_count': rowCount });
                }
                return cb.apply(this, arguments);
              };
            } else {
              span.end(0);
            }
          }

          return original.call(this, bulkLoad, ...args);
        });
      }
  );

  // --- prepare(request) ---
  if (typeof proto.prepare === 'function') {
    patchMethod(
      proto,
      'prepare',
      'senzor.tedious.connection.prepare',
      (original) =>
        function patchedPrepare(this: any, request: any) {
          const sql = request?.sqlTextOrProcedure;
          const connMeta = getConnectionMeta(this);

          const span = startCapturedSpan(
            `MSSQL PREPARE`,
            'db',
            {
              ...connMeta,
              'db.operation.name': 'PREPARE',
              'db.query.text': normalizeSql(sql, options),
              'tedious.method': 'prepare',
              library: 'tedious',
            },
            options
          );

          if (!span) return original.call(this, request);

          return runWithCapturedSpan(span, () => {
            wrapTediousRequest(request, span);
            return original.call(this, request);
          });
        }
    );
  }

  // --- execute(request, parameters) ---
  if (typeof proto.execute === 'function') {
    patchMethod(
      proto,
      'execute',
      'senzor.tedious.connection.execute',
      (original) =>
        function patchedExecute(this: any, request: any, parameters: any) {
          const sql = request?.sqlTextOrProcedure;
          const operation = getSqlOperation(sql) || 'EXECUTE';
          const connMeta = getConnectionMeta(this);

          const span = startCapturedSpan(
            `MSSQL EXECUTE ${operation}`,
            'db',
            {
              ...connMeta,
              'db.operation.name': `EXECUTE_${operation}`,
              'db.query.text': normalizeSql(sql, options),
              'tedious.method': 'execute',
              library: 'tedious',
            },
            options
          );

          if (!span) return original.call(this, request, parameters);

          return runWithCapturedSpan(span, () => {
            wrapTediousRequest(request, span);
            return original.call(this, request, parameters);
          });
        }
    );
  }
};

// ---------------------------------------------------------------------------
// Tedious Request callback wrapping
// ---------------------------------------------------------------------------

/** Wrap a tedious Request's completion callback to end the span. */
const wrapTediousRequest = (request: any, span: any) => {
  if (!request || !span) return;

  // Tedious Request uses an event-based completion model
  // The 'requestCompleted' callback is the final callback passed to the Request constructor
  if (typeof request.callback === 'function') {
    const originalCallback = request.callback;
    request.callback = function (err: any, rowCount: any, rows: any) {
      if (err) {
        span.end(500, {
          'error.message': err.message,
          'error.type': err.name || 'RequestError',
          'db.error.code': err.code,
        });
      } else {
        span.end(0, {
          'db.response.row_count': rowCount,
        });
      }
      return originalCallback.call(this, err, rowCount, rows);
    };
    return;
  }

  // Fallback: listen for events
  if (typeof request.on === 'function') {
    let ended = false;
    request.on('requestCompleted', () => {
      if (!ended) { ended = true; span.end(0); }
    });
    request.on('error', (err: any) => {
      if (!ended) {
        ended = true;
        span.end(500, { 'error.message': err?.message });
      }
    });
  }
};

// ---------------------------------------------------------------------------
// node-mssql (mssql) wrapper patching
// ---------------------------------------------------------------------------

const patchMssql = (mssql: any, options?: SenzorOptions) => {
  // mssql exports Request, ConnectionPool, etc.
  const RequestClass = mssql?.Request;
  if (!RequestClass?.prototype) return;

  const proto = RequestClass.prototype;

  // Patch Request.prototype.query(sql)
  patchMethod(
    proto,
    'query',
    'senzor.mssql.request.query',
    (original) =>
      function patchedMssqlQuery(this: any, sql: string) {
        const operation = getSqlOperation(sql) || 'QUERY';

        const span = startCapturedSpan(
          `MSSQL ${operation}`,
          'db',
          {
            'db.system.name': 'mssql',
            'db.operation.name': operation,
            'db.query.text': normalizeSql(sql, options),
            library: 'mssql',
          },
          options
        );

        if (!span) return original.call(this, sql);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.call(this, sql);

            if (result && typeof result.then === 'function') {
              return result.then(
                (value: any) => {
                  span.end(0, {
                    'db.response.row_count': value?.recordset?.length ?? value?.rowsAffected?.[0],
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
            span.end(500, { 'error.message': error?.message });
            throw error;
          }
        });
      }
  );

  // Patch Request.prototype.execute(procedure)
  patchMethod(
    proto,
    'execute',
    'senzor.mssql.request.execute',
    (original) =>
      function patchedMssqlExecute(this: any, procedure: string) {
        const span = startCapturedSpan(
          `MSSQL CALL ${procedure}`,
          'db',
          {
            'db.system.name': 'mssql',
            'db.operation.name': 'CALL',
            'db.query.text': procedure,
            'db.collection.name': procedure,
            library: 'mssql',
          },
          options
        );

        if (!span) return original.call(this, procedure);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.call(this, procedure);

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

  // Patch Request.prototype.batch(sql)
  if (typeof proto.batch === 'function') {
    patchMethod(
      proto,
      'batch',
      'senzor.mssql.request.batch',
      (original) =>
        function patchedMssqlBatch(this: any, sql: string) {
          const operation = getSqlOperation(sql) || 'BATCH';

          const span = startCapturedSpan(
            `MSSQL BATCH ${operation}`,
            'db',
            {
              'db.system.name': 'mssql',
              'db.operation.name': `BATCH_${operation}`,
              'db.query.text': normalizeSql(sql, options),
              library: 'mssql',
            },
            options
          );

          if (!span) return original.call(this, sql);

          return runWithCapturedSpan(span, () => {
            try {
              const result = original.call(this, sql);
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
// Public API
// ---------------------------------------------------------------------------

export const instrumentTedious = (options?: SenzorOptions) => {
  hookRequire('tedious', (exports: any) => {
    patchTediousConnection(exports, options);
  });

  hookRequire('mssql', (exports: any) => {
    patchMssql(exports, options);
  });
};
