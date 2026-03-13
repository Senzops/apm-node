import type { SenzorClient } from '../core/client';

export const instrumentBullMQ = (client: SenzorClient, debug: boolean) => {
  let bullmq: any;
  try {
    bullmq = require('bullmq');
  } catch (e) {
    return; // BullMQ not installed in host project
  }

  if (!bullmq.Worker || !bullmq.Worker.prototype.processJob) return;

  const originalProcessJob = bullmq.Worker.prototype.processJob;

  bullmq.Worker.prototype.processJob = async function (job: any) {
    // job.timestamp is when it was added to redis. Date.now() is when worker picked it up.
    const queueDelay = job.timestamp ? Date.now() - job.timestamp : 0;
    const attempts = (job.attemptsMade || 0) + 1;
    const taskName = job.name === '__default__' ? job.queueName : `${job.queueName}:${job.name}`;

    return client.startTask(
      taskName,
      'queue',
      { queueDelay, attempts, metadata: { jobId: job.id, queueName: job.queueName } },
      async () => {
        try {
          // Pass context to original processor
          const result = await originalProcessJob.apply(this, arguments);
          client.endTask('success');
          return result;
        } catch (error) {
          client.captureError(error, { 
             queueName: job.queueName, 
             jobId: job.id, 
             attemptsMade: job.attemptsMade 
          });
          client.endTask('failed');
          throw error; // Re-throw so BullMQ handles retries/DLQ natively
        }
      }
    );
  };

  if (debug) console.log('[Senzor] BullMQ Worker auto-instrumentation active');
};