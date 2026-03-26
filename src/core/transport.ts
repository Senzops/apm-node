import { SenzorOptions, Trace, TaskRun, SenzorError, SenzorLog } from './types';

export class Transport {
  private traceQueue: Trace[] = [];
  private apmErrorQueue: SenzorError[] = [];
  private apmLogQueue: SenzorLog[] = []; // APM Logs

  private taskQueue: TaskRun[] = [];
  private taskErrorQueue: SenzorError[] = [];
  private taskLogQueue: SenzorLog[] = []; // Task Logs

  private timer: NodeJS.Timeout | null = null;
  private apmEndpoint: string;
  private taskEndpoint: string;

  constructor(private config: SenzorOptions) {
    const baseEndpoint = config.endpoint || 'https://api.senzor.dev';
    // Support legacy full URLs or base URLs
    this.apmEndpoint = baseEndpoint.includes('/api/ingest') ? baseEndpoint : `${baseEndpoint}/api/ingest/apm`;
    this.taskEndpoint = baseEndpoint.includes('/api/ingest') ? baseEndpoint.replace('/apm', '/task') : `${baseEndpoint}/api/ingest/task`;

    if (typeof setInterval !== 'undefined') {
      this.timer = setInterval(() => this.flush(), config.flushInterval || 10000);
      if (this.timer && typeof this.timer.unref === 'function') {
        this.timer.unref();
      }
    }
  }

  public addTrace(trace: any) {
    this.traceQueue.push(trace);
    this.checkFlush();
  }

  public addTask(task: TaskRun) {
    this.taskQueue.push(task);
    this.checkFlush();
  }

  public addError(error: SenzorError, type: 'apm' | 'task' = 'apm') {
    if (type === 'task') this.taskErrorQueue.push(error);
    else this.apmErrorQueue.push(error);
    this.checkFlush();
  }

  // Add captured log to the correct batch queue
  public addLog(log: SenzorLog, type: 'apm' | 'task' = 'apm') {
    if (type === 'task') this.taskLogQueue.push(log);
    else this.apmLogQueue.push(log);
    this.checkFlush();
  }

  private checkFlush() {
    const totalApm = this.traceQueue.length + this.apmErrorQueue.length + this.apmLogQueue.length;
    const totalTask = this.taskQueue.length + this.taskErrorQueue.length + this.taskLogQueue.length;
    if (totalApm >= (this.config.batchSize || 100) || totalTask >= (this.config.batchSize || 100)) {
      this.flush();
    }
  }

  public async flush() {
    const apmPayload = {
      traces: [...this.traceQueue],
      errors: [...this.apmErrorQueue],
      logs: [...this.apmLogQueue]
    };
    const taskPayload = {
      runs: [...this.taskQueue],
      errors: [...this.taskErrorQueue],
      logs: [...this.taskLogQueue]
    };

    // Reset Queues instantly
    this.traceQueue = [];
    this.apmErrorQueue = [];
    this.apmLogQueue = [];
    this.taskQueue = [];
    this.taskErrorQueue = [];
    this.taskLogQueue = [];

    const headers = { 'Content-Type': 'application/json', 'x-service-api-key': this.config.apiKey };

    try {
      const promises = [];

      // Piggyback logs onto APM/Task batch ingestion to bypass extra network round-trips
      if (apmPayload.traces.length > 0 || apmPayload.errors.length > 0 || apmPayload.logs.length > 0) {
        promises.push(fetch(this.apmEndpoint, { method: 'POST', headers, body: JSON.stringify(apmPayload), keepalive: true }));
      }

      if (taskPayload.runs.length > 0 || taskPayload.errors.length > 0 || taskPayload.logs.length > 0) {
        promises.push(fetch(this.taskEndpoint, { method: 'POST', headers, body: JSON.stringify(taskPayload), keepalive: true }));
      }

      await Promise.allSettled(promises);

      if (this.config.debug) {
        console.log(`[Senzor] Flushed: APM(${apmPayload.traces.length} traces, ${apmPayload.logs.length} logs), Task(${taskPayload.runs.length} runs, ${taskPayload.logs.length} logs)`);
      }
    } catch (err) {
      if (this.config.debug) console.error('[Senzor] Transport Flush Error:', err);
    }
  }
}