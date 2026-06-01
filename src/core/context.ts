import { ActiveTrace, Span } from './types';

// ---------------------------------------------------------------------------
// Static import — guaranteed by the bundler for Node.js environments.
// tsup/esbuild keeps 'async_hooks' external and emits a top-level require.
// This runs at module evaluation time, before any SDK code executes.
//
// For non-Node runtimes (Cloudflare Workers, etc.), the import will be
// undefined and we fall through to the dynamic resolution below.
// ---------------------------------------------------------------------------
let StaticALS: typeof import('async_hooks').AsyncLocalStorage | null = null;
try {
  const mod = require('async_hooks');
  StaticALS = mod?.AsyncLocalStorage ?? null;
} catch {}

// ---------------------------------------------------------------------------
// Storage interface
// ---------------------------------------------------------------------------

interface IStorage<T> {
  run<R>(store: T, callback: (...args: any[]) => R, ...args: any[]): R;
  getStore(): T | undefined;
}

/**
 * Per-callback context tracking for runtimes without AsyncLocalStorage.
 *
 * Uses a stack instead of a single variable so overlapping synchronous
 * Context.run() calls (e.g. nested middleware) don't clobber each other.
 * Async context is propagated by chaining onto the returned thenable.
 *
 * NOT safe for truly concurrent requests in a single isolate — use
 * AsyncLocalStorage for that. This exists as a last-resort fallback.
 */
class NaiveStorage<T> implements IStorage<T> {
  private stack: T[] = [];

  run<R>(store: T, callback: (...args: any[]) => R, ...args: any[]): R {
    this.stack.push(store);

    let result: R;
    try {
      result = callback(...args);
    } catch (err) {
      this.stack.pop();
      throw err;
    }

    if (result != null && typeof (result as any).then === 'function') {
      const promise = (result as any).then(
        (val: any) => { this.stack.pop(); return val; },
        (err: any) => { this.stack.pop(); throw err; }
      );
      return promise as R;
    }

    this.stack.pop();
    return result;
  }

  getStore(): T | undefined {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : undefined;
  }
}

/**
 * Resolve the best available async context storage.
 *
 * 1. Use the statically imported AsyncLocalStorage (Node.js — always works)
 * 2. Check globalThis (Cloudflare Workers nodejs_compat_v2, Bun, Deno)
 * 3. Fall back to NaiveStorage (Cloudflare Workers without nodejs_compat)
 */
const resolveStorage = <T>(): IStorage<T> => {
  // 1. Static import — resolved at module load time (Node.js)
  if (StaticALS) {
    return new StaticALS() as unknown as IStorage<T>;
  }

  // 2. globalThis (Cloudflare Workers nodejs_compat_v2, Bun, Deno)
  if (typeof globalThis !== 'undefined' && (globalThis as any).AsyncLocalStorage) {
    return new (globalThis as any).AsyncLocalStorage();
  }

  // 3. Dynamic require fallback (edge case: bundler didn't resolve static import)
  try {
    if (typeof require !== 'undefined') {
      const mod = require('async_hooks');
      if (mod?.AsyncLocalStorage) return new mod.AsyncLocalStorage();
    }
  } catch {}

  // 4. Last resort — NaiveStorage (Cloudflare Workers without nodejs_compat)
  return new NaiveStorage<T>();
};

export const storage = resolveStorage<ActiveTrace>();

export const Context = {
  run: <T>(trace: ActiveTrace, fn: () => T): T => {
    return storage.run(trace, fn);
  },

  withActiveSpan: <T>(spanId: string, fn: () => T): T => {
    const store = storage.getStore();
    if (!store) return fn();

    return storage.run(
      {
        ...store,
        activeSpanId: spanId,
        data: store.data,
        spans: store.spans
      },
      fn
    );
  },

  current: (): ActiveTrace | undefined => {
    return storage.getStore();
  },

  addSpan: (span: Span) => {
    const store = storage.getStore();
    if (store) {
      Context.addSpanToTrace(store, span);
    }
  },

  addSpanToTrace: (trace: ActiveTrace, span: Span) => {
    if (trace.state.ended) return;

    const maxSpans = trace.maxSpans ?? 500;
    if (trace.spans.length >= maxSpans) {
      trace.state.droppedSpans = (trace.state.droppedSpans ?? 0) + 1;
      return;
    }

    trace.spans.push(span);
  }
};
