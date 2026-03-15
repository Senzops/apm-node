import type { SenzorClient } from '../core/client';
import { hookRequire } from './hook';

const SENZOR_CRON_PATCHED =
  Symbol.for('senzor.nodecron.patched');

type ScheduleFn =
  (expression: string,
    func: (...args: unknown[]) => unknown,
    options?: unknown) => unknown;

function getTargets(
  exports: unknown
): any[] {

  const targets: any[] = [];

  if (exports) {
    targets.push(exports);
  }

  if ((exports as any)?.default) {
    targets.push((exports as any).default);
  }

  return targets;

}

export const instrumentNodeCron = (
  client: SenzorClient,
  debug: boolean
) => {

  hookRequire(
    'node-cron',
    (cronExports) => {

      try {

        for (const target of getTargets(cronExports)) {
          patchSchedule(target);
        }

      }
      catch (err) {

        if (debug) {

          console.error(
            '[Senzor] cron instrumentation error:',
            err
          );

        }

      }

    }
  );

  function patchSchedule(
    target: any
  ): void {

    if (!target) return;

    const schedule =
      target.schedule as ScheduleFn;

    if (
      typeof schedule !== 'function' ||
      (schedule as any)[SENZOR_CRON_PATCHED]
    ) {
      return;
    }

    const originalSchedule =
      schedule;

    const wrappedSchedule: ScheduleFn =
      function (
        this: unknown,
        expression,
        func,
        options
      ) {

        if (typeof func !== 'function') {

          return originalSchedule.call(
            this,
            expression,
            func,
            options
          );

        }

        try {

          const optsObj =
            typeof options === 'object' &&
              options !== null
              ? options as Record<string, unknown>
              : options
                ? { timezone: options }
                : {};

          const taskName =
            (optsObj as any)?.name ||
            `cron: ${expression}`;

          const wrapped =
            client.wrapTask(
              taskName,
              'cron',
              {
                expression,
                metadata: optsObj
              },
              func
            );

          return originalSchedule.call(
            this,
            expression,
            wrapped,
            options
          );

        }
        catch (err) {

          if (debug) {

            console.error(
              '[Senzor] cron wrap failed:',
              err
            );

          }

          return originalSchedule.call(
            this,
            expression,
            func,
            options
          );

        }

      };

    Object.defineProperty(
      wrappedSchedule,
      SENZOR_CRON_PATCHED,
      {
        value: true,
        enumerable: false
      }
    );

    target.schedule =
      wrappedSchedule;

    if (debug) {

      console.log(
        '[Senzor] Node-Cron instrumented'
      );

    }

  }

};