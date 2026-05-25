import { ActiveTrace, Span } from './types';

interface IStorage<T> {
  run<R>(store: T, callback: (...args: any[]) => R, ...args: any[]): R;
  getStore(): T | undefined;
}

/**
 * Async-safe fallback when AsyncLocalStorage is unavailable.
 *
 * Not concurrency-safe across truly parallel requests in a single isolate,
 * but correct for sequential and async/await patterns (e.g. Cloudflare Workers
 * where each request gets its own execution context).
 */
class NaiveStorage<T> implements IStorage<T> {
  private store: T | undefined;

  run<R>(store: T, callback: (...args: any[]) => R, ...args: any[]): R {
    const prev = this.store;
    this.store = store;

    let result: R;
    try {
      result = callback(...args);
    } catch (err) {
      this.store = prev;
      throw err;
    }

    // If the callback returned a thenable (async handler), defer the restore
    // until the promise settles so Context.current() works across awaits.
    if (result != null && typeof (result as any).then === 'function') {
      const promise = (result as any).then(
        (val: any) => { this.store = prev; return val; },
        (err: any) => { this.store = prev; throw err; }
      );
      return promise as R;
    }

    // Sync callback — restore immediately.
    this.store = prev;
    return result;
  }

  getStore(): T | undefined {
    return this.store;
  }
}

/**
 * Resolve the best available async context storage.
 *
 * Uses lazy re-resolution: if the initial attempt (at module evaluation time)
 * falls back to NaiveStorage, subsequent calls to resolveStorage() will retry.
 * This handles runtimes where AsyncLocalStorage becomes available after module
 * init (e.g. some Workers configurations).
 */
const tryResolveALS = <T>(): IStorage<T> | null => {
  // 1. Check globalThis (Cloudflare Workers nodejs_compat_v2, Bun, Deno)
  if (typeof globalThis !== 'undefined' && (globalThis as any).AsyncLocalStorage) {
    return new (globalThis as any).AsyncLocalStorage();
  }

  // 2. Node.js CJS require
  try {
    if (typeof require !== 'undefined') {
      const mod = require('node:async_hooks');
      if (mod?.AsyncLocalStorage) return new mod.AsyncLocalStorage();
    }
  } catch {}

  try {
    if (typeof require !== 'undefined') {
      const mod = require('async_hooks');
      if (mod?.AsyncLocalStorage) return new mod.AsyncLocalStorage();
    }
  } catch {}

  return null;
};

class LazyStorage<T> implements IStorage<T> {
  private inner: IStorage<T>;
  private resolved = false;

  constructor() {
    this.inner = tryResolveALS<T>() || new NaiveStorage<T>();
    this.resolved = !(this.inner instanceof NaiveStorage);
  }

  private ensureResolved() {
    if (this.resolved) return;
    const als = tryResolveALS<T>();
    if (als) {
      this.inner = als;
      this.resolved = true;
    }
  }

  run<R>(store: T, callback: (...args: any[]) => R, ...args: any[]): R {
    this.ensureResolved();
    return this.inner.run(store, callback, ...args);
  }

  getStore(): T | undefined {
    return this.inner.getStore();
  }
}

export const storage = new LazyStorage<ActiveTrace>();

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
