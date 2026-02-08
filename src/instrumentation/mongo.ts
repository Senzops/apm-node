import { Context } from '../core/context';

export const instrumentMongo = (debug = false) => {
  try {
    // Attempt to load the user's installed mongodb driver
    // This works for both native driver users and Mongoose users (as mongoose depends on this)
    const mongodb = require('mongodb');
    const Collection = mongodb.Collection;

    if (debug) console.log('[Senzor] Instrumenting MongoDB...');

    // Methods that return Promises
    const promiseMethods = [
      'insertOne', 'insertMany', 'updateOne', 'updateMany',
      'replaceOne', 'deleteOne', 'deleteMany', 'count', 'countDocuments',
      'estimatedDocumentCount', 'distinct'
    ];

    // Methods that return Cursors (need special handling)
    const cursorMethods = ['find', 'aggregate'];

    // 1. Instrument Promise-based methods
    promiseMethods.forEach((method) => {
      if (!Collection.prototype[method]) return;
      const original = Collection.prototype[method];

      Collection.prototype[method] = function (...args: any[]) {
        const trace = Context.current();
        if (!trace) return original.apply(this, args);

        const startTime = performance.now() - trace.startTime;
        const spanStartAbs = performance.now();
        const collectionName = this.collectionName;

        const endSpan = (err?: Error) => {
          const duration = performance.now() - spanStartAbs;
          Context.addSpan({
            name: `MongoDB ${method} (${collectionName})`,
            type: 'db',
            startTime,
            duration,
            status: err ? 500 : 0,
            meta: { collection: collectionName, operation: method }
          });
          if (debug) console.log(`[Senzor] Captured Mongo Span: ${method}`);
        };

        try {
          const result = original.apply(this, args);
          if (result && typeof result.then === 'function') {
            return result.then(
              (res: any) => { endSpan(); return res; },
              (err: any) => { endSpan(err); throw err; }
            );
          }
          return result;
        } catch (err: any) {
          endSpan(err);
          throw err;
        }
      };
    });

    // 2. Instrument Cursor-based methods (find, aggregate)
    // We trace the *creation* of the cursor, not the fetching, as fetching is async/streamed
    cursorMethods.forEach((method) => {
      if (!Collection.prototype[method]) return;
      const original = Collection.prototype[method];

      Collection.prototype[method] = function (...args: any[]) {
        const trace = Context.current();
        if (!trace) return original.apply(this, args);

        const startTime = performance.now() - trace.startTime;

        // Record the intent to query
        Context.addSpan({
          name: `MongoDB ${method} (${this.collectionName})`,
          type: 'db',
          startTime,
          duration: 0, // Placeholder, as cursor creation is instant
          status: 0,
          meta: { collection: this.collectionName, operation: method }
        });

        if (debug) console.log(`[Senzor] Captured Mongo Cursor: ${method}`);

        return original.apply(this, args);
      };
    });

  } catch (e: any) {
    if (debug) console.warn('[Senzor] MongoDB instrumentation skipped:', e.message);
  }
};