import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

const collectionName = (collection: any): string =>
  collection?.collectionName ||
  collection?.s?.namespace?.collection ||
  collection?.namespace?.collection ||
  'unknown';

const databaseName = (collection: any): string | undefined =>
  collection?.dbName ||
  collection?.s?.namespace?.db ||
  collection?.namespace?.db;

const cursorCollectionName = (cursor: any): string =>
  cursor?.namespace?.collection ||
  cursor?.ns?.collection ||
  cursor?.cursorNamespace?.collection ||
  'unknown';

const patchCollectionMethod = (
  proto: any,
  method: string,
  options?: SenzorOptions
) => {
  patchMethod(
    proto,
    method,
    `senzor.mongodb.collection.${method}`,
    (original) =>
      function patchedMongoCollection(this: any, ...args: any[]) {
        const collection = collectionName(this);
        const span = startCapturedSpan(
          `MongoDB ${method}`,
          'db',
          {
            collection,
            operation: method,
            'db.system.name': 'mongodb',
            'db.collection.name': collection,
            'db.namespace': databaseName(this)
              ? `${databaseName(this)}.${collection}`
              : collection,
            'db.operation.name': method,
            library: 'mongodb'
          },
          options
        );

        if (!span) return original.apply(this, args);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.apply(this, args);
            if (result && typeof result.then === 'function') {
              return result.then(
                (value: any) => {
                  span.end(0, {
                    matchedCount: value?.matchedCount,
                    modifiedCount: value?.modifiedCount,
                    deletedCount: value?.deletedCount,
                    insertedCount: value?.insertedCount
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

const patchCursorMethod = (
  proto: any,
  method: string,
  operation: string,
  options?: SenzorOptions
) => {
  patchMethod(
    proto,
    method,
    `senzor.mongodb.cursor.${operation}.${method}`,
    (original) =>
      function patchedMongoCursor(this: any, ...args: any[]) {
        const collection = cursorCollectionName(this);
        const span = startCapturedSpan(
          `MongoDB ${operation}`,
          'db',
          {
            collection,
            operation,
            'db.system.name': 'mongodb',
            'db.collection.name': collection,
            'db.operation.name': operation,
            library: 'mongodb'
          },
          options
        );

        if (!span) return original.apply(this, args);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.apply(this, args);
            if (result && typeof result.then === 'function') {
              return result.then(
                (value: any) => {
                  span.end(0, {
                    resultCount: Array.isArray(value) ? value.length : undefined
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

const patchMongo = (mongodb: any, options?: SenzorOptions) => {
  const Collection = mongodb?.Collection || mongodb?.default?.Collection;
  const collectionProto = Collection?.prototype;

  [
    'insertOne',
    'insertMany',
    'updateOne',
    'updateMany',
    'replaceOne',
    'deleteOne',
    'deleteMany',
    'findOne',
    'findOneAndUpdate',
    'findOneAndDelete',
    'findOneAndReplace',
    'countDocuments',
    'estimatedDocumentCount',
    'distinct',
    'bulkWrite',
    'createIndex',
    'dropIndex'
  ].forEach((method) =>
    patchCollectionMethod(collectionProto, method, options)
  );

  const FindCursor =
    mongodb?.FindCursor || mongodb?.default?.FindCursor;
  const AggregationCursor =
    mongodb?.AggregationCursor || mongodb?.default?.AggregationCursor;

  ['toArray', 'next', 'forEach'].forEach((method) =>
    patchCursorMethod(FindCursor?.prototype, method, 'find', options)
  );
  ['toArray', 'next', 'forEach'].forEach((method) =>
    patchCursorMethod(
      AggregationCursor?.prototype,
      method,
      'aggregate',
      options
    )
  );
};

export const instrumentMongo = (options?: SenzorOptions) => {
  hookRequire('mongodb', (exports: any) => patchMongo(exports, options));
};
