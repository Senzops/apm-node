import { ActiveTrace, Span } from './types';

interface IStorage<T> {
  run<R>(store: T, callback: (...args: any[]) => R, ...args: any[]): R;
  getStore(): T | undefined;
}

class NaiveStorage<T> implements IStorage<T> {
  private store: T | undefined;

  run<R>(store: T, callback: (...args: any[]) => R, ...args: any[]): R {
    const prev = this.store;
    this.store = store;
    try {
      return callback(...args);
    } finally {
      this.store = prev;
    }
  }

  getStore(): T | undefined {
    return this.store;
  }
}

const resolveStorage = <T>(): IStorage<T> => {
  if (typeof globalThis !== 'undefined' && (globalThis as any).AsyncLocalStorage) {
    return new (globalThis as any).AsyncLocalStorage();
  }

  try {
    if (typeof require !== 'undefined') {
      const { AsyncLocalStorage } = require('node:async_hooks');
      if (AsyncLocalStorage) return new AsyncLocalStorage();
    }
  } catch {}

  try {
    if (typeof require !== 'undefined') {
      const { AsyncLocalStorage } = require('async_hooks');
      if (AsyncLocalStorage) return new AsyncLocalStorage();
    }
  } catch {}

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
