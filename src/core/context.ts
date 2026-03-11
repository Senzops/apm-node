import { AsyncLocalStorage } from 'async_hooks';
import { ActiveTrace } from './types';

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
  }
};