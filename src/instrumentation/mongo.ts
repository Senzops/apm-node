import { Context } from '../core/context';

export const instrumentMongo = () => {
  try {
    const mongodb = require('mongodb');
    const Collection = mongodb.Collection;

    const methods = [
      'find',
      'findOne',
      'insertOne',
      'insertMany',
      'updateOne',
      'updateMany',
      'deleteOne',
      'deleteMany',
      'aggregate',
      'countDocuments'
    ];

    methods.forEach((method) => {
      if (!Collection.prototype[method]) return;

      const original = Collection.prototype[method];

      Collection.prototype[method] = function (...args: any[]) {
        const trace = Context.current();
        // If not inside a tracked request, just run normally
        if (!trace) return original.apply(this, args);

        const startTime = performance.now() - trace.startTime;
        const spanStartAbs = performance.now();
        const collectionName = this.collectionName;

        // Helper to finish span
        const endSpan = (err?: Error) => {
          const duration = performance.now() - spanStartAbs;
          Context.addSpan({
            name: `MongoDB ${method} (${collectionName})`,
            type: 'db',
            startTime,
            duration,
            status: err ? 500 : 0,
            meta: {
              collection: collectionName,
              operation: method,
              error: err ? err.message : undefined
            }
          });
        };

        try {
          const result = original.apply(this, args);

          // Handle Promise/Cursor
          if (result && typeof result.then === 'function') {
            return result.then(
              (res: any) => { endSpan(); return res; },
              (err: any) => { endSpan(err); throw err; }
            );
          }
          // Handle FindCursor (it doesn't execute immediately, but for APM visuals we mark start/return)
          // Ideally we'd wrap toArray() but that's complex. For 'find', we just mark the creation.
          endSpan();
          return result;

        } catch (err: any) {
          endSpan(err);
          throw err;
        }
      };
    });

  } catch (e) {
    // User doesn't use mongodb, ignore
  }
};