import { SenzorOptions, Trace, TaskRun, SenzorError } from './types';

export class Transport {
  private traceQueue: Trace[] = [];
  private apmErrorQueue: SenzorError[] = [];

  private taskQueue: TaskRun[] = [];
  private taskErrorQueue: SenzorError[] = [];

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

  private checkFlush() {
    const totalApm = this.traceQueue.length + this.apmErrorQueue.length;
    const totalTask = this.taskQueue.length + this.taskErrorQueue.length;
    if (totalApm >= (this.config.batchSize || 100) || totalTask >= (this.config.batchSize || 100)) {
      this.flush();
    }
  }

  public async flush() {
    const apmPayload = { traces: [...this.traceQueue], errors: [...this.apmErrorQueue] };
    const taskPayload = { runs: [...this.taskQueue], errors: [...this.taskErrorQueue] };

    this.traceQueue = [];
    this.apmErrorQueue = [];
    this.taskQueue = [];
    this.taskErrorQueue = [];

    const headers = { 'Content-Type': 'application/json', 'x-service-api-key': this.config.apiKey };

    try {
      const promises = [];

      if (apmPayload.traces.length > 0 || apmPayload.errors.length > 0) {
        promises.push(fetch(this.apmEndpoint, { method: 'POST', headers, body: JSON.stringify(apmPayload), keepalive: true }));
      }

      if (taskPayload.runs.length > 0 || taskPayload.errors.length > 0) {
        promises.push(fetch(this.taskEndpoint, { method: 'POST', headers, body: JSON.stringify(taskPayload), keepalive: true }));
      }

      await Promise.allSettled(promises);

      if (this.config.debug) {
        console.log(`[Senzor] Flushed: ${apmPayload.traces.length} traces, ${taskPayload.runs.length} tasks`);
      }
    } catch (err) {
      if (this.config.debug) console.error('[Senzor] Transport Flush Error:', err);
    }
  }
}