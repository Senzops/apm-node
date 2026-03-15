import { Transport } from './transport';
import { Context } from './context';
import { SenzorOptions, ActiveTrace, TaskRun } from './types';
import { randomUUID } from 'crypto';
import { instrumentHttp, instrumentFetch } from '../instrumentation/http';
import { instrumentMongo } from '../instrumentation/mongo';
import { instrumentPg } from '../instrumentation/pg';
import { instrumentBullMQ } from '../instrumentation/bullmq';
import { instrumentNodeCron } from '../instrumentation/cron';
import { SDK_META } from '../utils/sdkMeta';

export class SenzorClient {
  private transport: Transport | null = null;
  private options: SenzorOptions | null = null;
  private isInstrumented = false;

  public init(options: SenzorOptions) {
    if (!options.apiKey) {
      console.warn('[Senzor] API Key missing. SDK disabled.');
      return;
    }
    this.options = options;
    const endpoint = options.endpoint || 'https://api.senzor.dev/api/ingest/apm';
    const debug = options.debug || false;

    this.transport = new Transport({ ...options, endpoint });

    if (!this.isInstrumented) {
      this.setupGlobalErrorHandlers();

      try { instrumentHttp(endpoint, debug); } catch (e) { }
      try { instrumentFetch(endpoint, debug); } catch (e) { }
      try { instrumentMongo(debug); } catch (e) { }
      try { instrumentPg(); } catch (e) { }

      // Task Integrations (NEW)
      try { instrumentBullMQ(this, debug); } catch (e) { }
      try { instrumentNodeCron(this, debug); } catch (e) { }

      this.isInstrumented = true;
      if (debug) console.log('[Senzor] Auto-instrumentation & Error Tracking enabled');
    }
  }

  private setupGlobalErrorHandlers() {
    if ((process as any).__senzorGlobalHandlersInstalled) {
      return;
    }

    (process as any).__senzorGlobalHandlersInstalled = true;

    const getProcessContext = () => {
      try {
        return {
          pid: process.pid,
          ppid: process.ppid,
          platform: process.platform,
          uptimeSec: Math.floor(process.uptime()),
          env: process.env.NODE_ENV || 'unknown'
        };
      } catch {
        return {};
      }
    };

    const getMemoryContext = () => {
      try {
        const mem = process.memoryUsage();
        return {
          rss: mem.rss,
          heapTotal: mem.heapTotal,
          heapUsed: mem.heapUsed,
          external: mem.external,
          arrayBuffers: mem.arrayBuffers
        };
      } catch {
        return {};
      }
    };

    const safeCapture = (error: unknown, meta: any = {}) => {
      try {
        let parsedError: Error;
        if (error instanceof Error) {
          parsedError = error;
        } else if (typeof error === 'string') {
          parsedError = new Error(error);
        } else {
          try {
            parsedError = new Error(JSON.stringify(error));
          } catch {
            parsedError = new Error('Non-serializable rejection reason');
          }
        }
        const enrichedMeta = {
          ...meta,
          runtime: {
            name: 'node',
            version: process.version
          },
          process: getProcessContext(),
          memory: getMemoryContext(),
          sdk: {
            name: SDK_META.name,
            version: SDK_META.version
          }
        };

        this.captureError(parsedError, enrichedMeta);
      } catch (internalFailure) {
        // NEVER allow SDK to crash host app
        try {
          if (this.options?.debug) {
            console.error('[Senzor] Error handler failure:', internalFailure);
          }
        } catch { }
      }
    };

    process.on('uncaughtExceptionMonitor', (error) => {
      safeCapture(error, {
        type: 'uncaughtExceptionMonitor',
        severity: 'fatal'
      });
    });

    process.on('uncaughtException', (error) => {
      safeCapture(error, {
        type: 'uncaughtException',
        severity: 'fatal'
      });
    });

    process.on('unhandledRejection', (reason) => {
      safeCapture(reason, {
        type: 'unhandledRejection',
        severity: 'error'
      });
    });

    process.on('warning', (warning) => {
      safeCapture(warning, {
        type: 'processWarning',
        severity: 'warning'
      });
    });

    process.on('multipleResolves', (type, promise, reason) => {
      safeCapture(reason || new Error('Multiple promise resolves'), {
        type: 'multipleResolves',
        resolveType: type,
        severity: 'warning'
      });
    });

    process.on('rejectionHandled', (promise) => {
      if (this.options?.debug) {
        try {
          console.warn('[Senzor] rejectionHandled event detected');
        } catch { }
      }
    });

    process.on('SIGTERM', () => {
      safeCapture(
        new Error('Process received SIGTERM'),
        {
          type: 'processSignal',
          signal: 'SIGTERM'
        }
      );
    });

    process.on('SIGINT', () => {
      safeCapture(
        new Error('Process received SIGINT'),
        {
          type: 'processSignal',
          signal: 'SIGINT'
        }
      );
    });
  }

  public startTrace<T>(data: Partial<ActiveTrace['data']> & { headers?: any }, next: () => T): T {
    if (!this.transport) return next();

    let parentTraceId = undefined;
    let parentSpanId = undefined;

    if (data.headers) {
      const getHeader = (key: string) => {
        if (data.headers[key]) return data.headers[key];
        if (data.headers[key.toLowerCase()]) return data.headers[key.toLowerCase()];
        return undefined;
      };

      parentTraceId = getHeader('x-senzor-trace-id');
      parentSpanId = getHeader('x-senzor-parent-span-id');

      if (Array.isArray(parentTraceId)) parentTraceId = parentTraceId[0];
      if (Array.isArray(parentSpanId)) parentSpanId = parentSpanId[0];
    }

    const trace: ActiveTrace = {
      id: randomUUID(),
      contextType: 'apm', // Ensure we distinguish APM traces from Background Tasks
      startTime: performance.now(),
      data: {
        ...data,
        parentTraceId,
        parentSpanId
      },
      spans: []
    };

    return Context.run(trace, next);
  }

  public endTrace(status: number, extraData: any = {}) {
    const trace = Context.current();
    if (!trace || trace.contextType !== 'apm' || !this.transport) return;
    const duration = performance.now() - trace.startTime;

    const payload = {
      traceId: trace.id,
      parentTraceId: trace.data.parentTraceId,
      parentSpanId: trace.data.parentSpanId,
      ...trace.data,
      ...extraData,
      status, duration, spans: trace.spans, timestamp: new Date().toISOString()
    };
    this.transport.addTrace(payload);
  }

  // --- TASK MONITORING METHODS ---
  public startTask<T>(name: string, type: 'cron' | 'queue' | 'pipeline' | 'custom', options: any, next: () => T): T {
    if (!this.transport) return next();

    const currentContext = Context.current();
    const triggerTraceId = currentContext?.contextType === 'apm' ? currentContext.id : undefined;

    // Snapshot system resources before execution
    const startMemory = process.memoryUsage ? process.memoryUsage().heapUsed : 0;
    const startCpu = process.cpuUsage ? process.cpuUsage() : undefined;

    const task: ActiveTrace = {
      id: randomUUID(),
      contextType: 'task',
      startTime: performance.now(),
      startMemory,
      startCpu,
      data: { taskName: name, taskType: type, triggerTraceId, ...options },
      spans: []
    };
    return Context.run(task, next);
  }

  public endTask(status: 'success' | 'failed', extraMetadata: any = {}) {
    const task = Context.current();
    if (!task || task.contextType !== 'task' || !this.transport) return;

    // Calculate resource deltas
    let resourceMetrics;
    if (process.memoryUsage && task.startMemory !== undefined && process.cpuUsage && task.startCpu) {
      const endMemory = process.memoryUsage().heapUsed;
      const cpuDelta = process.cpuUsage(task.startCpu);

      resourceMetrics = {
        memoryDeltaBytes: endMemory - task.startMemory, // Can be negative if GC ran!
        cpuUserUs: cpuDelta.user,
        cpuSystemUs: cpuDelta.system
      };
    }

    const payload: TaskRun = {
      runId: task.id,
      taskName: task.data.taskName,
      taskType: task.data.taskType,
      triggerTraceId: task.data.triggerTraceId,
      queueDelay: task.data.queueDelay,
      attempts: task.data.attempts,
      isDeadLetter: task.data.isDeadLetter, // Extracted from options/metadata if provided
      metadata: { ...task.data.metadata, ...extraMetadata },
      resourceMetrics,
      status,
      duration: performance.now() - task.startTime,
      spans: task.spans,
      timestamp: new Date().toISOString()
    };

    this.transport.addTask(payload);
  }

  public wrapTask<T extends (...args: any[]) => any>(name: string, type: 'cron' | 'queue' | 'pipeline' | 'custom', options: any = {}, fn: T): T {
    return (async (...args: any[]) => {
      return this.startTask(name, type, options, async () => {
        try {
          const result = await fn(...args);
          this.endTask('success');
          return result;
        } catch (error) {
          this.captureError(error, { taskName: name });
          this.endTask('failed');
          throw error;
        }
      });
    }) as unknown as T;
  }

  // --- MODIFIED: Context-Aware Error Capture ---
  public captureError(error: unknown, context: any = {}) {
    if (!this.transport) return;

    let parsedError: Error;
    if (error instanceof Error) {
      parsedError = error;
    } else {
      parsedError = new Error(String(error));
    }

    const currentTrace = Context.current();

    const errPayload = {
      errorClass: parsedError.name || 'Error',
      message: parsedError.message,
      stackTrace: parsedError.stack,
      context,
      timestamp: new Date().toISOString()
    };

    if (currentTrace?.contextType === 'task') {
      this.transport.addError({ ...errPayload, runId: currentTrace.id }, 'task');
    } else {
      this.transport.addError({ ...errPayload, traceId: currentTrace?.id }, 'apm');
    }
  }

  public track(data: any) {
    this.transport?.addTrace({ traceId: randomUUID(), ...data, spans: [], timestamp: new Date().toISOString() });
  }

  public startSpan(name: string, type: 'db' | 'http' | 'function' | 'custom' = 'custom') {
    const trace = Context.current();
    if (!trace) return { end: () => { } };
    const startTime = performance.now() - trace.startTime;
    const spanStartAbs = performance.now();
    const spanId = randomUUID();
    return { end: (meta?: any, status?: number) => { Context.addSpan({ spanId, name, type, startTime, duration: performance.now() - spanStartAbs, status, meta }); } };
  }

  public async flush() { if (this.transport) await this.transport.flush(); }
}

export const client = new SenzorClient();