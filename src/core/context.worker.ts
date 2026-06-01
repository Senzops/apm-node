import { ActiveTrace, Span } from './types';

interface IStorage<T> {
  run<R>(store: T, callback: (...args: any[]) => R, ...args: any[]): R;
  getStore(): T | undefined;
}

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

const resolveStorage = <T>(): IStorage<T> => {
  if (typeof globalThis !== 'undefined' && (globalThis as any).AsyncLocalStorage) {
    return new (globalThis as any).AsyncLocalStorage();
  }
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
