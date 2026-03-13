import type { SenzorClient } from '../core/client';
import { hookRequire } from './hook';

export const instrumentNodeCron = (client: SenzorClient, debug: boolean) => {
  hookRequire('node-cron', (cronExports) => {

    // Abstracted patcher so we can apply it to both the root and the .default export
    const patchSchedule = (target: any) => {
      if (!target || typeof target.schedule !== 'function' || target.__senzorPatched) return;

      const originalSchedule = target.schedule;

      target.schedule = function (expression: string, func: (...args: any[]) => any, options: any) {
        // Handle node-cron's dynamic options argument (can be string or object)
        const optsObj = typeof options === 'object' ? options : { timezone: options };
        const taskName = optsObj?.name || `cron: ${expression}`;

        const wrappedFunc = client.wrapTask(
          taskName,
          'cron',
          { metadata: optsObj },
          func
        );

        return originalSchedule.call(this, expression, wrappedFunc, options);
      };

      // Safely mark as patched to prevent infinite loops
      Object.defineProperty(target, '__senzorPatched', { value: true, enumerable: false, writable: true });
      if (debug) console.log('[Senzor] Node-Cron successfully instrumented');
    };

    // Apply patch to root (for const cron = require('node-cron'))
    patchSchedule(cronExports);

    // Apply patch to default (for import cron from 'node-cron')
    if (cronExports.default) {
      patchSchedule(cronExports.default);
    }
  });
};