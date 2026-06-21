// ---------------------------------------------------------------------------
// AI streaming instrumentation
// ----------------------------------------------------------------------------
// Captures token usage, time-to-first-token, model and finish reason from a
// streaming LLM response WITHOUT consuming the user's stream.
//
// Strategy: return a Proxy over the original stream object that overrides only
// `[Symbol.asyncIterator]`. As the user's own `for await` pulls chunks, we
// observe each one passing through (`onChunk`) and finalize when iteration
// completes, errors, or is abandoned early (`onDone`). Every other property /
// method on the stream (e.g. `toReadableStream()`, `controller`, `tee()`) is
// forwarded untouched via `Reflect`, so we never alter behaviour or double-read.
// ---------------------------------------------------------------------------

export interface StreamObserver {
  /** Called once per chunk the consumer pulls. Must never throw. */
  onChunk: (chunk: any) => void;
  /** Called exactly once when the stream ends, errors, or is abandoned. */
  onDone: (error?: any) => void;
}

const ASYNC_ITER = Symbol.asyncIterator;

/** True when a value exposes an async iterator (i.e. is `for await`-able). */
export const isAsyncIterable = (v: any): boolean =>
  v != null && typeof v[ASYNC_ITER] === 'function';

export const wrapAiStream = <T extends object>(stream: T, observer: StreamObserver): T => {
  const iterFactory = (stream as any)[ASYNC_ITER];
  if (typeof iterFactory !== 'function') {
    // Not iterable — nothing to observe; finalize immediately.
    try { observer.onDone(); } catch { /* noop */ }
    return stream;
  }

  let finished = false;
  const finish = (error?: any) => {
    if (finished) return;
    finished = true;
    try { observer.onDone(error); } catch { /* never break the host */ }
  };

  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === ASYNC_ITER) {
        return function instrumentedAsyncIterator() {
          const iterator: AsyncIterator<any> = iterFactory.call(target);
          return {
            async next() {
              try {
                const res = await iterator.next();
                if (res.done) {
                  finish();
                } else {
                  try { observer.onChunk(res.value); } catch { /* noop */ }
                }
                return res;
              } catch (err) {
                finish(err);
                throw err;
              }
            },
            async return(value?: any) {
              // Consumer broke out early (e.g. `break` in a for-await loop).
              finish();
              if (typeof iterator.return === 'function') return iterator.return(value);
              return { done: true, value };
            },
            async throw(err?: any) {
              finish(err);
              if (typeof iterator.throw === 'function') return iterator.throw(err);
              throw err;
            },
            [ASYNC_ITER]() {
              return this;
            },
          };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
};
