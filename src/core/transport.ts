import { SenzorOptions } from './types';

export class Transport {
  private queue: any[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private config: SenzorOptions) {
    if (typeof setInterval !== 'undefined') {
      this.timer = setInterval(() => this.flush(), config.flushInterval || 10000);
      if (this.timer && typeof this.timer.unref === 'function') {
        this.timer.unref(); // Don't block process exit
      }
    }
  }

  public add(trace: any) {
    this.queue.push(trace);
    if (this.queue.length >= (this.config.batchSize || 100)) {
      this.flush();
    }
  }

  public async flush() {
    if (this.queue.length === 0) return;

    const batch = [...this.queue];
    this.queue = [];

    try {
      // Use global fetch (Node 18+)
      await fetch(this.config.endpoint || 'https://api.senzor.dev/api/ingest/apm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-api-key': this.config.apiKey,
        },
        body: JSON.stringify(batch),
        keepalive: true,
      });
      
      if (this.config.debug) console.log(`[Senzor] Flushed ${batch.length} traces`);
    } catch (err) {
      if (this.config.debug) console.error('[Senzor] Ingestion Error:', err);
      // Dropping data to prevent memory leaks is preferred in APM
    }
  }
}