import { AsyncLocalStorage } from 'async_hooks';
import { ActiveTrace, TraceError } from './types';

export const storage = new AsyncLocalStorage<ActiveTrace>();

export const Context = {
  run: <T>(trace: ActiveTrace, fn: () => T): T => {
    return storage.run(trace, fn);
  },

  current: (): ActiveTrace | undefined => {
    return storage.getStore();
  },

  addSpan: (span: any) => {
    const store = storage.getStore();
    if (store) {
      store.spans.push(span);
    }
  },

  // Attach error to current trace
  setError: (error: Error) => {
    const store = storage.getStore();
    if (store) {
      store.error = {
        name: error.name,
        message: error.message,
        stack: error.stack
      };
    }
  }
};