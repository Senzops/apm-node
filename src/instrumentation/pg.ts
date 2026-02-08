import { Context } from '../core/context';

// Simple shim for 'pg' library
export const instrumentPg = () => {
  try {
    // Try to require pg (it might not be installed by user)
    const pg = require('pg');
    const originalQuery = pg.Client.prototype.query;

    pg.Client.prototype.query = function (...args: any[]) {
      const trace = Context.current();
      if (!trace) return originalQuery.apply(this, args);

      const startTime = performance.now() - trace.startTime;
      const spanStartAbs = performance.now();

      // Extract SQL (first arg usually string or config object)
      const sql = typeof args[0] === 'string' ? args[0] : args[0].text;

      // Wrap callback if present, or handle Promise
      const result = originalQuery.apply(this, args);

      if (result && typeof result.then === 'function') {
        return result.then((res: any) => {
          const duration = performance.now() - spanStartAbs;
          Context.addSpan({
            name: 'Postgres Query',
            type: 'db',
            startTime,
            duration,
            meta: { query: sql }
          });
          return res;
        });
      }
      return result;
    };
  } catch (e) {
    // User doesn't use pg, ignore
  }
};