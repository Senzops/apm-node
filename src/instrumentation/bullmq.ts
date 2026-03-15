import type { SenzorClient } from '../core/client';
import { hookRequire } from './hook';
import { Context } from '../core/context';

const SENZOR_BULL_PATCHED = Symbol.for('senzor.bullmq.patched');

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

export const instrumentBullMQ = (client: SenzorClient, debug: boolean) => {

  hookRequire('bullmq', (bullExports) => {

    for (const target of getTargets(bullExports)) {
      patchWorker(target);
    }

  });

  function patchWorker(target: any) {

    try {

      if (
        !target ||
        !target.Worker ||
        !target.Worker.prototype ||
        typeof target.Worker.prototype.processJob !== 'function'
      ) {
        return;
      }

      const proto = target.Worker.prototype;

      if (proto.processJob[SENZOR_BULL_PATCHED]) {
        return;
      }

      const originalProcessJob = proto.processJob;

      proto.processJob = async function (job: any) {

        const queueDelay = job.timestamp ? Date.now() - job.timestamp : 0;

        // ORIGINAL LOGIC (unchanged)
        const currentAttempt = (job.attemptsMade || 0) + 1;
        const maxAttempts = job.opts?.attempts || 1;
        const isFinalAttempt = currentAttempt >= maxAttempts;

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

              // ORIGINAL EXECUTION (unchanged)
              const result = await originalProcessJob.apply(
                this,
                arguments as any
              );

              client.endTask('success');

              return result;

            } catch (error) {

              // ORIGINAL DLQ LOGIC (unchanged)
              try {

                const context = Context.current();

                if (
                  context &&
                  context.contextType === 'task' &&
                  isFinalAttempt
                ) {
                  context.data.isDeadLetter = true;
                }

              } catch {
                // never break job execution
              }

              // ORIGINAL ERROR CAPTURE (unchanged)
              client.captureError(error, {
                queueName: job.queueName,
                jobId: job.id,
                isDeadLetter: isFinalAttempt
              });

              client.endTask('failed');

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
          '[Senzor] BullMQ Worker successfully instrumented with DLQ tracking'
        );
      }

    }
    catch (err) {

      if (debug) {
        console.error(
          '[Senzor] BullMQ patch error:',
          err
        );
      }

    }

  }

};