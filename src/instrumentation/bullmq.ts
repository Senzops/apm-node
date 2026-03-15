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
      job: any
    ) {

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

            const result =
              await original.call(
                this,
                job
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