export interface SenzorOptions {
  apiKey: string;
  endpoint?: string;
  batchSize?: number;
  flushInterval?: number;
  flushTimeoutMs?: number;
  maxQueueSize?: number;
  maxSpansPerTrace?: number;
  maxAttributeLength?: number;
  maxAttributes?: number;
  captureHeaders?: boolean;
  captureDbStatement?: boolean;
  instrumentations?: boolean | string[];
  frameworkSpans?: boolean;
  captureMiddlewareSpans?: boolean;
  captureRouterSpans?: boolean;
  captureLifecycleHookSpans?: boolean;
  ignoreFrameworkSpanTypes?: string[];
  debug?: boolean;
  autoLogs?: boolean;
  /** Enable runtime metrics collection (event loop, GC, heap). Default: true */
  runtimeMetrics?: boolean;
  /** Runtime metrics collection interval in milliseconds. Default: 15000 */
  runtimeMetricsInterval?: number;
}

export interface Span {
  spanId: string;
  parentSpanId?: string;
  name: string;
  type: 'db' | 'http' | 'function' | 'custom' | 'rpc' | 'messaging' | 'dns' | 'net';
  startTime: number;
  duration: number;
  status?: number;
  meta?: Record<string, any>;
}

export interface SenzorError {
  errorClass: string;
  message: string;
  stackTrace?: string;
  traceId?: string; // Maps to APM traceId
  runId?: string;   // Maps to Task runId
  context?: any;
  timestamp: string;
}

// NEW: Enterprise Log Payload
export interface SenzorLog {
  message: string;
  level: 'info' | 'warn' | 'error' | 'debug' | 'fatal';
  attributes: Record<string, any>;
  traceId?: string; // Used if context is APM
  runId?: string;   // Used if context is Task
  spanId?: string;
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

export interface ResourceMetrics {
  memoryDeltaBytes: number; // Delta of process.memoryUsage().heapUsed
  cpuUserUs: number;        // CPU time spent in user space (microseconds)
  cpuSystemUs: number;      // CPU time spent in OS system calls (microseconds)
}

export interface TaskRun {
  runId: string;
  taskName: string;
  taskType: 'cron' | 'queue' | 'pipeline' | 'custom';
  status: 'success' | 'failed';
  duration: number;
  queueDelay?: number;
  attempts?: number;
  triggerTraceId?: string;
  metadata?: any;
  resourceMetrics?: ResourceMetrics; // Hardware cost profiling
  isDeadLetter?: boolean;            // True if the job failed its final retry
  spans: Span[];
  timestamp: string;
}

// NEW: Shared mutable state for a trace/task to prevent duplication during context shallow copying
export interface ActiveTraceState {
  ended: boolean;
  droppedSpans: number;
}

// Unified Context Payload for async_hooks
export interface ActiveTrace {
  id: string; // The APM traceId OR the Task runId
  contextType: 'apm' | 'task';
  startTime: number;
  rootSpanId?: string;
  activeSpanId?: string;
  startMemory?: number; // Baseline heap
  startCpu?: NodeJS.CpuUsage; // Baseline CPU tick
  data: any; // Holds Partial<Trace> or Partial<TaskRun>
  spans: Span[];
  maxSpans?: number;
  state: ActiveTraceState;
}
