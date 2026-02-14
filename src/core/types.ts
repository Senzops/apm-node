export interface SenzorOptions {
  apiKey: string;
  endpoint?: string;
  batchSize?: number;
  flushInterval?: number;
  debug?: boolean;
}

export interface Span {
  name: string;
  type: 'db' | 'http' | 'function' | 'custom';
  startTime: number;
  duration: number;
  status?: number;
  meta?: Record<string, any>;
}

export interface TraceError {
  name: string;
  message: string;
  stack?: string;
}

export interface Trace {
  traceId: string;
  method: string;
  route: string;
  path: string;
  status: number;
  duration: number;
  ip?: string;
  userAgent?: string;
  timestamp: string;
  spans: Span[];
  error?: TraceError;
}

export interface ActiveTrace {
  id: string;
  startTime: number;
  data: Partial<Trace>;
  spans: Span[];
  error?: TraceError;
}