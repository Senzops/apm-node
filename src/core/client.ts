import { Transport } from './transport';

export interface SenzorOptions {
  apiKey: string;
  endpoint?: string;
  batchSize?: number;
  flushInterval?: number;
  debug?: boolean;
}

export class SenzorClient {
  private transport: Transport | null = null;
  private options: SenzorOptions | null = null;

  public init(options: SenzorOptions) {
    if (!options.apiKey) {
      console.warn('[Senzor] API Key missing. SDK disabled.');
      return;
    }

    this.options = {
      endpoint: 'https://api.senzor.dev/api/ingest/apm',
      batchSize: 100,
      flushInterval: 10000,
      debug: false,
      ...options
    };

    this.transport = new Transport({
      apiKey: this.options.apiKey,
      endpoint: this.options.endpoint!,
      batchSize: this.options.batchSize!,
      flushInterval: this.options.flushInterval!,
      debug: this.options.debug || false
    });

    if (this.options.debug) console.log('[Senzor] Initialized');
  }

  // --- Manual Tracking (For any framework) ---
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

    this.transport.add({
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  // --- Force Flush (For Serverless/Lambda) ---
  public async flush() {
    if (this.transport) await this.transport.flush();
  }
}

export const client = new SenzorClient();