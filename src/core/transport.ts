export interface TransportConfig {
  apiKey: string;
  endpoint: string;
  batchSize: number;
  flushInterval: number;
  debug: boolean;
}

export class Transport {
  private queue: any[] = [];
  private config: TransportConfig;
  private timer: any = null;

  constructor(config: TransportConfig) {
    this.config = config;
    // Only start timer in non-serverless environments (long running processes)
    if (typeof setInterval !== 'undefined') {
      this.timer = setInterval(() => this.flush(), this.config.flushInterval);
      // Unref if in Node.js to allow process exit
      if (this.timer && typeof this.timer.unref === 'function') {
        this.timer.unref();
      }
    }
  }

  public add(event: any) {
    this.queue.push(event);
    if (this.queue.length >= this.config.batchSize) {
      this.flush();
    }
  }

  public async flush() {
    if (this.queue.length === 0) return;

    const batch = [...this.queue];
    this.queue = [];

    try {
      // Use native fetch (Node 18+, Edge, Browser)
      await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-api-key': this.config.apiKey,
        },
        body: JSON.stringify(batch),
        // keepalive ensures connection stays open even if function ends (vital for APM)
        keepalive: true,
      });

      if (this.config.debug) console.log(`[Senzor] Flushed ${batch.length} traces`);
    } catch (err) {
      if (this.config.debug) console.error('[Senzor] Ingestion Error:', err);
      // We drop data on failure to prevent memory leaks in the app
    }
  }
}