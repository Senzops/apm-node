import type { SenzorClient } from '../core/client';
import { hookRequire } from './hook';

const SENZOR_CRON_PATCHED =
  Symbol.for('senzor.nodecron.patched');

function getTargets(exports: any) {

  const targets = [];

  if (exports) {
    targets.push(exports);
  }

  if (exports?.default) {
    targets.push(exports.default);
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

      for (const target of getTargets(cronExports)) {
        patchSchedule(target);
      }

    }
  );

  function patchSchedule(target: any) {

    if (
      !target ||
      typeof target.schedule !== 'function' ||
      target[SENZOR_CRON_PATCHED]
    ) {
      return;
    }

    const originalSchedule = target.schedule;

    target.schedule = function () {

      try {

        const expression = arguments[0];
        const func = arguments[1];
        const options = arguments[2];

        if (typeof func !== 'function') {
          return originalSchedule.apply(
            this,
            arguments as any
          );
        }

        const optsObj =
          typeof options === 'object' &&
            options !== null
            ? options
            : options
              ? { timezone: options }
              : {};

        const taskName =
          optsObj?.name ||
          `cron: ${expression}`;

        const wrapped =
          client.wrapTask(
            taskName,
            'cron',
            {
              metadata: optsObj,
              expression
            },
            func
          );

        const newArgs = [
          expression,
          wrapped,
          options
        ];

        return originalSchedule.apply(
          this,
          newArgs
        );

      }
      catch (err) {

        if (debug) {
          console.error(
            '[Senzor] Node-Cron patch error:',
            err
          );
        }

        return originalSchedule.apply(
          this,
          arguments as any
        );

      }

    };

    Object.defineProperty(
      target,
      SENZOR_CRON_PATCHED,
      {
        value: true,
        enumerable: false
      }
    );

    if (debug) {

      console.log(
        '[Senzor] Node-Cron successfully instrumented'
      );

    }

  }

};