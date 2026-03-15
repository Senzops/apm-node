import type { SenzorClient } from '../core/client';
import { hookRequire } from './hook';

const PATCHED =
  Symbol.for('senzor.cron.patched');

type CronHandler =
  (...args: unknown[]) => unknown;

type CronSchedule =
  (
    expression: string,
    handler: CronHandler,
    options?: unknown
  ) => unknown;

function normalizeOptions(
  options: unknown
): Record<string, unknown> {

  if (
    typeof options === 'object' &&
    options !== null
  ) {
    return options as Record<
      string,
      unknown
    >;
  }

  // backward compatibility with:
  // cron.schedule(expr, fn, "UTC")
  if (options) {
    return { timezone: options };
  }

  return {};

}

function patchTarget(
  target: Record<string, unknown>,
  client: SenzorClient,
  debug: boolean
): void {

  const schedule =
    target.schedule as
    CronSchedule | undefined;

  if (
    typeof schedule !== 'function' ||
    (schedule as any)[PATCHED]
  ) {
    return;
  }

  const original =
    schedule;

  const wrapped: CronSchedule =
    function (
      this: unknown,
      expression,
      handler,
      options
    ) {

      if (
        typeof handler !==
        'function'
      ) {

        return original.call(
          this,
          expression,
          handler,
          options
        );

      }

      try {

        const opts =
          normalizeOptions(
            options
          );

        const taskName =
          (opts as any)?.name ??
          `cron: ${expression}`;

        const wrappedHandler =
          client.wrapTask(
            taskName,
            'cron',
            {
              expression,
              metadata: opts
            },
            handler
          );

        return original.call(
          this,
          expression,
          wrappedHandler,
          options
        );

      }
      catch (err) {

        if (debug) {

          console.error(
            '[Senzor] cron wrap failed',
            err
          );

        }

        return original.call(
          this,
          expression,
          handler,
          options
        );

      }

    };

  Object.defineProperty(
    wrapped,
    PATCHED,
    {
      value: true,
      enumerable: false
    }
  );

  // Some ESM namespace exports are frozen
  try {

    target.schedule =
      wrapped;

  }
  catch {

    if (debug) {

      console.warn(
        '[Senzor] unable to patch cron schedule (readonly export)'
      );

    }

  }

  if (debug) {

    console.log(
      '[Senzor] node-cron instrumented'
    );

  }

}

export const instrumentNodeCron =
  (
    client: SenzorClient,
    debug: boolean
  ): void => {

    hookRequire(
      'node-cron',
      (exports: any) => {

        if (!exports) return;

        patchTarget(
          exports,
          client,
          debug
        );

        if (exports.default) {

          patchTarget(
            exports.default,
            client,
            debug
          );

        }

      }
    );

  };