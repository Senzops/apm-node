import { SenzorOptions, Trace, SenzorError } from './types';

export class Transport {
  private traceQueue: Trace[] = [];
  private errorQueue: SenzorError[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private config: SenzorOptions) {
    if (typeof setInterval !== 'undefined') {
      this.timer = setInterval(() => this.flush(), config.flushInterval || 10000);
      if (this.timer && typeof this.timer.unref === 'function') {
        this.timer.unref(); // Don't block process exit
      }
    }
  }

  public addTrace(trace: any) {
    this.traceQueue.push(trace);
    if (this.traceQueue.length >= (this.config.batchSize || 100)) {
      this.flush();
    }
  }

  public addError(error: SenzorError) {
    this.errorQueue.push(error);
    if (this.errorQueue.length >= (this.config.batchSize || 100)) {
      this.flush();
    }
  }

  public async flush() {
    if (this.traceQueue.length === 0 && this.errorQueue.length === 0) return;

    const payload = {
      traces: [...this.traceQueue],
      errors: [...this.errorQueue]
    };

    this.traceQueue = [];
    this.errorQueue = [];

    try {
      await fetch(this.config.endpoint || 'https://api.senzor.dev/api/ingest/apm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-api-key': this.config.apiKey,
        },
        body: JSON.stringify(payload),
        keepalive: true,
      });

      if (this.config.debug) console.log(`[Senzor] Flushed ${payload.traces.length} traces, ${payload.errors.length} errors`);
    } catch (err) {
      if (this.config.debug) console.error('[Senzor] Ingestion Error:', err);
    }
  }
}