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

export interface SenzorError {
  errorClass: string;
  message: string;
  stackTrace?: string;
  traceId?: string; // Maps to APM traceId
  runId?: string;   // Maps to Task runId
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

// Unified Context Payload for async_hooks
export interface ActiveTrace {
  id: string; // The APM traceId OR the Task runId
  contextType: 'apm' | 'task';
  startTime: number;
  startMemory?: number; // Baseline heap
  startCpu?: NodeJS.CpuUsage; // Baseline CPU tick
  data: any; // Holds Partial<Trace> or Partial<TaskRun>
  spans: Span[];
}