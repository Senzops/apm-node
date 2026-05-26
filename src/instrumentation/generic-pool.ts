import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// generic-pool Instrumentation
//
// Instruments the `generic-pool` package — the de-facto connection/resource
// pooling library used by many database drivers (pg, mysql2, tedious),
// cache clients, and custom resource managers in Node.js.
//
// Patches Pool.prototype methods:
//   - acquire()  — resource acquisition from the pool
//   - release()  — resource return to the pool
//   - destroy()  — resource destruction
//   - drain()    — pool draining (graceful shutdown)
//
// These spans measure pool health and contention:
//   - How long acquire() takes reveals pool exhaustion
//   - Release/destroy patterns show resource lifecycle
//
// Captured attributes:
//   - pool.type: 'generic-pool'
//   - pool.operation: acquire, release, destroy, drain
//   - pool.size: current pool size
//   - pool.available: available resources
//   - pool.pending: pending acquisition requests
//   - pool.max: maximum pool size
//   - pool.min: minimum pool size
// ---------------------------------------------------------------------------

/** Extract pool stats from a generic-pool Pool instance. */
const getPoolStats = (pool: any): Record<string, any> => {
  const stats: Record<string, any> = {
    'pool.type': 'generic-pool',
  };

  try {
    if (typeof pool.size !== 'undefined') stats['pool.size'] = pool.size;
    if (typeof pool.available !== 'undefined') stats['pool.available'] = pool.available;
    if (typeof pool.pending !== 'undefined') stats['pool.pending'] = pool.pending;
    if (typeof pool.borrowed !== 'undefined') stats['pool.borrowed'] = pool.borrowed;
    if (pool.max !== undefined) stats['pool.max'] = pool.max;
    if (pool.min !== undefined) stats['pool.min'] = pool.min;

    // Try _config for older versions
    if (pool._config) {
      if (stats['pool.max'] === undefined && pool._config.max) stats['pool.max'] = pool._config.max;
      if (stats['pool.min'] === undefined && pool._config.min) stats['pool.min'] = pool._config.min;
    }
  } catch { }

  return stats;
};

// ---------------------------------------------------------------------------
// Pool method patching
// ---------------------------------------------------------------------------

const patchPool = (poolProto: any, options?: SenzorOptions) => {
  if (!poolProto) return;

  // --- acquire(priority?) → Promise<resource> ---
  patchMethod(
    poolProto,
    'acquire',
    'senzor.generic-pool.pool.acquire',
    (original) =>
      function patchedAcquire(this: any, ...args: any[]) {
        const poolStats = getPoolStats(this);

        const span = startCapturedSpan(
          'Pool acquire',
          'custom',
          {
            ...poolStats,
            'pool.operation': 'acquire',
            library: 'generic-pool',
          },
          options
        );

        if (!span) return original.apply(this, args);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.apply(this, args);

            if (result && typeof result.then === 'function') {
              return result.then(
                (resource: any) => {
                  // Capture pool state after acquisition
                  const postStats = getPoolStats(this);
                  span.end(0, {
                    'pool.size_after': postStats['pool.size'],
                    'pool.available_after': postStats['pool.available'],
                    'pool.pending_after': postStats['pool.pending'],
                  });
                  return resource;
                },
                (error: any) => {
                  span.end(500, {
                    'error.message': error?.message,
                    'error.type': error?.name || 'PoolError',
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
            });
            throw error;
          }
        });
      }
  );

  // --- release(resource) → Promise<void> ---
  patchMethod(
    poolProto,
    'release',
    'senzor.generic-pool.pool.release',
    (original) =>
      function patchedRelease(this: any, resource: any) {
        const poolStats = getPoolStats(this);

        const span = startCapturedSpan(
          'Pool release',
          'custom',
          {
            ...poolStats,
            'pool.operation': 'release',
            library: 'generic-pool',
          },
          options
        );

        if (!span) return original.call(this, resource);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.call(this, resource);

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

  // --- destroy(resource) → Promise<void> ---
  patchMethod(
    poolProto,
    'destroy',
    'senzor.generic-pool.pool.destroy',
    (original) =>
      function patchedDestroy(this: any, resource: any) {
        const poolStats = getPoolStats(this);

        const span = startCapturedSpan(
          'Pool destroy',
          'custom',
          {
            ...poolStats,
            'pool.operation': 'destroy',
            library: 'generic-pool',
          },
          options
        );

        if (!span) return original.call(this, resource);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.call(this, resource);

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

  // --- drain() → Promise<void> ---
  if (typeof poolProto.drain === 'function') {
    patchMethod(
      poolProto,
      'drain',
      'senzor.generic-pool.pool.drain',
      (original) =>
        function patchedDrain(this: any) {
          const poolStats = getPoolStats(this);

          const span = startCapturedSpan(
            'Pool drain',
            'custom',
            {
              ...poolStats,
              'pool.operation': 'drain',
              library: 'generic-pool',
            },
            options
          );

          if (!span) return original.call(this);

          return runWithCapturedSpan(span, () => {
            try {
              const result = original.call(this);

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
// createPool factory wrapping
// ---------------------------------------------------------------------------

const patchCreatePool = (genericPool: any, options?: SenzorOptions) => {
  if (typeof genericPool?.createPool !== 'function') return;

  patchMethod(
    genericPool,
    'createPool',
    'senzor.generic-pool.createPool',
    (original) =>
      function patchedCreatePool(this: any, factory: any, config: any) {
        const pool = original.call(this, factory, config);

        if (pool && !pool.__senzorPatched) {
          const proto = Object.getPrototypeOf(pool);
          if (proto && !proto.__senzorPatched) {
            patchPool(proto, options);
            proto.__senzorPatched = true;
          }
          pool.__senzorPatched = true;
        }

        return pool;
      }
  );
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentGenericPool = (options?: SenzorOptions) => {
  hookRequire('generic-pool', (exports: any) => {
    // Patch the createPool factory
    patchCreatePool(exports, options);

    // Also try to find the Pool prototype directly
    if (exports?.Pool?.prototype) {
      patchPool(exports.Pool.prototype, options);
    }

    // Handle default export
    if (exports?.default) {
      patchCreatePool(exports.default, options);
      if (exports.default.Pool?.prototype) {
        patchPool(exports.default.Pool.prototype, options);
      }
    }
  });
};
