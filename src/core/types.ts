export interface SenzorOptions {
  apiKey: string;
  endpoint?: string;
  batchSize?: number;
  flushInterval?: number; // ms
  debug?: boolean;
}

export interface Span {
  name: string;
  type: 'db' | 'http' | 'function' | 'custom';
  startTime: number; // Relative to trace start
  duration: number;
  status?: number;
  meta?: Record<string, any>;
}

export interface Trace {
  traceId: string;
  method: string;
  route: string; // Normalized
  path: string;  // Raw
  status: number;
  duration: number;
  ip?: string;
  userAgent?: string;
  timestamp: string;
  spans: Span[];
}

// Internal interface for an active trace object
export interface ActiveTrace {
  id: string;
  startTime: number;
  data: Partial<Trace>;
  spans: Span[];
}