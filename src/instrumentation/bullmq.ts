import type { SenzorClient } from '../core/client';
import { hookRequire } from './hook';
import { Context } from '../core/context';

const SENZOR_BULL_PATCHED =
  Symbol.for('senzor.bullmq.patched');

function getTargets(
  exports: any
) {

  const targets = [];

  if (exports) {
    targets.push(exports);
  }

  if (exports?.default) {
    targets.push(exports.default);
  }

  return targets;

}

export const instrumentBullMQ = (
  client: SenzorClient,
  debug: boolean
) => {

  hookRequire(
    'bullmq',
    (bullExports) => {

      try {

        for (const target of getTargets(bullExports)) {
          patchWorker(target);
        }

      }
      catch (err) {

        if (debug) {

          console.error(
            '[Senzor] BullMQ instrumentation error:',
            err
          );

        }

      }

    }
  );

  function patchWorker(
    target: any
  ) {

    if (
      !target ||
      !target.Worker ||
      !target.Worker.prototype
    ) {
      return;
    }

    const proto =
      target.Worker.prototype;

    const original =
      proto.processJob;

    if (
      typeof original !== 'function' ||
      original[SENZOR_BULL_PATCHED]
    ) {
      return;
    }

    proto.processJob =
      async function (
        job: any
      ) {

        const queueDelay =
          job.timestamp
            ? Date.now() - job.timestamp
            : 0;

        const currentAttempt =
          (job.attemptsMade || 0) + 1;

        const maxAttempts =
          job.opts?.attempts || 1;

        const isFinalAttempt =
          currentAttempt >= maxAttempts;

        const taskName =
          job.name === '__default__'
            ? job.queueName
            : `${job.queueName}:${job.name}`;

        return client.startTask(

          taskName,

          'queue',

          {
            queueDelay,
            attempts: currentAttempt,
            isDeadLetter: false,
            metadata: {
              jobId: job.id,
              queueName: job.queueName,
              maxAttempts
            }
          },

          async () => {

            try {

              const result =
                await original.apply(
                  this,
                  arguments as any
                );

              client.endTask(
                'success'
              );

              return result;

            }
            catch (error) {

              try {

                const context =
                  Context.current();

                if (
                  context &&
                  context.contextType === 'task' &&
                  isFinalAttempt
                ) {

                  context.data.isDeadLetter =
                    true;

                }

              }
              catch { }

              client.captureError(
                error,
                {
                  queueName:
                    job.queueName,
                  jobId:
                    job.id,
                  isDeadLetter:
                    isFinalAttempt
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
      SENZOR_BULL_PATCHED,
      {
        value: true,
        enumerable: false
      }
    );

    if (debug) {

      console.log(
        '[Senzor] BullMQ instrumented'
      );

    }

  }

};