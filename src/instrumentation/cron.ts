import type { SenzorClient } from '../core/client';
import { hookRequire } from './hook';

export const instrumentNodeCron = (client: SenzorClient, debug: boolean) => {
  hookRequire('node-cron', (cronExports) => {
    if (!cronExports.schedule) return;

    const originalSchedule = cronExports.schedule;

    // Mutate the export so that destructuring extracts our wrapped function
    cronExports.schedule = function (expression: string, func: (...args: any[]) => any, options: any) {
      const taskName = options?.name || `cron: ${expression}`;

      const wrappedFunc = client.wrapTask(
        taskName,
        'cron',
        { metadata: { expression, timezone: options?.timezone } },
        func
      );

      return originalSchedule.call(this, expression, wrappedFunc, options);
    };

    if (debug) console.log('[Senzor] Node-Cron auto-instrumentation active');
  });
};