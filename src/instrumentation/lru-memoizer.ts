import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// LRU-Memoizer Instrumentation
//
// Instruments the `lru-memoizer` package — a popular caching/memoization
// library used by Auth0's node-auth0 SDK, passport strategies, and other
// authentication/authorization flows for caching tokens, JWKS keys, etc.
//
// Strategy: Wrap the lru-memoizer factory functions to intercept the
// returned memoized function. Each call to the memoized function gets
// a span showing cache hit/miss and execution time.
//
// lru-memoizer exports:
//   - lruMemoizer(options)      — callback-based memoizer (default)
//   - lruMemoizer.sync(options) — synchronous memoizer
//
// The options object contains:
//   - load: the function to memoize (fetches the value on cache miss)
//   - hash: key generation function
//   - max: max cache entries
//   - maxAge: TTL in ms
//
// Captured attributes:
//   - memoizer.operation: 'lookup'
//   - memoizer.name: function name or 'memoized'
//   - memoizer.cache_size: current cache size (if available)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Memoized function wrapping
// ---------------------------------------------------------------------------

/**
 * Wrap a memoized function (returned by lru-memoizer) to add spans.
 * The original load function name is used as the span name.
 */
const wrapMemoizedFunction = (
  memoized: Function,
  loadFnName: string,
  options?: SenzorOptions
): Function => {
  if (typeof memoized !== 'function') return memoized;
  if ((memoized as any).__senzorWrapped) return memoized;

  const name = loadFnName || 'memoized';

  const wrapped = function wrappedMemoized(this: any, ...args: any[]) {
    const span = startCapturedSpan(
      `LRU ${name}`,
      'function',
      {
        'memoizer.operation': 'lookup',
        'memoizer.name': name,
        library: 'lru-memoizer',
      },
      options
    );

    if (!span) return memoized.apply(this, args);

    // Check if last arg is a callback
    const lastIdx = args.length - 1;
    const hasCallback = lastIdx >= 0 && typeof args[lastIdx] === 'function';

    if (hasCallback) {
      const originalCb = args[lastIdx];
      args[lastIdx] = function (err: any, ...results: any[]) {
        if (err) {
          span.end(500, {
            'error.message': typeof err === 'string' ? err : err?.message,
            'error.type': err?.name || 'Error',
          });
        } else {
          span.end(0);
        }
        return originalCb.call(this, err, ...results);
      };

      return runWithCapturedSpan(span, () => {
        try {
          return memoized.apply(this, args);
        } catch (error: any) {
          span.end(500, { 'error.message': error?.message });
          throw error;
        }
      });
    }

    // Promise-based or sync
    return runWithCapturedSpan(span, () => {
      try {
        const result = memoized.apply(this, args);

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
  };

  // Preserve any properties on the original memoized function
  // (e.g., .keys(), .reset(), .del())
  for (const key of Object.keys(memoized)) {
    try { (wrapped as any)[key] = (memoized as any)[key]; } catch { }
  }

  (wrapped as any).__senzorWrapped = true;
  return wrapped;
};

// ---------------------------------------------------------------------------
// Factory wrapping
// ---------------------------------------------------------------------------

const patchLruMemoizer = (lruMemoizer: any, options?: SenzorOptions) => {
  if (typeof lruMemoizer !== 'function') return lruMemoizer;

  // Wrap the main factory (callback-based)
  const wrappedFactory = function patchedLruMemoizer(this: any, memoizerOptions: any) {
    const loadFnName = memoizerOptions?.load?.name || memoizerOptions?.name || 'memoized';
    const result = lruMemoizer.call(this, memoizerOptions);
    return wrapMemoizedFunction(result, loadFnName, options);
  };

  // Copy all static properties
  for (const key of Object.keys(lruMemoizer)) {
    try { (wrappedFactory as any)[key] = (lruMemoizer as any)[key]; } catch { }
  }

  // Wrap .sync() if it exists
  if (typeof lruMemoizer.sync === 'function') {
    const originalSync = lruMemoizer.sync;
    (wrappedFactory as any).sync = function patchedSync(this: any, memoizerOptions: any) {
      const loadFnName = memoizerOptions?.load?.name || memoizerOptions?.name || 'memoized-sync';
      const result = originalSync.call(this, memoizerOptions);
      return wrapMemoizedFunction(result, loadFnName, options);
    };
  }

  return wrappedFactory;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentLruMemoizer = (options?: SenzorOptions) => {
  hookRequire('lru-memoizer', (exports: any) => {
    // lru-memoizer exports the factory directly
    if (typeof exports === 'function') {
      return patchLruMemoizer(exports, options);
    }

    // Handle { default: fn } or { memoizer: fn }
    if (typeof exports?.default === 'function') {
      exports.default = patchLruMemoizer(exports.default, options);
    }
  });
};
