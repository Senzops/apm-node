import { SENZOR_INTERNAL_HEADER } from '../utils/internal';
import { SenzorOptions, Trace, TaskRun, SenzorError, SenzorLog, AiTracePayload, AiGenerationPayload, AiScorePayload } from './types';
import type { RuntimeMetricsPayload } from '../instrumentation/runtime';

interface ApmPayload {
  traces: Trace[];
  errors: SenzorError[];
  logs: SenzorLog[];
  runtimeMetrics?: RuntimeMetricsPayload[];
}

interface TaskPayload {
  runs: TaskRun[];
  errors: SenzorError[];
  logs: SenzorLog[];
}

interface AiPayload {
  aiTraces: AiTracePayload[];
  aiGenerations: AiGenerationPayload[];
  aiScores: AiScorePayload[];
  errors: SenzorError[];
  logs: SenzorLog[];
}

const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;

// Default ceiling for a single ingest request body. Kept under common 1 MB
// server body limits so a flush never produces an unsendable, oversized POST.
const DEFAULT_MAX_BATCH_BYTES = 900_000;

// Headroom reserved for the JSON envelope (object braces, array keys) and
// request headers on top of the packed array items.
const WRAPPER_OVERHEAD_BYTES = 2_048;

/**
 * HTTP-level ingest failure carrying the response status, so the transport can
 * distinguish retryable (network / 5xx / 429) from non-retryable (4xx) errors.
 */
class IngestHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Senzor ingest failed with status ${status}`);
    this.name = 'IngestHttpError';
  }
}

/** Universal UTF-8 byte length (Node Buffer, then TextEncoder, then length). */
const byteLength = (str: string): number => {
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(str);
  }
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).length;
  }
  return str.length;
};

/** A single bounded ingest request plus the means to restore its items on a retryable failure. */
interface FlushRequest {
  endpoint: string;
  body: Record<string, unknown>;
  count: number;
  restore: () => void;
}

export class Transport {
  private traceQueue: Trace[] = [];
  private apmErrorQueue: SenzorError[] = [];
  private apmLogQueue: SenzorLog[] = [];
  private runtimeMetricsQueue: RuntimeMetricsPayload[] = [];

  private taskQueue: TaskRun[] = [];
  private taskErrorQueue: SenzorError[] = [];
  private taskLogQueue: SenzorLog[] = [];

  private aiTraceQueue: AiTracePayload[] = [];
  private aiGenerationQueue: AiGenerationPayload[] = [];
  private aiScoreQueue: AiScorePayload[] = [];
  private aiErrorQueue: SenzorError[] = [];
  private aiLogQueue: SenzorLog[] = [];

  private timer: ReturnType<typeof setInterval> | null = null;
  private timerStarted = false;
  private apmEndpoint: string;
  private taskEndpoint: string;
  private aiEndpoint: string;
  private isFlushing = false;
  private flushAgain = false;
  private droppedItems = 0;

  private consecutiveFailures = 0;
  private backoffUntil = 0;

  private readonly maxBatchBytes: number;

  constructor(private config: SenzorOptions) {
    this.maxBatchBytes = Math.max(
      WRAPPER_OVERHEAD_BYTES * 2,
      config.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES
    );

    const baseEndpoint = config.endpoint || 'https://api.senzor.dev';
    this.apmEndpoint = baseEndpoint.includes('/api/ingest')
      ? baseEndpoint
      : `${baseEndpoint}/api/ingest/apm`;
    this.taskEndpoint = baseEndpoint.includes('/api/ingest')
      ? baseEndpoint.replace('/apm', '/task')
      : `${baseEndpoint}/api/ingest/task`;
    this.aiEndpoint = baseEndpoint.includes('/api/ingest')
      ? baseEndpoint.replace('/apm', '/ai')
      : `${baseEndpoint}/api/ingest/ai`;
  }

  private ensureTimer() {
    if (this.timerStarted) return;
    this.timerStarted = true;

    try {
      if (typeof setInterval !== 'undefined') {
        this.timer = setInterval(
          () => void this.flush(),
          this.config.flushInterval || 10000
        );
        if (this.timer && typeof (this.timer as any).unref === 'function') {
          (this.timer as any).unref();
        }
      }
    } catch {}

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

  public addRuntimeMetrics(payload: RuntimeMetricsPayload) {
    this.enqueue(this.runtimeMetricsQueue, payload);
  }

  public addAiTrace(trace: AiTracePayload) {
    this.enqueue(this.aiTraceQueue, trace);
    this.checkFlush();
  }

  public addAiGeneration(generation: AiGenerationPayload) {
    this.enqueue(this.aiGenerationQueue, generation);
    this.checkFlush();
  }

  public addAiScore(score: AiScorePayload) {
    this.enqueue(this.aiScoreQueue, score);
    this.checkFlush();
  }

  public addAiError(error: SenzorError) {
    this.enqueue(this.aiErrorQueue, error);
    this.checkFlush();
  }

  public addAiLog(log: SenzorLog) {
    this.enqueue(this.aiLogQueue, log);
    this.checkFlush();
  }

  private enqueue<T>(queue: T[], item: T) {
    this.ensureTimer();
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
    const totalAi =
      this.aiTraceQueue.length +
      this.aiGenerationQueue.length +
      this.aiScoreQueue.length +
      this.aiErrorQueue.length +
      this.aiLogQueue.length;

    if (
      totalApm >= (this.config.batchSize || 100) ||
      totalTask >= (this.config.batchSize || 100) ||
      totalAi >= (this.config.batchSize || 100)
    ) {
      void this.flush();
    }
  }

  private takeApmPayload(): ApmPayload {
    const payload: ApmPayload = {
      traces: this.traceQueue,
      errors: this.apmErrorQueue,
      logs: this.apmLogQueue,
    };

    if (this.runtimeMetricsQueue.length > 0) {
      payload.runtimeMetrics = this.runtimeMetricsQueue;
      this.runtimeMetricsQueue = [];
    }

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

  private takeAiPayload(): AiPayload {
    const payload: AiPayload = {
      aiTraces: this.aiTraceQueue,
      aiGenerations: this.aiGenerationQueue,
      aiScores: this.aiScoreQueue,
      errors: this.aiErrorQueue,
      logs: this.aiLogQueue,
    };

    this.aiTraceQueue = [];
    this.aiGenerationQueue = [];
    this.aiScoreQueue = [];
    this.aiErrorQueue = [];
    this.aiLogQueue = [];
    return payload;
  }

  /**
   * Greedily packs `items` into chunks whose serialized size stays under the
   * per-request budget. A single item larger than the budget can never be sent
   * (it would always be rejected for size) and is dropped + counted rather than
   * left to block the queue forever (poison-message guard).
   */
  private chunkBySize<T>(items: T[], targetBytes: number): T[][] {
    if (!items.length) return [];

    const budget = Math.max(1, targetBytes - WRAPPER_OVERHEAD_BYTES);
    const chunks: T[][] = [];
    let current: T[] = [];
    let currentBytes = 0;

    for (const item of items) {
      let itemBytes: number;
      try {
        // +1 accounts for the comma separator between array elements.
        itemBytes = byteLength(JSON.stringify(item)) + 1;
      } catch {
        // Unserializable (e.g. circular) — it can never be sent. Drop it.
        this.droppedItems++;
        continue;
      }

      if (itemBytes > budget) {
        this.droppedItems++;
        if (this.config.debug) {
          console.warn(
            `[Senzor] Dropped oversized item (${itemBytes}B > ${budget}B budget); cannot fit a single request`
          );
        }
        continue;
      }

      if (current.length && currentBytes + itemBytes > budget) {
        chunks.push(current);
        current = [];
        currentBytes = 0;
      }

      current.push(item);
      currentBytes += itemBytes;
    }

    if (current.length) chunks.push(current);
    return chunks;
  }

  private buildApmRequests(payload: ApmPayload): FlushRequest[] {
    const requests: FlushRequest[] = [];
    const max = this.maxBatchBytes;

    const push = (items: any[], key: string, queue: any[]) => {
      for (const chunk of this.chunkBySize(items, max)) {
        requests.push({
          endpoint: this.apmEndpoint,
          body: { traces: [], errors: [], logs: [], runtimeMetrics: [], [key]: chunk },
          count: chunk.length,
          restore: () => this.prependWithLimit(queue, chunk)
        });
      }
    };

    push(payload.traces, 'traces', this.traceQueue);
    push(payload.errors, 'errors', this.apmErrorQueue);
    push(payload.logs, 'logs', this.apmLogQueue);
    if (payload.runtimeMetrics?.length) {
      push(payload.runtimeMetrics, 'runtimeMetrics', this.runtimeMetricsQueue);
    }

    return requests;
  }

  private buildTaskRequests(payload: TaskPayload): FlushRequest[] {
    const requests: FlushRequest[] = [];
    const max = this.maxBatchBytes;

    const push = (items: any[], key: string, queue: any[]) => {
      for (const chunk of this.chunkBySize(items, max)) {
        requests.push({
          endpoint: this.taskEndpoint,
          body: { runs: [], errors: [], logs: [], [key]: chunk },
          count: chunk.length,
          restore: () => this.prependWithLimit(queue, chunk)
        });
      }
    };

    push(payload.runs, 'runs', this.taskQueue);
    push(payload.errors, 'errors', this.taskErrorQueue);
    push(payload.logs, 'logs', this.taskLogQueue);

    return requests;
  }

  private buildAiRequests(payload: AiPayload): FlushRequest[] {
    const requests: FlushRequest[] = [];
    const max = this.maxBatchBytes;

    const push = (items: any[], key: string, queue: any[]) => {
      for (const chunk of this.chunkBySize(items, max)) {
        requests.push({
          endpoint: this.aiEndpoint,
          body: { aiTraces: [], aiGenerations: [], aiScores: [], errors: [], logs: [], [key]: chunk },
          count: chunk.length,
          restore: () => this.prependWithLimit(queue, chunk)
        });
      }
    };

    push(payload.aiTraces, 'aiTraces', this.aiTraceQueue);
    push(payload.aiGenerations, 'aiGenerations', this.aiGenerationQueue);
    push(payload.aiScores, 'aiScores', this.aiScoreQueue);
    push(payload.errors, 'errors', this.aiErrorQueue);
    push(payload.logs, 'logs', this.aiLogQueue);

    return requests;
  }

  /**
   * Network errors, timeouts and aborts are transient and safe to retry. A 4xx
   * (except 408/425/429) is a permanent rejection — retrying the same payload
   * is futile and would lock the queue, so it is treated as non-retryable.
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof IngestHttpError) {
      const s = error.status;
      return s === 408 || s === 425 || s === 429 || s >= 500;
    }
    return true;
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
        throw new IngestHttpError(response.status);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  public async flush(force = false) {
    if (this.isFlushing) {
      this.flushAgain = true;
      return;
    }

    if (!force && Date.now() < this.backoffUntil) return;

    this.isFlushing = true;

    try {
      do {
        this.flushAgain = false;

        const apmPayload = this.takeApmPayload();
        const taskPayload = this.takeTaskPayload();
        const aiPayload = this.takeAiPayload();

        // Split the drained queues into size-bounded requests so no single
        // POST can exceed the ingest endpoint's body limit.
        const requests = [
          ...this.buildApmRequests(apmPayload),
          ...this.buildTaskRequests(taskPayload),
          ...this.buildAiRequests(aiPayload)
        ];

        if (!requests.length) continue;

        let backedOff = false;
        let sent = 0;

        for (let i = 0; i < requests.length; i++) {
          const request = requests[i];

          // Once a retryable failure occurs this cycle, stop hitting the
          // endpoint and return the remaining requests to their queues so the
          // backoff window is respected.
          if (backedOff) {
            request.restore();
            continue;
          }

          try {
            await this.postJson(request.endpoint, request.body);
            sent++;
          } catch (error) {
            if (this.isRetryableError(error)) {
              request.restore();
              backedOff = true;
            } else {
              // Permanent rejection (4xx) — retrying is futile and would lock
              // the queue. Drop the items so the pipeline keeps flowing.
              this.droppedItems += request.count;
              if (this.config.debug) {
                console.warn(
                  `[Senzor] Dropped ${request.count} item(s) — non-retryable ingest error:`,
                  (error as Error)?.message
                );
              }
            }
          }
        }

        if (backedOff) {
          this.consecutiveFailures++;
          const delay = Math.min(
            BASE_BACKOFF_MS * Math.pow(2, this.consecutiveFailures - 1),
            MAX_BACKOFF_MS
          );
          this.backoffUntil = Date.now() + delay;
          this.flushAgain = false; // honor backoff — don't loop again now
          if (this.config.debug) {
            console.warn(`[Senzor] Flush backing off ${delay}ms (attempt ${this.consecutiveFailures})`);
          }
        } else {
          this.consecutiveFailures = 0;
          this.backoffUntil = 0;
        }

        if (this.config.debug) {
          console.log(
            `[Senzor] Flushed ${sent}/${requests.length} request(s), backoff=${backedOff}, dropped=${this.droppedItems}`
          );
        }

        if (backedOff) break;
      } while (this.flushAgain);
    } catch (err) {
      if (this.config.debug) console.error('[Senzor] Transport Flush Error:', err);
    } finally {
      this.isFlushing = false;
    }
  }

  private installShutdownFlush() {
    if (typeof process === 'undefined' || typeof process.once !== 'function') return;

    const key = Symbol.for('senzor.transport.shutdownFlushInstalled');
    const proc = process as unknown as Record<symbol, boolean>;
    if (proc[key]) return;

    Object.defineProperty(proc, key, {
      value: true,
      enumerable: false
    });

    const flushBestEffort = () => {
      void this.flush();
    };

    process.once('beforeExit', flushBestEffort);
  }
}
