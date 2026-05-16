import { SENZOR_INTERNAL_HEADER } from '../utils/internal';
import { SenzorOptions, Trace, TaskRun, SenzorError, SenzorLog } from './types';

interface ApmPayload {
  traces: Trace[];
  errors: SenzorError[];
  logs: SenzorLog[];
}

interface TaskPayload {
  runs: TaskRun[];
  errors: SenzorError[];
  logs: SenzorLog[];
}

export class Transport {
  private traceQueue: Trace[] = [];
  private apmErrorQueue: SenzorError[] = [];
  private apmLogQueue: SenzorLog[] = [];

  private taskQueue: TaskRun[] = [];
  private taskErrorQueue: SenzorError[] = [];
  private taskLogQueue: SenzorLog[] = [];

  private timer: NodeJS.Timeout | null = null;
  private apmEndpoint: string;
  private taskEndpoint: string;
  private isFlushing = false;
  private flushAgain = false;
  private droppedItems = 0;

  constructor(private config: SenzorOptions) {
    const baseEndpoint = config.endpoint || 'https://api.senzor.dev';
    this.apmEndpoint = baseEndpoint.includes('/api/ingest')
      ? baseEndpoint
      : `${baseEndpoint}/api/ingest/apm`;
    this.taskEndpoint = baseEndpoint.includes('/api/ingest')
      ? baseEndpoint.replace('/apm', '/task')
      : `${baseEndpoint}/api/ingest/task`;

    if (typeof setInterval !== 'undefined') {
      this.timer = setInterval(
        () => void this.flush(),
        config.flushInterval || 10000
      );
      if (this.timer && typeof this.timer.unref === 'function') {
        this.timer.unref();
      }
    }

    this.installShutdownFlush();
  }

  public addTrace(trace: any) {
    this.enqueue(this.traceQueue, trace);
    this.checkFlush();
  }

  public addTask(task: TaskRun) {
    this.enqueue(this.taskQueue, task);
    this.checkFlush();
  }

  public addError(error: SenzorError, type: 'apm' | 'task' = 'apm') {
    this.enqueue(
      type === 'task' ? this.taskErrorQueue : this.apmErrorQueue,
      error
    );
    this.checkFlush();
  }

  public addLog(log: SenzorLog, type: 'apm' | 'task' = 'apm') {
    this.enqueue(
      type === 'task' ? this.taskLogQueue : this.apmLogQueue,
      log
    );
    this.checkFlush();
  }

  private enqueue<T>(queue: T[], item: T) {
    queue.push(item);

    const maxQueueSize = this.config.maxQueueSize ?? 10000;
    while (queue.length > maxQueueSize) {
      queue.shift();
      this.droppedItems++;
    }
  }

  private prependWithLimit<T>(queue: T[], items: T[]) {
    if (!items.length) return;
    queue.unshift(...items);

    const maxQueueSize = this.config.maxQueueSize ?? 10000;
    while (queue.length > maxQueueSize) {
      queue.pop();
      this.droppedItems++;
    }
  }

  private checkFlush() {
    const totalApm =
      this.traceQueue.length +
      this.apmErrorQueue.length +
      this.apmLogQueue.length;
    const totalTask =
      this.taskQueue.length +
      this.taskErrorQueue.length +
      this.taskLogQueue.length;

    if (
      totalApm >= (this.config.batchSize || 100) ||
      totalTask >= (this.config.batchSize || 100)
    ) {
      void this.flush();
    }
  }

  private takeApmPayload(): ApmPayload {
    const payload = {
      traces: this.traceQueue,
      errors: this.apmErrorQueue,
      logs: this.apmLogQueue
    };

    this.traceQueue = [];
    this.apmErrorQueue = [];
    this.apmLogQueue = [];
    return payload;
  }

  private takeTaskPayload(): TaskPayload {
    const payload = {
      runs: this.taskQueue,
      errors: this.taskErrorQueue,
      logs: this.taskLogQueue
    };

    this.taskQueue = [];
    this.taskErrorQueue = [];
    this.taskLogQueue = [];
    return payload;
  }

  private restoreApmPayload(payload: ApmPayload) {
    this.prependWithLimit(this.apmLogQueue, payload.logs);
    this.prependWithLimit(this.apmErrorQueue, payload.errors);
    this.prependWithLimit(this.traceQueue, payload.traces);
  }

  private restoreTaskPayload(payload: TaskPayload) {
    this.prependWithLimit(this.taskLogQueue, payload.logs);
    this.prependWithLimit(this.taskErrorQueue, payload.errors);
    this.prependWithLimit(this.taskQueue, payload.runs);
  }

  private hasApmPayload(payload: ApmPayload): boolean {
    return (
      payload.traces.length > 0 ||
      payload.errors.length > 0 ||
      payload.logs.length > 0
    );
  }

  private hasTaskPayload(payload: TaskPayload): boolean {
    return (
      payload.runs.length > 0 ||
      payload.errors.length > 0 ||
      payload.logs.length > 0
    );
  }

  private async postJson(endpoint: string, payload: unknown) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.flushTimeoutMs ?? 5000
    );

    if (typeof timeout.unref === 'function') timeout.unref();

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-api-key': this.config.apiKey,
          [SENZOR_INTERNAL_HEADER]: 'true'
        },
        body: JSON.stringify(payload),
        keepalive: true,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Senzor ingest failed with status ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  public async flush() {
    if (this.isFlushing) {
      this.flushAgain = true;
      return;
    }

    this.isFlushing = true;

    try {
      do {
        this.flushAgain = false;

        const apmPayload = this.takeApmPayload();
        const taskPayload = this.takeTaskPayload();
        const sends: Promise<void>[] = [];

        if (this.hasApmPayload(apmPayload)) {
          sends.push(
            this.postJson(this.apmEndpoint, apmPayload).catch((error) => {
              this.restoreApmPayload(apmPayload);
              throw error;
            })
          );
        }

        if (this.hasTaskPayload(taskPayload)) {
          sends.push(
            this.postJson(this.taskEndpoint, taskPayload).catch((error) => {
              this.restoreTaskPayload(taskPayload);
              throw error;
            })
          );
        }

        if (!sends.length) continue;

        const results = await Promise.allSettled(sends);
        const failures = results.filter(
          (result) => result.status === 'rejected'
        );

        if (this.config.debug) {
          console.log(
            `[Senzor] Flushed: APM(${apmPayload.traces.length} traces, ${apmPayload.logs.length} logs), Task(${taskPayload.runs.length} runs, ${taskPayload.logs.length} logs), failures=${failures.length}, dropped=${this.droppedItems}`
          );
        }
      } while (this.flushAgain);
    } catch (err) {
      if (this.config.debug) console.error('[Senzor] Transport Flush Error:', err);
    } finally {
      this.isFlushing = false;
    }
  }

  private installShutdownFlush() {
    const key = Symbol.for('senzor.transport.shutdownFlushInstalled');
    const proc = process as unknown as Record<symbol, boolean>;
    if (proc[key]) return;

    Object.defineProperty(proc, key, {
      value: true,
      enumerable: false
    });

    const flushSyncBestEffort = () => {
      void this.flush();
    };

    process.once('beforeExit', flushSyncBestEffort);
  }
}
