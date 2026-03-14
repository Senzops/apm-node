import type { SenzorClient } from '../core/client';
import { hookRequire } from './hook';

export const instrumentBullMQ = (client: SenzorClient, debug: boolean) => {
  hookRequire('bullmq', (bullExports) => {

    const patchWorker = (target: any) => {
      if (!target || !target.Worker || !target.Worker.prototype.processJob || target.Worker.prototype.processJob.__senzorPatched) return;

      const originalProcessJob = target.Worker.prototype.processJob;

      target.Worker.prototype.processJob = async function (job: any) {
        const queueDelay = job.timestamp ? Date.now() - job.timestamp : 0;

        // BullMQ increments attemptsMade *after* a failure. 
        // So the current run attempt is attemptsMade + 1.
        const currentAttempt = (job.attemptsMade || 0) + 1;
        const maxAttempts = job.opts?.attempts || 1;

        // If it fails on this run, and it's >= the max allowed attempts, it's entering the DLQ.
        const isFinalAttempt = currentAttempt >= maxAttempts;

        const taskName = job.name === '__default__' ? job.queueName : `${job.queueName}:${job.name}`;

        return client.startTask(
          taskName,
          'queue',
          {
            queueDelay,
            attempts: currentAttempt,
            // We preset isDeadLetter to false, but if it throws an error and isFinalAttempt is true, 
            // we will mutate this in the catch block.
            isDeadLetter: false,
            metadata: { jobId: job.id, queueName: job.queueName, maxAttempts }
          },
          async () => {
            try {
              const result = await originalProcessJob.apply(this, arguments);
              client.endTask('success');
              return result;
            } catch (error) {
              const context = require('../core/context').Context.current();
              if (context && context.contextType === 'task' && isFinalAttempt) {
                context.data.isDeadLetter = true; // Flag it as a permanent failure
              }

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

      Object.defineProperty(target.Worker.prototype.processJob, '__senzorPatched', { value: true, enumerable: false, writable: true });
      if (debug) console.log('[Senzor] BullMQ Worker successfully instrumented with DLQ tracking');
    };

    patchWorker(bullExports);

    if (bullExports.default) {
      patchWorker(bullExports.default);
    }
  });
};