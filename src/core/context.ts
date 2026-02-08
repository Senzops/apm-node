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
    } else {
      // If we are here, something tried to add a span but lost context
      // This is common if users await inside a callback that wasn't bound
      // However, usually silent failure is preferred in production APM
      console.warn('[Senzor] Lost context for span:', span.name);
    }
  }
};