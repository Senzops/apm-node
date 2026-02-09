import { Context } from '../core/context';

export const instrumentMongo = (debug = false) => {
  try {
    const mongodb = require('mongodb');
    const Collection = mongodb.Collection;

    // Attempt to get Cursor classes
    // Note: The location of these classes varies by driver version, 
    // checking common locations
    const FindCursor = mongodb.FindCursor || require('mongodb/lib/cursor/find_cursor').FindCursor;
    const AggregationCursor = mongodb.AggregationCursor || require('mongodb/lib/cursor/aggregation_cursor').AggregationCursor;

    if (debug) console.log('[Senzor] Instrumenting MongoDB (Collection + Cursors)...');

    // --- Helper to Record Span ---
    const recordSpan = (name: string, operation: string, collection: string, startAbs: number, traceStart: number, err?: Error) => {
      const duration = performance.now() - startAbs;
      Context.addSpan({
        name: `MongoDB ${name}`,
        type: 'db',
        startTime: performance.now() - traceStart - duration, // Adjust start time to when op actually started
        duration,
        status: err ? 500 : 0,
        meta: { collection, operation, error: err ? err.message : undefined }
      });
      if (debug) console.log(`[Senzor] Captured Mongo: ${name} (${duration.toFixed(2)}ms)`);
    };

    // --- 1. Instrument Immediate Operations (Insert/Update/Delete) ---
    const immediateMethods = ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'countDocuments'];

    immediateMethods.forEach((method) => {
      if (!Collection.prototype[method]) return;
      const original = Collection.prototype[method];

      Collection.prototype[method] = function (...args: any[]) {
        const trace = Context.current();
        if (!trace) return original.apply(this, args);

        const spanStartAbs = performance.now();
        const traceStart = trace.startTime;
        const collName = this.collectionName;

        try {
          const result = original.apply(this, args);
          if (result && typeof result.then === 'function') {
            return result.then(
              (res: any) => { recordSpan(method, method, collName, spanStartAbs, traceStart); return res; },
              (err: any) => { recordSpan(method, method, collName, spanStartAbs, traceStart, err); throw err; }
            );
          }
          return result;
        } catch (err: any) {
          recordSpan(method, method, collName, spanStartAbs, traceStart, err);
          throw err;
        }
      };
    });

    // --- 2. Instrument Cursor Execution (find -> toArray) ---
    const patchCursor = (CursorClass: any, label: string) => {
      if (!CursorClass || !CursorClass.prototype.toArray) return;

      const originalToArray = CursorClass.prototype.toArray;

      CursorClass.prototype.toArray = function (...args: any[]) {
        const trace = Context.current();
        // Cursors are often created in context but executed later. 
        // We check context at execution time.
        if (!trace) return originalToArray.apply(this, args);

        const spanStartAbs = performance.now();
        const traceStart = trace.startTime;
        // Attempt to get collection name from cursor internal state
        const collName = this.namespace?.collection || 'unknown';

        const onSuccess = (res: any) => {
          recordSpan(label, label, collName, spanStartAbs, traceStart);
          return res;
        };
        const onError = (err: any) => {
          recordSpan(label, label, collName, spanStartAbs, traceStart, err);
          throw err;
        };

        try {
          const result = originalToArray.apply(this, args);
          if (result && typeof result.then === 'function') {
            return result.then(onSuccess, onError);
          }
          return onSuccess(result);
        } catch (e) {
          onError(e);
        }
      };
    };

    patchCursor(FindCursor, 'find');
    patchCursor(AggregationCursor, 'aggregate');

  } catch (e: any) {
    if (debug) console.warn('[Senzor] MongoDB instrumentation warning:', e.message);
  }
};