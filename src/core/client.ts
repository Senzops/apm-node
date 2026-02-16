import { Transport } from './transport';
import { Context } from './context';
import { SenzorOptions, ActiveTrace } from './types';
import { randomUUID } from 'crypto';
import { instrumentHttp, instrumentFetch } from '../instrumentation/http';
import { instrumentMongo } from '../instrumentation/mongo';
import { instrumentPg } from '../instrumentation/pg';

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
      try { instrumentHttp(endpoint, debug); } catch (e) { }
      try { instrumentFetch(endpoint, debug); } catch (e) { }
      try { instrumentMongo(debug); } catch (e) { }
      try { instrumentPg(); } catch (e) { }

      this.isInstrumented = true;
      if (debug) console.log('[Senzor] Auto-instrumentation enabled');
    }
  }

  public startTrace<T>(data: Partial<ActiveTrace['data']> & { headers?: any }, next: () => T): T {
    if (!this.transport) return next();

    // Check for Distributed Tracing Headers
    let parentTraceId = undefined;
    let parentSpanId = undefined;

    if (data.headers) {
      // Handle various casing
      parentTraceId = data.headers['x-senzor-trace-id'] || data.headers['X-SENZOR-TRACE-ID'];
      parentSpanId = data.headers['x-senzor-parent-span-id'] || data.headers['X-SENZOR-PARENT-SPAN-ID'];
    }

    const trace: ActiveTrace = {
      id: randomUUID(),
      startTime: performance.now(),
      data: {
        ...data,
        parentTraceId, // Link to parent
        parentSpanId   // Link to specific call
      },
      spans: []
    };

    return Context.run(trace, next);
  }

  public endTrace(status: number, extraData: any = {}) {
    const trace = Context.current();
    if (!trace || !this.transport) return;
    const duration = performance.now() - trace.startTime;

    // Explicitly destructure to ensure parent IDs are included
    const payload = {
      traceId: trace.id,
      parentTraceId: trace.data.parentTraceId,
      parentSpanId: trace.data.parentSpanId,
      ...trace.data,
      ...extraData,
      status, duration, spans: trace.spans, timestamp: new Date().toISOString(),
      error: trace.error,

    };
    this.transport.add(payload);
  }

  // --- NEW: Capture Exception ---
  public captureError(error: unknown) {
    if (error instanceof Error) {
      Context.setError(error);
    } else if (typeof error === 'string') {
      Context.setError(new Error(error));
    }
  }

  // ... (manual track, startSpan, flush remain same) ...
  public track(data: any) { this.transport?.add({ traceId: randomUUID(), ...data, spans: [], timestamp: new Date().toISOString() }); }

  public startSpan(name: string, type: 'db' | 'http' | 'function' | 'custom' = 'custom') {
    const trace = Context.current();
    if (!trace) return { end: () => { } };
    const startTime = performance.now() - trace.startTime;
    const spanStartAbs = performance.now();
    const spanId = randomUUID(); // Manual spans also need IDs

    return {
      end: (meta?: any, status?: number) => {
        const duration = performance.now() - spanStartAbs;
        Context.addSpan({ spanId, name, type, startTime, duration, status, meta });
      }
    };
  }

  public async flush() { if (this.transport) await this.transport.flush(); }
}

export const client = new SenzorClient();