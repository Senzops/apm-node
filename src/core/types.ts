export interface SenzorOptions {
  apiKey: string;
  endpoint?: string;
  batchSize?: number;
  flushInterval?: number;
  flushTimeoutMs?: number;
  maxQueueSize?: number;
  /**
   * Maximum serialized byte size of a single ingest request body. Flushes are
   * split into multiple requests so none exceeds this size, keeping payloads
   * safely under the ingest endpoint's body-size limit. Defaults to 900_000
   * (~0.9 MB) to stay under common 1 MB limits; raise it if your endpoint
   * allows larger bodies to reduce request count.
   */
  maxBatchBytes?: number;
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
  /** AI monitoring (LLM observability) options. */
  ai?: AiOptions;
}

export interface AiOptions {
  /** Master switch for AI auto-instrumentation + manual API. Default: true. */
  enabled?: boolean;
  /**
   * Dedicated ingest key for the AI Monitoring pillar. AI Monitoring sources
   * have their own key (separate from APM/Task), so set this when your AI source
   * key differs from the SDK's top-level `apiKey`. AI telemetry is sent with
   * this key; falls back to the top-level `apiKey` when omitted.
   */
  apiKey?: string;
  /**
   * Whether the SDK sends captured prompt/completion content. Defense-in-depth:
   * the backend ALSO gates on the source's capture policy. Default: false.
   */
  captureContent?: boolean;
  /** Head-sampling rate (0..1) for AI generations. Default: 1 (keep all). */
  sampleRate?: number;
}

// ---------------------------------------------------------------------------
// AI Monitoring (LLM Observability) payloads + context
// ---------------------------------------------------------------------------

export type AiObservationType = 'generation' | 'tool' | 'retrieval' | 'embedding' | 'span';
export type AiStatus = 'ok' | 'error';

/** A single AI observation (LLM/tool/retrieval/embedding call) sent to ingest. */
export interface AiGenerationPayload {
  traceId: string;
  generationId: string;
  parentGenerationId?: string;
  type?: AiObservationType;
  name?: string;
  provider?: string;
  operation?: string;
  requestModel?: string;
  responseModel?: string;
  tokensIn?: number;
  tokensOut?: number;
  startTime?: number;          // ms offset from trace start
  latencyMs?: number;
  timeToFirstTokenMs?: number;
  streaming?: boolean;
  params?: Record<string, any>;
  finishReason?: string;
  status?: AiStatus;
  statusCode?: number;
  errorType?: string;
  errorMessage?: string;
  input?: any;                 // omitted unless captureContent is on
  output?: any;
  toolCalls?: any[];
  metadata?: Record<string, any>;
  timestamp: string;
}

/** A quality/eval/feedback score attached to a trace or generation. */
export interface AiScorePayload {
  traceId: string;
  generationId?: string;
  name: string;
  dataType?: 'numeric' | 'boolean' | 'categorical';
  value?: number;
  stringValue?: string;
  comment?: string;
  authorId?: string;
  timestamp: string;
}

/** AI trace (workflow grouping) metadata sent to ingest. */
export interface AiTracePayload {
  traceId: string;
  apmTraceId?: string;
  sessionId?: string;
  userId?: string;
  name?: string;
  tags?: string[];
  status?: AiStatus;
  latencyMs?: number;
  metadata?: Record<string, any>;
  timestamp: string;
}

/** Active AI-trace context propagated via async storage. */
export interface AiTraceContext {
  traceId: string;
  apmTraceId?: string;
  sessionId?: string;
  userId?: string;
  name: string;
  tags?: string[];
  startWall: number;   // Date.now() at start (absolute timestamps)
  startPerf: number;   // performance.now() at start (relative offsets)
  metadata?: Record<string, any>;
  hasError: boolean;
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
