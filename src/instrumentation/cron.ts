import type { SenzorClient } from '../core/client';

export const instrumentNodeCron = (client: SenzorClient, debug: boolean) => {
  let cron: any;
  try {
    cron = require('node-cron');
  } catch (e) {
    return; // node-cron not installed in host project
  }

  if (!cron.schedule) return;

  const originalSchedule = cron.schedule;

  // FIXED: Replaced `Function` with `(...args: any[]) => any` to satisfy TypeScript strict mode
  cron.schedule = function (expression: string, func: (...args: any[]) => any, options: any) {
    // Generate a unique name for the cron job if a name option isn't provided
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
};