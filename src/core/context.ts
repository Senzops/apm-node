import { ActiveTrace, Span } from './types';

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
 * Tries multiple resolution strategies to cover CJS, ESM, and edge runtimes.
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

  // 3. ESM fallback: indirect require via Function constructor
  // In bundled ESM (tsup/esbuild), `require` is shimmed and steps 1-2 work.
  // This step handles raw ESM where require is truly unavailable.
  try {
    if (typeof require === 'undefined' && typeof process !== 'undefined') {
      const fn = new Function('try { var m = require("module"); return m.createRequire(process.cwd() + "/")("node:async_hooks"); } catch(e) { return null; }');
      const mod = fn();
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
