import type { SenzorClient } from '../core/client';
import { hookRequire } from './hook';

export const instrumentBullMQ = (client: SenzorClient, debug: boolean) => {
  hookRequire('bullmq', (bullExports) => {

    const patchWorker = (target: any) => {
      if (!target || !target.Worker || !target.Worker.prototype.processJob || target.Worker.prototype.processJob.__senzorPatched) return;

      const originalProcessJob = target.Worker.prototype.processJob;

      target.Worker.prototype.processJob = async function (job: any) {
        const queueDelay = job.timestamp ? Date.now() - job.timestamp : 0;
        const attempts = (job.attemptsMade || 0) + 1;
        const taskName = job.name === '__default__' ? job.queueName : `${job.queueName}:${job.name}`;

        return client.startTask(
          taskName,
          'queue',
          { queueDelay, attempts, metadata: { jobId: job.id, queueName: job.queueName } },
          async () => {
            try {
              const result = await originalProcessJob.apply(this, arguments);
              client.endTask('success');
              return result;
            } catch (error) {
              client.captureError(error, { queueName: job.queueName, jobId: job.id });
              client.endTask('failed');
              throw error;
            }
          }
        );
      };

      Object.defineProperty(target.Worker.prototype.processJob, '__senzorPatched', { value: true, enumerable: false, writable: true });
      if (debug) console.log('[Senzor] BullMQ Worker successfully instrumented');
    };

    patchWorker(bullExports);

    if (bullExports.default) {
      patchWorker(bullExports.default);
    }
  });
};