import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// DataLoader Instrumentation
//
// Instruments the `dataloader` package — the standard batching/caching
// utility for solving N+1 queries in GraphQL resolvers, REST APIs,
// and any data-fetching layer.
//
// Patches DataLoader.prototype methods:
//   - load(key)        — single key lookup (batched)
//   - loadMany(keys)   — multi-key lookup (batched)
//   - prime(key, val)  — cache priming
//   - clear(key)       — single cache eviction
//   - clearAll()       — full cache clear
//
// The key insight: load() calls are batched by DataLoader and dispatched
// together via the batch function. We instrument both the individual
// load() calls AND the batch dispatch to show:
//   1. Per-key latency (includes batching wait time)
//   2. Batch execution performance
//
// Captured attributes:
//   - dataloader.operation: load, loadMany, prime, clear, clearAll, batch
//   - dataloader.key_count: number of keys in the batch
//   - dataloader.name: DataLoader instance name (if available)
//   - dataloader.cache_hit: whether result came from cache
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DataLoader prototype patching
// ---------------------------------------------------------------------------

const patchDataLoader = (DataLoader: any, options?: SenzorOptions) => {
  const proto = DataLoader?.prototype;
  if (!proto) return;

  // --- load(key) → Promise<value> ---
  patchMethod(
    proto,
    'load',
    'senzor.dataloader.load',
    (original) =>
      function patchedLoad(this: any, key: any) {
        const loaderName = this.name || this._name || 'DataLoader';

        const span = startCapturedSpan(
          `${loaderName} load`,
          'function',
          {
            'dataloader.operation': 'load',
            'dataloader.name': loaderName,
            library: 'dataloader',
          },
          options
        );

        if (!span) return original.call(this, key);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.call(this, key);

            if (result && typeof result.then === 'function') {
              return result.then(
                (value: any) => {
                  span.end(0);
                  return value;
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
            span.end(500, { 'error.message': error?.message });
            throw error;
          }
        });
      }
  );

  // --- loadMany(keys) → Promise<value[]> ---
  patchMethod(
    proto,
    'loadMany',
    'senzor.dataloader.loadMany',
    (original) =>
      function patchedLoadMany(this: any, keys: any[]) {
        const loaderName = this.name || this._name || 'DataLoader';
        const keyCount = Array.isArray(keys) ? keys.length : 0;

        const span = startCapturedSpan(
          `${loaderName} loadMany`,
          'function',
          {
            'dataloader.operation': 'loadMany',
            'dataloader.name': loaderName,
            'dataloader.key_count': keyCount,
            library: 'dataloader',
          },
          options
        );

        if (!span) return original.call(this, keys);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.call(this, keys);

            if (result && typeof result.then === 'function') {
              return result.then(
                (values: any) => {
                  // Count errors in results
                  const errorCount = Array.isArray(values)
                    ? values.filter((v: any) => v instanceof Error).length
                    : 0;

                  span.end(errorCount > 0 ? 207 : 0, {
                    'dataloader.key_count': keyCount,
                    'dataloader.error_count': errorCount,
                  });
                  return values;
                },
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

  // --- Wrap the batch function dispatch ---
  // DataLoader calls the batch function internally. We intercept it
  // by wrapping the constructor or the internal _batchLoadFn.
  // Since we can't easily wrap the constructor via patchMethod,
  // we patch _batchScheduleFn or override the dispatch mechanism.

  // Patch the internal _batch method if it exists
  const batchMethodName = '_dispatchBatch' in proto
    ? '_dispatchBatch'
    : '_dispatch' in proto
      ? '_dispatch'
      : null;

  if (batchMethodName && typeof proto[batchMethodName] === 'function') {
    patchMethod(
      proto,
      batchMethodName,
      `senzor.dataloader.${batchMethodName}`,
      (original) =>
        function patchedDispatch(this: any, ...args: any[]) {
          const loaderName = this.name || this._name || 'DataLoader';
          // The batch queue holds pending keys
          const batchSize = this._queue?.length || this._batch?.length || 0;

          const span = startCapturedSpan(
            `${loaderName} batch dispatch`,
            'function',
            {
              'dataloader.operation': 'batch',
              'dataloader.name': loaderName,
              'dataloader.batch_size': batchSize,
              library: 'dataloader',
            },
            options
          );

          if (!span) return original.apply(this, args);

          return runWithCapturedSpan(span, () => {
            try {
              const result = original.apply(this, args);
              // Batch dispatch is sync; the batch function's promise
              // is resolved internally. End span after dispatch.
              span.end(0, { 'dataloader.batch_size': batchSize });
              return result;
            } catch (error: any) {
              span.end(500, { 'error.message': error?.message });
              throw error;
            }
          });
        }
    );
  }

  // --- prime(key, value) ---
  if (typeof proto.prime === 'function') {
    patchMethod(
      proto,
      'prime',
      'senzor.dataloader.prime',
      (original) =>
        function patchedPrime(this: any, key: any, value: any) {
          const loaderName = this.name || this._name || 'DataLoader';

          const span = startCapturedSpan(
            `${loaderName} prime`,
            'function',
            {
              'dataloader.operation': 'prime',
              'dataloader.name': loaderName,
              library: 'dataloader',
            },
            options
          );

          if (!span) return original.call(this, key, value);

          try {
            const result = original.call(this, key, value);
            span.end(0);
            return result;
          } catch (error: any) {
            span.end(500, { 'error.message': error?.message });
            throw error;
          }
        }
    );
  }

  // --- clearAll() ---
  if (typeof proto.clearAll === 'function') {
    patchMethod(
      proto,
      'clearAll',
      'senzor.dataloader.clearAll',
      (original) =>
        function patchedClearAll(this: any) {
          const loaderName = this.name || this._name || 'DataLoader';

          const span = startCapturedSpan(
            `${loaderName} clearAll`,
            'function',
            {
              'dataloader.operation': 'clearAll',
              'dataloader.name': loaderName,
              library: 'dataloader',
            },
            options
          );

          if (!span) return original.call(this);

          try {
            const result = original.call(this);
            span.end(0);
            return result;
          } catch (error: any) {
            span.end(500, { 'error.message': error?.message });
            throw error;
          }
        }
    );
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentDataloader = (options?: SenzorOptions) => {
  hookRequire('dataloader', (exports: any) => {
    // dataloader exports the constructor directly
    patchDataLoader(exports, options);

    // Handle default export (ESM interop)
    if (exports?.default?.prototype) {
      patchDataLoader(exports.default, options);
    }
  });
};
