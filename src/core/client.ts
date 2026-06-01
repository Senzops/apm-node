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

// Static imports of all instrumentations for reliable Node.js bundling
import { instrumentHttp, instrumentFetch } from '../instrumentation/http';
import { instrumentExpress } from '../instrumentation/express';
import { instrumentFastify } from '../instrumentation/fastify';
import { instrumentKoa } from '../instrumentation/koa';
import { instrumentUndici } from '../instrumentation/undici';
import { instrumentMongo } from '../instrumentation/mongo';
import { instrumentMongoose } from '../instrumentation/mongoose';
import { instrumentPg } from '../instrumentation/pg';
import { instrumentMysql } from '../instrumentation/mysql';
import { instrumentRedis } from '../instrumentation/redis';
import { instrumentBullMQ } from '../instrumentation/bullmq';
import { instrumentNodeCron } from '../instrumentation/cron';
import { instrumentGrpc } from '../instrumentation/grpc';
import { instrumentGraphQL } from '../instrumentation/graphql';
import { instrumentDns } from '../instrumentation/dns';
import { instrumentNet } from '../instrumentation/net';
import { instrumentKafka } from '../instrumentation/kafka';
import { instrumentAmqplib } from '../instrumentation/amqplib';
import { instrumentSocketIO } from '../instrumentation/socketio';
import { instrumentNestJS } from '../instrumentation/nestjs';
import { instrumentHapi } from '../instrumentation/hapi';
import { instrumentPino } from '../instrumentation/pino';
import { instrumentWinston } from '../instrumentation/winston';
import { instrumentBunyan } from '../instrumentation/bunyan';
import { instrumentAwsSdk } from '../instrumentation/aws-sdk';
import { instrumentKnex } from '../instrumentation/knex';
import { instrumentTedious } from '../instrumentation/tedious';
import { instrumentCassandra } from '../instrumentation/cassandra';
import { instrumentMemcached } from '../instrumentation/memcached';
import { instrumentGenericPool } from '../instrumentation/generic-pool';
import { instrumentRestify } from '../instrumentation/restify';
import { instrumentConnect } from '../instrumentation/connect';
import { instrumentDataloader } from '../instrumentation/dataloader';
import { instrumentLruMemoizer } from '../instrumentation/lru-memoizer';
import { instrumentFs } from '../instrumentation/fs';
import { instrumentOpenAI } from '../instrumentation/openai';
import { instrumentAnthropic } from '../instrumentation/anthropic';
import { instrumentGoogleGenAI } from '../instrumentation/google-genai';
import { instrumentAzureOpenAI } from '../instrumentation/azure-openai';
import { instrumentCohere } from '../instrumentation/cohere';
import { instrumentMistral } from '../instrumentation/mistral';
import { instrumentFirebase } from '../instrumentation/firebase';

const MAX_STRINGIFY_LENGTH = 8192;

const safeStringify = (obj: any): string => {
  const seen = new Set();
  let length = 0;
  return JSON.stringify(obj, function (_key, value) {
    if (length > MAX_STRINGIFY_LENGTH) return undefined;
    if (typeof value === 'string') {
      length += value.length;
      if (value.length > 2048) return value.slice(0, 2048) + '...[truncated]';
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
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
        instrumentFetch(endpoint, this.options || undefined);
      }
    } catch {}

    // Node-only instrumentations: http, module hooking, db drivers, etc.
    if (isNode()) {
      try { if (this.isInstrumentationEnabled('http')) { instrumentHttp(this, endpoint, this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('express')) { instrumentExpress(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('fastify')) { instrumentFastify(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('koa')) { instrumentKoa(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('undici')) { instrumentUndici(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('mongo')) { instrumentMongo(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('mongoose')) { instrumentMongoose(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('pg')) { instrumentPg(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('mysql')) { instrumentMysql(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('redis')) { instrumentRedis(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('bullmq')) { instrumentBullMQ(this, debug); } } catch {}
      try { if (this.isInstrumentationEnabled('cron')) { instrumentNodeCron(this, debug); } } catch {}

      // --- Phase 1 Instrumentations ---
      try { if (this.isInstrumentationEnabled('grpc')) { instrumentGrpc(this, this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('graphql')) { instrumentGraphQL(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('dns')) { instrumentDns(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('net')) { instrumentNet(this.options || undefined); } } catch {}

      // --- Phase 2 Instrumentations: Messaging ---
      try { if (this.isInstrumentationEnabled('kafka')) { instrumentKafka(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('amqplib')) { instrumentAmqplib(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('socketio')) { instrumentSocketIO(this.options || undefined); } } catch {}

      // --- Phase 3 Instrumentations: Frameworks & Log Correlation ---
      try { if (this.isInstrumentationEnabled('nestjs')) { instrumentNestJS(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('hapi')) { instrumentHapi(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('pino')) { instrumentPino(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('winston')) { instrumentWinston(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('bunyan')) { instrumentBunyan(this.options || undefined); } } catch {}

      // --- Phase 4 Instrumentations: Cloud & Database ---
      try { if (this.isInstrumentationEnabled('aws-sdk')) { instrumentAwsSdk(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('knex')) { instrumentKnex(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('tedious')) { instrumentTedious(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('cassandra')) { instrumentCassandra(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('memcached')) { instrumentMemcached(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('generic-pool')) { instrumentGenericPool(this.options || undefined); } } catch {}

      // --- Phase 5 Instrumentations: Frameworks, Utilities & AI ---
      try { if (this.isInstrumentationEnabled('restify')) { instrumentRestify(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('connect')) { instrumentConnect(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('dataloader')) { instrumentDataloader(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('lru-memoizer')) { instrumentLruMemoizer(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('fs')) { instrumentFs(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('openai')) { instrumentOpenAI(this.options || undefined); } } catch {}

      // --- Phase 6 Instrumentations: AI SDKs & Firebase ---
      try { if (this.isInstrumentationEnabled('anthropic')) { instrumentAnthropic(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('google-genai')) { instrumentGoogleGenAI(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('azure-openai')) { instrumentAzureOpenAI(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('cohere')) { instrumentCohere(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('mistral')) { instrumentMistral(this.options || undefined); } } catch {}
      try { if (this.isInstrumentationEnabled('firebase')) { instrumentFirebase(this.options || undefined); } } catch {}

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

    const flushAndExit = (code: number) => {
      if (this.transport) {
        const timeout = setTimeout(() => process.exit(code), 2000);
        if (typeof timeout.unref === 'function') timeout.unref();
        this.transport.flush(true).then(
          () => process.exit(code),
          () => process.exit(code)
        );
      } else {
        process.exit(code);
      }
    };

    // Monitor-only: captures for telemetry without altering default crash behavior.
    // Node.js will still print the stack and exit after this listener runs.
    process.on('uncaughtExceptionMonitor', (error) => safeCapture(error, { type: 'uncaughtExceptionMonitor', severity: 'fatal' }));

    process.on('unhandledRejection', (reason) => safeCapture(reason, { type: 'unhandledRejection', severity: 'error' }));
    process.on('warning', (warning) => safeCapture(warning, { type: 'processWarning', severity: 'warning' }));

    let shuttingDown = false;

    const gracefulShutdown = (signal: string, exitCode: number) => {
      if (shuttingDown) return;
      shuttingDown = true;
      safeCapture(new Error(`Process received ${signal}`), { type: 'processSignal', signal, severity: 'warning' });
      flushAndExit(exitCode);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM', 143));
    process.on('SIGINT', () => gracefulShutdown('SIGINT', 130));
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

// ---------------------------------------------------------------------------
// Singleton via globalThis
//
// register.js and index.js are separate bundles, each with their own copy of
// this module. Without a shared instance, register.js patches HTTP with its
// client (Client A), but the user's Senzor.init() sets the transport on
// index.js's client (Client B). Traces go to Client A (no transport) → lost.
//
// Using Symbol.for() ensures the SAME symbol across bundles. The first bundle
// to load creates the instance; subsequent bundles reuse it.
// ---------------------------------------------------------------------------
const SENZOR_CLIENT = Symbol.for('senzor.client.singleton');

const existingClient = (globalThis as any)[SENZOR_CLIENT] as SenzorClient | undefined;

export const client: SenzorClient = existingClient || new SenzorClient();

if (!existingClient) {
  Object.defineProperty(globalThis, SENZOR_CLIENT, {
    value: client,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}
