import { Transport } from './transport';
import { Context } from './context';
import { SenzorOptions, ActiveTrace } from './types';
import { randomUUID } from 'crypto';
import { instrumentHttp } from '../instrumentation/http';
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

    this.transport = new Transport({
      ...options,
      endpoint
    });

    if (!this.isInstrumented) {
      try { instrumentHttp(endpoint, debug); } catch (e) { }
      try { instrumentMongo(debug); } catch (e) { }
      try { instrumentPg(); } catch (e) { }

      this.isInstrumented = true;
      if (debug) console.log('[Senzor] Auto-instrumentation enabled');
    }
  }

  // ... (startTrace, endTrace, track, startSpan, flush remain same) ...
  // Ensuring startTrace returns T
  public startTrace<T>(data: Partial<ActiveTrace['data']>, next: () => T): T {
    if (!this.transport) return next();

    const trace: ActiveTrace = {
      id: randomUUID(),
      startTime: performance.now(),
      data: data,
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
      ...trace.data,
      ...extraData,
      status,
      duration,
      spans: trace.spans,
      timestamp: new Date().toISOString()
    };

    if (this.options?.debug) console.log(`[Senzor] Ended Trace ${trace.id} with ${trace.spans.length} spans`);

    this.transport.add(payload);
  }

  // ... (manual track methods) ...
  public track(data: {
    method: string;
    route: string;
    path: string;
    status: number;
    duration: number;
    ip?: string;
    userAgent?: string;
  }) {
    if (!this.transport) return;
    const payload = {
      traceId: randomUUID(),
      ...data,
      spans: [],
      timestamp: new Date().toISOString()
    };
    this.transport.add(payload);
  }

  public startSpan(name: string, type: 'db' | 'http' | 'function' | 'custom' = 'custom') {
    const trace = Context.current();
    if (!trace) return { end: () => { } };

    const startTime = performance.now() - trace.startTime;
    const spanStartAbs = performance.now();

    return {
      end: (meta?: any, status?: number) => {
        const duration = performance.now() - spanStartAbs;
        Context.addSpan({
          name,
          type,
          startTime,
          duration,
          status,
          meta
        });
      }
    };
  }

  public async flush() {
    if (this.transport) await this.transport.flush();
  }
}

export const client = new SenzorClient();