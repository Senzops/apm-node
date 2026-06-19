import type { SenzorClient } from '../core/client';
import { hookRequire } from './hook';
import { Context } from '../core/context';

const PATCHED =
  Symbol.for(
    'senzor.bullmq.patched'
  );

function patchWorker(
  target: any,
  client: SenzorClient,
  debug: boolean
) {

  if (
    !target?.Worker?.prototype
  ) {
    return;
  }

  const proto =
    target.Worker.prototype;

  const original =
    proto.processJob;

  if (
    typeof original !==
    'function' ||
    original[PATCHED]
  ) {
    return;
  }

  proto.processJob =
    async function (
      this: any,
      ...args: any[]
    ) {

      const job = args[0];

      // Forward straight through if this isn't a recognizable job. The wrapper
      // must never alter BullMQ's control flow for unexpected inputs.
      if (!job || typeof job !== 'object') {
        return original.apply(this, args);
      }

      const queueDelay =
        job.timestamp
          ? Date.now() -
          job.timestamp
          : 0;

      const currentAttempt =
        (job.attemptsMade || 0)
        + 1;

      const maxAttempts =
        job.opts?.attempts
        ?? 1;

      const isFinal =
        currentAttempt >=
        maxAttempts;

      const taskName =
        job.name ===
          '__default__'
          ? job.queueName
          : `${job.queueName}:${job.name}`;

      return client.startTask(

        taskName,

        'queue',

        {
          queueDelay,
          attempts:
            currentAttempt,
          isDeadLetter: false,
          metadata: {
            jobId: job.id,
            queueName:
              job.queueName,
            maxAttempts
          }
        },

        async () => {

          try {

            // Forward EVERY argument BullMQ passed (job, token,
            // fetchNextCallback, ...). The `token` is the per-job lock token —
            // dropping it makes lock renewal and moveToFinished use an empty
            // token, producing "Lock mismatch" (code -6) errors. Forwarding all
            // args also preserves concurrency backpressure (fetchNextCallback)
            // and any future BullMQ signature additions.
            const result =
              await original.apply(
                this,
                args
              );

            client.endTask(
              'success'
            );

            return result;

          }
          catch (error) {

            try {

              const ctx =
                Context.current();

              if (
                ctx &&
                ctx.contextType === 'task' &&
                isFinal
              ) {

                ctx.data
                  .isDeadLetter =
                  true;

              }

            }
            catch { }

            client.captureError(
              error,
              {
                queueName:
                  job.queueName,
                jobId: job.id,
                isDeadLetter:
                  isFinal
              }
            );

            client.endTask(
              'failed'
            );

            throw error;

          }

        }

      );

    };

  Object.defineProperty(
    proto.processJob,
    PATCHED,
    {
      value: true
    }
  );

  if (debug) {

    console.log(
      '[Senzor] BullMQ instrumented'
    );

  }

}

export const instrumentBullMQ =
  (
    client: SenzorClient,
    debug: boolean
  ) => {

    hookRequire(
      'bullmq',
      (exports: any) => {

        patchWorker(
          exports,
          client,
          debug
        );

        if (exports?.default) {

          patchWorker(
            exports.default,
            client,
            debug
          );

        }

      }
    );

  };