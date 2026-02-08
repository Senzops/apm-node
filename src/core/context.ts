import { AsyncLocalStorage } from 'async_hooks';
import { ActiveTrace } from './types';

// Storage to hold the current Trace for any async operation
export const storage = new AsyncLocalStorage<ActiveTrace>();

export const Context = {
  // Run a function within a trace context
  // Updated to be Generic <T> to allow returning values (Promises, etc)
  run: <T>(trace: ActiveTrace, fn: () => T): T => {
    return storage.run(trace, fn);
  },

  // Get current trace (safe)
  current: (): ActiveTrace | undefined => {
    return storage.getStore();
  },

  // Add a span to the current trace
  addSpan: (span: any) => {
    const store = storage.getStore();
    if (store) {
      store.spans.push(span);
    }
  }
};