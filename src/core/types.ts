export interface SenzorOptions {
  apiKey: string;
  endpoint?: string;
  batchSize?: number;
  flushInterval?: number;
  debug?: boolean;
}

export interface Span {
  spanId: string;
  name: string;
  type: 'db' | 'http' | 'function' | 'custom';
  startTime: number;
  duration: number;
  status?: number;
  meta?: Record<string, any>;
}

// NEW: Standalone Error Event
export interface SenzorError {
  errorClass: string;
  message: string;
  stackTrace?: string;
  traceId?: string;
  context?: any;
  timestamp: string;
}

export interface Trace {
  traceId: string;
  parentTraceId?: string;
  parentSpanId?: string;
  method: string;
  route: string;
  path: string;
  status: number;
  duration: number;
  ip?: string;
  userAgent?: string;
  timestamp: string;
  spans: Span[];
}

export interface ActiveTrace {
  id: string;
  startTime: number;
  data: Partial<Trace>;
  spans: Span[];
}