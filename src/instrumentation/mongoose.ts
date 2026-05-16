import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

const modelName = (target: any): string =>
  target?.model?.modelName ||
  target?.constructor?.modelName ||
  target?.modelName ||
  'unknown';

const collectionName = (target: any): string =>
  target?.mongooseCollection?.name ||
  target?.collection?.name ||
  target?.model?.collection?.name ||
  'unknown';

const patchExec = (
  proto: any,
  label: 'query' | 'aggregate',
  options?: SenzorOptions
) => {
  patchMethod(
    proto,
    'exec',
    `senzor.mongoose.${label}.exec`,
    (original) =>
      function patchedMongooseExec(this: any, ...args: any[]) {
        const operation =
          String(this?.op || this?._op || label).toUpperCase();
        const collection = collectionName(this);
        const span = startCapturedSpan(
          `Mongoose ${operation}`,
          'db',
          {
            collection,
            model: modelName(this),
            operation,
            'db.system.name': 'mongodb',
            'db.collection.name': collection,
            'db.operation.name': operation,
            library: 'mongoose'
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

const patchSave = (modelProto: any, options?: SenzorOptions) => {
  patchMethod(
    modelProto,
    'save',
    'senzor.mongoose.model.save',
    (original) =>
      function patchedMongooseSave(this: any, ...args: any[]) {
        const collection = collectionName(this);
        const span = startCapturedSpan(
          'Mongoose SAVE',
          'db',
          {
            collection,
            model: modelName(this),
            operation: 'SAVE',
            'db.system.name': 'mongodb',
            'db.collection.name': collection,
            'db.operation.name': 'SAVE',
            library: 'mongoose'
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

const patchMongoose = (mongoose: any, options?: SenzorOptions) => {
  patchExec(mongoose?.Query?.prototype, 'query', options);
  patchExec(mongoose?.Aggregate?.prototype, 'aggregate', options);
  patchSave(mongoose?.Model?.prototype, options);

  if (mongoose?.default) {
    patchExec(mongoose.default?.Query?.prototype, 'query', options);
    patchExec(mongoose.default?.Aggregate?.prototype, 'aggregate', options);
    patchSave(mongoose.default?.Model?.prototype, options);
  }
};

export const instrumentMongoose = (options?: SenzorOptions) => {
  hookRequire('mongoose', (exports: any) => patchMongoose(exports, options));
};
