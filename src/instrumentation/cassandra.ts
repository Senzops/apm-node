import { getSqlOperation, normalizeSql } from '../core/sanitizer';
import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// Cassandra (cassandra-driver) Instrumentation
//
// Instruments the DataStax cassandra-driver for Apache Cassandra / ScyllaDB.
//
// Patches Client.prototype methods:
//   - execute()  — single query execution (parameterized)
//   - batch()    — batch query execution (multiple statements)
//   - eachRow()  — streaming row-by-row query
//   - stream()   — readable stream interface
//
// CQL (Cassandra Query Language) uses similar syntax to SQL for basic
// operations, so we reuse SQL extraction/normalization utilities.
//
// Captured attributes (OTel semantic conventions):
//   - db.system.name: 'cassandra'
//   - db.operation.name: SELECT, INSERT, UPDATE, DELETE, BATCH, etc.
//   - db.query.text: normalized CQL
//   - db.cassandra.consistency: consistency level used
//   - db.cassandra.coordinator.id: coordinator node address
//   - db.cassandra.page_size: page size for paged queries
//   - db.namespace: keyspace
//   - server.address: contact point
// ---------------------------------------------------------------------------

/** Map Cassandra consistency level numbers to names. */
const CONSISTENCY_NAMES: Record<number, string> = {
  0: 'any',
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'quorum',
  5: 'all',
  6: 'localQuorum',
  7: 'eachQuorum',
  8: 'serial',
  9: 'localSerial',
  10: 'localOne',
};

const getConsistencyName = (level: any): string | undefined => {
  if (typeof level === 'string') return level;
  if (typeof level === 'number') return CONSISTENCY_NAMES[level];
  return undefined;
};

/** Extract connection metadata from a Client instance. */
const getClientMeta = (client: any): Record<string, any> => {
  const meta: Record<string, any> = {
    'db.system.name': 'cassandra',
  };

  try {
    const options = client?.options;
    if (options?.keyspace) meta['db.namespace'] = options.keyspace;
    if (options?.contactPoints?.[0]) meta['server.address'] = options.contactPoints[0];
    if (options?.protocolOptions?.port) meta['server.port'] = options.protocolOptions.port;
    if (options?.localDataCenter) meta['db.cassandra.local_datacenter'] = options.localDataCenter;
  } catch { }

  return meta;
};

/** Extract table name from CQL. */
const extractCqlTable = (cql: string | undefined): string | undefined => {
  if (!cql) return undefined;
  const match = cql.match(/(?:FROM|INTO|UPDATE)\s+(?:(\w+)\.)?(\w+)/i);
  return match?.[2] || undefined;
};

// ---------------------------------------------------------------------------
// Client.prototype patching
// ---------------------------------------------------------------------------

const patchCassandraClient = (cassandra: any, options?: SenzorOptions) => {
  const Client = cassandra?.Client;
  if (!Client?.prototype) return;

  const proto = Client.prototype;

  // --- execute(query, params, queryOptions, callback) ---
  patchMethod(
    proto,
    'execute',
    'senzor.cassandra.client.execute',
    (original) =>
      function patchedExecute(this: any, query: string, ...args: any[]) {
        const operation = getSqlOperation(query) || 'QUERY';
        const clientMeta = getClientMeta(this);
        const tableName = extractCqlTable(query);

        // Extract query options (second or third arg depending on params)
        const queryOptions = args.find((a) => a && typeof a === 'object' && !Array.isArray(a) && typeof a !== 'function');
        const consistency = getConsistencyName(queryOptions?.consistency);
        const pageSize = queryOptions?.fetchSize;

        const span = startCapturedSpan(
          `Cassandra ${operation}`,
          'db',
          {
            ...clientMeta,
            'db.operation.name': operation,
            'db.query.text': normalizeSql(query, options),
            'db.collection.name': tableName,
            'db.cassandra.consistency': consistency,
            'db.cassandra.page_size': pageSize,
            library: 'cassandra-driver',
          },
          options
        );

        if (!span) return original.call(this, query, ...args);

        // Check if last arg is a callback
        const lastIdx = args.length - 1;
        const hasCallback = lastIdx >= 0 && typeof args[lastIdx] === 'function';

        if (hasCallback) {
          const cb = args[lastIdx];
          args[lastIdx] = function (err: any, result: any) {
            if (err) {
              span.end(500, {
                'error.message': err.message,
                'error.type': err.name || 'Error',
                'db.error.code': err.code,
              });
            } else {
              span.end(0, {
                'db.response.row_count': result?.rowLength ?? result?.rows?.length,
                'db.cassandra.coordinator.id': result?.info?.queriedHost,
              });
            }
            return cb.call(this, err, result);
          };

          return runWithCapturedSpan(span, () => original.call(this, query, ...args));
        }

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.call(this, query, ...args);

            if (result && typeof result.then === 'function') {
              return result.then(
                (value: any) => {
                  span.end(0, {
                    'db.response.row_count': value?.rowLength ?? value?.rows?.length,
                    'db.cassandra.coordinator.id': value?.info?.queriedHost,
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

  // --- batch(queries, queryOptions, callback) ---
  patchMethod(
    proto,
    'batch',
    'senzor.cassandra.client.batch',
    (original) =>
      function patchedBatch(this: any, queries: any[], ...args: any[]) {
        const batchSize = Array.isArray(queries) ? queries.length : 0;
        const clientMeta = getClientMeta(this);

        const queryOptions = args.find((a) => a && typeof a === 'object' && !Array.isArray(a) && typeof a !== 'function');
        const consistency = getConsistencyName(queryOptions?.consistency);

        const span = startCapturedSpan(
          `Cassandra BATCH (${batchSize} queries)`,
          'db',
          {
            ...clientMeta,
            'db.operation.name': 'BATCH',
            'db.cassandra.batch_size': batchSize,
            'db.cassandra.consistency': consistency,
            library: 'cassandra-driver',
          },
          options
        );

        if (!span) return original.call(this, queries, ...args);

        const lastIdx = args.length - 1;
        const hasCallback = lastIdx >= 0 && typeof args[lastIdx] === 'function';

        if (hasCallback) {
          const cb = args[lastIdx];
          args[lastIdx] = function (err: any, result: any) {
            if (err) {
              span.end(500, { 'error.message': err.message });
            } else {
              span.end(0);
            }
            return cb.call(this, err, result);
          };

          return runWithCapturedSpan(span, () => original.call(this, queries, ...args));
        }

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.call(this, queries, ...args);

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

  // --- eachRow(query, params, queryOptions, rowCallback, finalCallback) ---
  patchMethod(
    proto,
    'eachRow',
    'senzor.cassandra.client.eachRow',
    (original) =>
      function patchedEachRow(this: any, query: string, ...args: any[]) {
        const operation = getSqlOperation(query) || 'SELECT';
        const clientMeta = getClientMeta(this);
        const tableName = extractCqlTable(query);

        const span = startCapturedSpan(
          `Cassandra EACHROW ${operation}`,
          'db',
          {
            ...clientMeta,
            'db.operation.name': `EACHROW_${operation}`,
            'db.query.text': normalizeSql(query, options),
            'db.collection.name': tableName,
            library: 'cassandra-driver',
          },
          options
        );

        if (!span) return original.call(this, query, ...args);

        // The last function arg is the final callback (completion)
        // The second-to-last function arg is the row callback
        let rowCount = 0;

        // Find and wrap callbacks
        for (let i = args.length - 1; i >= 0; i--) {
          if (typeof args[i] === 'function') {
            // This is the final callback (errorBack)
            const finalCb = args[i];
            args[i] = function (err: any, result: any) {
              if (err) {
                span.end(500, { 'error.message': err.message });
              } else {
                span.end(0, { 'db.response.row_count': rowCount });
              }
              return finalCb.call(this, err, result);
            };

            // Find the row callback (previous function arg)
            for (let j = i - 1; j >= 0; j--) {
              if (typeof args[j] === 'function') {
                const rowCb = args[j];
                args[j] = function (n: any, row: any) {
                  rowCount++;
                  return rowCb.call(this, n, row);
                };
                break;
              }
            }
            break;
          }
        }

        return runWithCapturedSpan(span, () => original.call(this, query, ...args));
      }
  );

  // --- stream(query, params, queryOptions) ---
  if (typeof proto.stream === 'function') {
    patchMethod(
      proto,
      'stream',
      'senzor.cassandra.client.stream',
      (original) =>
        function patchedStream(this: any, query: string, ...args: any[]) {
          const operation = getSqlOperation(query) || 'SELECT';
          const clientMeta = getClientMeta(this);

          const span = startCapturedSpan(
            `Cassandra STREAM ${operation}`,
            'db',
            {
              ...clientMeta,
              'db.operation.name': `STREAM_${operation}`,
              'db.query.text': normalizeSql(query, options),
              library: 'cassandra-driver',
            },
            options
          );

          if (!span) return original.call(this, query, ...args);

          return runWithCapturedSpan(span, () => {
            const stream = original.call(this, query, ...args);

            if (stream && typeof stream.on === 'function') {
              let rowCount = 0;
              stream.on('data', () => { rowCount++; });
              stream.on('end', () => {
                span.end(0, { 'db.response.row_count': rowCount });
              });
              stream.on('error', (err: any) => {
                span.end(500, { 'error.message': err?.message });
              });
            } else {
              span.end(0);
            }

            return stream;
          });
        }
    );
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentCassandra = (options?: SenzorOptions) => {
  hookRequire('cassandra-driver', (exports: any) => {
    patchCassandraClient(exports, options);
  });
};
