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

    // Trace Propagation Extraction
    let parentTraceId = undefined;
    let parentSpanId = undefined;

    if (data.headers) {
      // Robust header checking (handles Node's lowercase headers and other variants)
      const getHeader = (key: string) => {
        if (data.headers[key]) return data.headers[key];
        if (data.headers[key.toLowerCase()]) return data.headers[key.toLowerCase()];
        return undefined;
      };

      parentTraceId = getHeader('x-senzor-trace-id');
      parentSpanId = getHeader('x-senzor-parent-span-id');

      // If found, ensure they are strings (headers can be arrays)
      if (Array.isArray(parentTraceId)) parentTraceId = parentTraceId[0];
      if (Array.isArray(parentSpanId)) parentSpanId = parentSpanId[0];
    }

    const trace: ActiveTrace = {
      id: randomUUID(),
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
    if (!trace || !this.transport) return;
    const duration = performance.now() - trace.startTime;

    const payload = {
      traceId: trace.id,
      parentTraceId: trace.data.parentTraceId,
      parentSpanId: trace.data.parentSpanId,
      ...trace.data,
      ...extraData,
      status, duration, spans: trace.spans, timestamp: new Date().toISOString(),
      error: trace.error
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

  public track(data: any) { this.transport?.add({ traceId: randomUUID(), ...data, spans: [], timestamp: new Date().toISOString() }); }

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