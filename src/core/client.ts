import { Transport } from './transport';
import { Context } from './context';
import { SenzorOptions, ActiveTrace, TaskRun, SenzorLog } from './types';
import { isNode } from './runtime';
import { SDK_META } from '../utils/sdkMeta';
import { parseTraceparent } from '../utils/traceContext';
import { generateSpanId, generateTraceId } from '../utils/ids';
import { sanitizeAttributes } from './sanitizer';
import { startCapturedSpan } from '../instrumentation/span';
import { RuntimeMetricsCollector } from '../instrumentation/runtime';

// Memory-safe JSON stringifier to handle cyclical objects 
// (like Express 'req' objects) passed into console.log
const safeStringify = (obj: any): string => {
  const cache = new Set();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (cache.has(value)) return '[Circular]';
      cache.add(value);
    }
    return value;
  });
};

export class SenzorClient {
  private transport: Transport | null = null;
  private options: SenzorOptions | null = null;
  private isInstrumented = false;
  private runtimeMetricsCollector: RuntimeMetricsCollector | null = null;

  public preload(options: Partial<SenzorOptions> = {}) {
    const endpoint = options.endpoint || 'https://api.senzor.dev/api/ingest/apm';
    const debug = options.debug || false;

    this.options = {
      apiKey: '',
      ...this.options,
      ...options
    };

    this.installNativeInstrumentations(endpoint, debug);
  }

  public init(options: SenzorOptions) {
    if (!options.apiKey) {
      console.warn('[Senzor] API Key missing. SDK disabled.');
      return;
    }
    this.options = options;
    const endpoint = options.endpoint || 'https://api.senzor.dev/api/ingest/apm';
    const debug = options.debug || false;

    this.transport = new Transport({ ...options, endpoint });
    this.installNativeInstrumentations(endpoint, debug);
  }

  private isInstrumentationEnabled(name: string): boolean {
    const setting = this.options?.instrumentations;
    if (setting === false) return false;
    if (Array.isArray(setting)) return setting.includes(name);
    return true;
  }

  private installNativeInstrumentations(endpoint: string, debug: boolean) {
    if (this.isInstrumented) return;

    this.setupGlobalErrorHandlers();
    this.setupLogInterception();

    // Fetch instrumentation works on all runtimes (Workers, Node, Bun, Deno)
    try {
      if (this.isInstrumentationEnabled('fetch')) {
        const { instrumentFetch } = require('../instrumentation/http');
        instrumentFetch(endpoint, this.options || undefined);
      }
    } catch {}

    // Node-only instrumentations: http, module hooking, db drivers, etc.
    if (isNode()) {
      try { if (this.isInstrumentationEnabled('http')) { const { instrumentHttp } = require('../instrumentation/http'); instrumentHttp(this, endpoint, this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('express')) { const { instrumentExpress } = require('../instrumentation/express'); instrumentExpress(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('fastify')) { const { instrumentFastify } = require('../instrumentation/fastify'); instrumentFastify(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('koa')) { const { instrumentKoa } = require('../instrumentation/koa'); instrumentKoa(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('undici')) { const { instrumentUndici } = require('../instrumentation/undici'); instrumentUndici(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('mongo')) { const { instrumentMongo } = require('../instrumentation/mongo'); instrumentMongo(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('mongoose')) { const { instrumentMongoose } = require('../instrumentation/mongoose'); instrumentMongoose(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('pg')) { const { instrumentPg } = require('../instrumentation/pg'); instrumentPg(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('mysql')) { const { instrumentMysql } = require('../instrumentation/mysql'); instrumentMysql(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('redis')) { const { instrumentRedis } = require('../instrumentation/redis'); instrumentRedis(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('bullmq')) { const { instrumentBullMQ } = require('../instrumentation/bullmq'); instrumentBullMQ(this, debug); } } catch {}
      try { if (this.isInstrumentationEnabled('cron')) { const { instrumentNodeCron } = require('../instrumentation/cron'); instrumentNodeCron(this, debug); } } catch {}

      // --- Phase 1 Instrumentations ---
      try { if (this.isInstrumentationEnabled('grpc')) { const { instrumentGrpc } = require('../instrumentation/grpc'); instrumentGrpc(this, this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('graphql')) { const { instrumentGraphQL } = require('../instrumentation/graphql'); instrumentGraphQL(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('dns')) { const { instrumentDns } = require('../instrumentation/dns'); instrumentDns(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('net')) { const { instrumentNet } = require('../instrumentation/net'); instrumentNet(this.options || undefined); } } catch {}

      // --- Runtime Metrics ---
      if (this.options?.runtimeMetrics !== false && this.transport) {
        try {
          this.runtimeMetricsCollector = new RuntimeMetricsCollector({
            interval: this.options?.runtimeMetricsInterval ?? 15000,
            onMetrics: (payload) => {
              this.transport?.addRuntimeMetrics(payload);
            },
          });
          this.runtimeMetricsCollector.start();
        } catch {}
      }
    }

    this.isInstrumented = true;
    if (debug) console.log('[Senzor] Auto-instrumentation enabled');
  }

  // --- Enterprise Auto-Log Interception ---
  private setupLogInterception() {
    if (this.options?.autoLogs === false) return; // Opt-out check

    const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug
    };

    let isIntercepting = false; // Lock to prevent SDK internal logs from looping infinitely

    levels.forEach(level => {
      console[level] = (...args: any[]) => {
        // Always execute original console so user's terminal isn't broken
        originalConsole[level].apply(console, args);

        if (isIntercepting || !this.transport) return;
        isIntercepting = true;

        try {
          let message = '';
          let attributes: Record<string, any> = {};

          args.forEach(arg => {
            if (typeof arg === 'string') {
              message += (message ? ' ' : '') + arg;
            } else if (arg instanceof Error) {
              message += (message ? ' ' : '') + arg.message;
              attributes.errorStack = arg.stack;
              attributes.errorName = arg.name;
            } else if (typeof arg === 'object' && arg !== null) {
              try {
                // New Relic Style Destructuring: Merge all object keys into `attributes`
                const parsed = JSON.parse(safeStringify(arg));
                attributes = { ...attributes, ...sanitizeAttributes(parsed, this.options || undefined) };
              } catch (e) {
                attributes.unparseableObject = true;
              }
            } else {
              message += (message ? ' ' : '') + String(arg);
            }
          });

          // Fallback if the user purely logged an object without text e.g., console.log({ user: 123 })
          if (!message && Object.keys(attributes).length > 0) {
            message = 'Object Log';
          }

          // Attach to Active Context seamlessly (Works for BOTH APM and Tasks!)
          const currentTrace = Context.current();
          const logType = currentTrace?.contextType === 'task' ? 'task' : 'apm';

          const logPayload: SenzorLog = {
            message: message || 'Empty log',
            level: level === 'log' ? 'info' : level, // Map generic log -> info
            attributes,
            timestamp: new Date().toISOString()
          };

          // Attach the specific contextual ID
          if (currentTrace) {
            if (logType === 'task') logPayload.runId = currentTrace.id;
            else logPayload.traceId = currentTrace.id;
          }

          this.transport.addLog(logPayload, logType);
        } catch (e) {
          // Absolute failure isolation. Never crash host app during logging.
        } finally {
          isIntercepting = false; // Release lock
        }
      };
    });
  }

  private setupGlobalErrorHandlers() {
    if (!isNode()) return;

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
          runtime: { name: 'node', version: process.version },
          process: getProcessContext(),
          memory: getMemoryContext(),
          sdk: { name: SDK_META.name, version: SDK_META.version }
        };

        this.captureError(parsedError, enrichedMeta);
      } catch (internalFailure) {
        try {
          if (this.options?.debug) {
            console.error('[Senzor] Error handler failure:', internalFailure);
          }
        } catch { }
      }
    };

    process.on('uncaughtExceptionMonitor', (error) => safeCapture(error, { type: 'uncaughtExceptionMonitor', severity: 'fatal' }));
    process.on('uncaughtException', (error) => safeCapture(error, { type: 'uncaughtException', severity: 'fatal' }));
    process.on('unhandledRejection', (reason) => safeCapture(reason, { type: 'unhandledRejection', severity: 'error' }));
    process.on('warning', (warning) => safeCapture(warning, { type: 'processWarning', severity: 'warning' }));
    process.on('multipleResolves', (type, promise, reason) => safeCapture(reason || new Error('Multiple promise resolves'), { type: 'multipleResolves', resolveType: type, severity: 'warning' }));
    process.on('rejectionHandled', (promise) => { if (this.options?.debug) { try { console.warn('[Senzor] rejectionHandled event detected'); } catch { } } });
    process.on('SIGTERM', () => safeCapture(new Error('Process received SIGTERM'), { type: 'processSignal', signal: 'SIGTERM' }));
    process.on('SIGINT', () => safeCapture(new Error('Process received SIGINT'), { type: 'processSignal', signal: 'SIGINT' }));
  }

  public startTrace<T>(data: Partial<ActiveTrace['data']> & { headers?: any }, next: () => T): T {
    if (!this.transport) return next();

    const existingTrace = Context.current();
    if (existingTrace?.contextType === 'apm') {
      Object.assign(existingTrace.data, data);
      return next();
    }

    let inheritedTraceId: string | undefined = undefined;
    let inheritedParentSpanId: string | undefined = undefined;

    if (data.headers) {
      const getHeader = (key: string) => {
        if (data.headers[key]) return data.headers[key];
        if (data.headers[key.toLowerCase()]) return data.headers[key.toLowerCase()];
        return undefined;
      };

      const traceparent = getHeader('traceparent');
      const parsedContext = parseTraceparent(traceparent);

      if (parsedContext) {
        inheritedTraceId = parsedContext.traceId;
        inheritedParentSpanId = parsedContext.parentSpanId;
      } else {
        const rawTrace = getHeader('x-senzor-trace-id');
        const rawSpan = getHeader('x-senzor-parent-span-id');
        inheritedTraceId = Array.isArray(rawTrace) ? rawTrace[0] : rawTrace;
        inheritedParentSpanId = Array.isArray(rawSpan) ? rawSpan[0] : rawSpan;
      }
    }

    const activeTraceId = inheritedTraceId || generateTraceId();
    const rootSpanId = generateSpanId();

    const trace: ActiveTrace = {
      id: activeTraceId,
      contextType: 'apm',
      startTime: performance.now(),
      rootSpanId,
      activeSpanId: rootSpanId,
      data: { ...data, parentTraceId: inheritedTraceId, parentSpanId: inheritedParentSpanId, rootSpanId },
      spans: [],
      maxSpans: this.options?.maxSpansPerTrace ?? 500,
      state: {
        ended: false,
        droppedSpans: 0
      }
    };

    return Context.run(trace, next);
  }

  public endTrace(status: number, extraData: any = {}) {
    const trace = Context.current();
    if (!trace || trace.contextType !== 'apm' || !this.transport) return;
    if (trace.state.ended) return;
    trace.state.ended = true;
    const duration = performance.now() - trace.startTime;

    const payload = {
      traceId: trace.id,
      parentTraceId: trace.data.parentTraceId,
      parentSpanId: trace.data.parentSpanId,
      rootSpanId: trace.rootSpanId,
      ...trace.data,
      ...extraData,
      status,
      duration,
      spans: trace.spans,
      droppedSpans: trace.state.droppedSpans,
      timestamp: new Date().toISOString()
    };
    this.transport.addTrace(payload);
  }

  // --- TASK MONITORING METHODS ---
  public startTask<T>(name: string, type: 'cron' | 'queue' | 'pipeline' | 'custom', options: any, next: () => T): T {
    if (!this.transport) return next();

    const currentContext = Context.current();
    const triggerTraceId = currentContext?.contextType === 'apm' ? currentContext.id : undefined;

    const startMemory = isNode() && process.memoryUsage ? process.memoryUsage().heapUsed : 0;
    const startCpu = isNode() && process.cpuUsage ? process.cpuUsage() : undefined;

    const task: ActiveTrace = {
      id: generateTraceId(),
      contextType: 'task',
      startTime: performance.now(),
      rootSpanId: generateSpanId(),
      startMemory,
      startCpu,
      data: { taskName: name, taskType: type, triggerTraceId, ...options },
      spans: [],
      maxSpans: this.options?.maxSpansPerTrace ?? 500,
      state: {
        ended: false,
        droppedSpans: 0
      }
    };
    task.activeSpanId = task.rootSpanId;
    return Context.run(task, next);
  }

  public endTask(status: 'success' | 'failed', extraMetadata: any = {}) {
    const task = Context.current();
    if (!task || task.contextType !== 'task' || !this.transport) return;
    if (task.state.ended) return;
    task.state.ended = true;

    let resourceMetrics;
    if (isNode() && process.memoryUsage && task.startMemory !== undefined && process.cpuUsage && task.startCpu) {
      const endMemory = process.memoryUsage().heapUsed;
      const cpuDelta = process.cpuUsage(task.startCpu);

      resourceMetrics = {
        memoryDeltaBytes: endMemory - task.startMemory,
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
      isDeadLetter: task.data.isDeadLetter,
      metadata: { ...task.data.metadata, ...extraMetadata, droppedSpans: task.state.droppedSpans },
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
      context: sanitizeAttributes(context, this.options || undefined),
      timestamp: new Date().toISOString()
    };

    if (currentTrace?.contextType === 'task') {
      this.transport.addError({ ...errPayload, runId: currentTrace.id }, 'task');
    } else {
      this.transport.addError({ ...errPayload, traceId: currentTrace?.id }, 'apm');
    }
  }

  public track(data: any) {
    this.transport?.addTrace({ traceId: generateTraceId(), ...data, spans: [], timestamp: new Date().toISOString() });
  }

  public startSpan(name: string, type: 'db' | 'http' | 'function' | 'custom' = 'custom') {
    const span = startCapturedSpan(name, type, {}, this.options || undefined);
    if (!span) return { end: () => { } };
    return { end: (meta?: any, status?: number) => span.end(status, meta) };
  }

  public async flush() { if (this.transport) await this.transport.flush(); }
}

export const client = new SenzorClient();
