import { Context, aiStorage } from './context';
import { generateTraceId, generateSpanId } from '../utils/ids';
import { sanitizeAttributes } from './sanitizer';
import {
  AiGenerationPayload,
  AiObservationType,
  AiScorePayload,
  AiStatus,
  AiTraceContext,
  SenzorOptions,
} from './types';
import type { Transport } from './transport';

// ---------------------------------------------------------------------------
// AI Manager — manual instrumentation surface + internal emit path
// ----------------------------------------------------------------------------
// Powers `Senzor.ai.trace()`, `Senzor.ai.generation()` and
// `Senzor.ai.wrapGeneration()`, and is also the sink the provider
// auto-instrumentations write through. AI traces live in their own async
// storage (`aiStorage`) so generations group into the enclosing workflow, and
// they auto-link to the current APM trace (`apmTraceId`) when one is active.
//
// Generations are emitted immediately; the backend derives per-trace rollups
// (cost/tokens/latency) from them via atomic upserts, so a standalone
// generation with no enclosing `ai.trace()` still produces a valid AI trace.
// ---------------------------------------------------------------------------

export interface AiTraceOptions {
  name?: string;
  sessionId?: string;
  userId?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}

/** Input to record one AI observation (LLM/tool/retrieval/embedding call). */
export interface RecordGenerationInput {
  type?: AiObservationType;
  name?: string;
  provider?: string;
  operation?: string;
  /** Convenience: sets both request & response model when the specific ones are absent. */
  model?: string;
  requestModel?: string;
  responseModel?: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  timeToFirstTokenMs?: number;
  streaming?: boolean;
  params?: Record<string, any>;
  finishReason?: string;
  status?: AiStatus;
  statusCode?: number;
  errorType?: string;
  errorMessage?: string;
  input?: any;
  output?: any;
  toolCalls?: any[];
  metadata?: Record<string, any>;
  parentGenerationId?: string;
  /** Override the trace this generation belongs to (defaults to the active AI trace). */
  traceId?: string;
  // --- Structural span enrichment (agent-observability) --------------------
  /** Pre-assigned observation id (used by span scopes so children can parent to it). */
  generationId?: string;
  /** Tree depth (0 at the trace root). Defaults from the active span context. */
  depth?: number;
  agent?: { name: string; role?: string; step?: number };
  tool?: { name: string; args?: any; result?: any };
  mcp?: { server: string; transport?: string; method?: string; toolName?: string; resourceUri?: string };
  handoff?: { from?: string; to: string; reason?: string };
  /** Reasoning/thinking tokens (extended thinking, o-series reasoning). */
  reasoningTokens?: number;
}

/** Open an `agent` span — a node in a (multi-)agent workflow. */
export interface AgentOptions {
  name: string;
  role?: string;
  step?: number;
  metadata?: Record<string, any>;
}

/** Open a `tool` span around a tool/function execution. */
export interface ToolOptions {
  name: string;
  /** Tool input arguments (captured only when content capture is on; masked server-side). */
  args?: any;
  /** Capture the function's return value as the tool result. Default true. */
  captureResult?: boolean;
  metadata?: Record<string, any>;
}

/** Open an `mcp` span around a Model Context Protocol server call. */
export interface McpOptions {
  /** The MCP server name/identifier. */
  server: string;
  /** Transport used to reach the server (e.g. 'stdio', 'http', 'sse'). */
  transport?: string;
  /** MCP method (e.g. 'tools/call', 'resources/read'). */
  method?: string;
  /** Tool name when method is a tool call. */
  toolName?: string;
  /** Resource URI when method is a resource read. */
  resourceUri?: string;
  /** Capture the call's return value as the result. Default true. */
  captureResult?: boolean;
  metadata?: Record<string, any>;
}

/** Record a control transfer from one agent to another (point-in-time). */
export interface HandoffInput {
  from?: string;
  to: string;
  reason?: string;
  metadata?: Record<string, any>;
}

export interface ScoreInput {
  name: string;
  value?: number;
  stringValue?: string;
  dataType?: 'numeric' | 'boolean' | 'categorical';
  comment?: string;
  /** Defaults to the active AI trace. */
  traceId?: string;
  generationId?: string;
  authorId?: string;
}

export interface WrapGenerationMeta<T> {
  name?: string;
  provider?: string;
  operation?: string;
  model?: string;
  requestModel?: string;
  input?: any;
  params?: Record<string, any>;
  metadata?: Record<string, any>;
  /** Pull usage/output fields off the call result (tokens, responseModel, etc.). */
  extract?: (result: T) => Partial<RecordGenerationInput>;
}

const nowMs = (): number =>
  (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();

const isThenable = (v: any): v is Promise<any> =>
  v != null && typeof v.then === 'function';

export class AiManager {
  constructor(
    private getTransport: () => Transport | null,
    private getOptions: () => SenzorOptions | null
  ) {}

  private get enabled(): boolean {
    return this.getOptions()?.ai?.enabled !== false;
  }

  private get captureContent(): boolean {
    return this.getOptions()?.ai?.captureContent === true;
  }

  private sampled(): boolean {
    const rate = this.getOptions()?.ai?.sampleRate;
    if (rate === undefined || rate >= 1) return true;
    if (rate <= 0) return false;
    return Math.random() < rate;
  }

  /**
   * Open an AI-trace context for a multi-step workflow (agent run, RAG chain).
   * Generations recorded inside `fn` are grouped under this trace.
   */
  public trace<T>(arg: string | AiTraceOptions, fn: () => T): T {
    const transport = this.getTransport();
    if (!transport || !this.enabled) return fn();

    const opts: AiTraceOptions = typeof arg === 'string' ? { name: arg } : (arg || {});
    const apm = Context.current();

    const ctx: AiTraceContext = {
      traceId: generateTraceId(),
      apmTraceId: apm?.contextType === 'apm' ? apm.id : undefined,
      sessionId: opts.sessionId,
      userId: opts.userId,
      name: opts.name || 'ai.trace',
      tags: opts.tags,
      startWall: Date.now(),
      startPerf: nowMs(),
      metadata: opts.metadata,
      hasError: false,
      depth: 0,
    };
    ctx.root = ctx; // the trace root is its own error sink

    return aiStorage.run(ctx, () => {
      let result: T;
      try {
        result = fn();
      } catch (err) {
        ctx.hasError = true;
        this.emitTrace(ctx, 'error');
        throw err;
      }

      if (isThenable(result)) {
        return result.then(
          (value: any) => { this.emitTrace(ctx, ctx.hasError ? 'error' : 'ok'); return value; },
          (err: any) => { ctx.hasError = true; this.emitTrace(ctx, 'error'); throw err; }
        ) as unknown as T;
      }

      this.emitTrace(ctx, ctx.hasError ? 'error' : 'ok');
      return result;
    });
  }

  /** Record a single, already-completed AI observation. */
  public generation(input: RecordGenerationInput): void {
    const transport = this.getTransport();
    if (!transport || !this.enabled || !this.sampled()) return;

    const ctx = aiStorage.getStore();
    const latency = input.latencyMs ?? 0;

    let traceId = input.traceId || ctx?.traceId;
    let startTime = 0;
    if (ctx) {
      const root = ctx.root ?? ctx;
      startTime = Math.max(0, (nowMs() - latency) - root.startPerf);
      if (input.status === 'error') root.hasError = true;
    }
    if (!traceId) traceId = generateTraceId();

    // A bare generation auto-parents under the enclosing span (agent/tool/...)
    // and inherits its depth, unless the caller overrides either explicitly.
    const enriched: RecordGenerationInput = {
      ...input,
      parentGenerationId: input.parentGenerationId ?? ctx?.currentSpanId,
      depth: input.depth ?? ctx?.depth ?? 0,
    };

    transport.addAiGeneration(this.buildGeneration(enriched, traceId, startTime));
  }

  /**
   * Record a model generation together with the tool calls it produced, as one
   * grouped trace: the generation plus a child `tool` observation per call,
   * parented to it. Used by framework auto-instrumentation (e.g. the Vercel AI
   * SDK multi-step agent loop) where the generation and its tool results arrive
   * together. All children share the generation's traceId so the trace tree is
   * coherent. Tool args/results are content-gated + masked like any content.
   */
  public recordGenerationWithChildren(
    input: RecordGenerationInput,
    children?: Array<{ name: string; args?: any; result?: any; status?: AiStatus; errorMessage?: string; latencyMs?: number }>
  ): void {
    const transport = this.getTransport();
    if (!transport || !this.enabled || !this.sampled()) return;

    const ctx = aiStorage.getStore();
    const root = ctx?.root ?? ctx;
    const latency = input.latencyMs ?? 0;
    const traceId = input.traceId || ctx?.traceId || generateTraceId();
    const genId = input.generationId || generateSpanId();
    const parentGenerationId = input.parentGenerationId ?? ctx?.currentSpanId;
    const depth = input.depth ?? ctx?.depth ?? 0;

    let startTime = 0;
    if (root) {
      startTime = Math.max(0, (nowMs() - latency) - root.startPerf);
      if (input.status === 'error') root.hasError = true;
    }

    transport.addAiGeneration(this.buildGeneration(
      { ...input, generationId: genId, parentGenerationId, depth },
      traceId,
      startTime
    ));

    if (children?.length) {
      // Tools run during the generation; place them right after its start.
      const toolStart = startTime + latency;
      for (const c of children) {
        transport.addAiGeneration(this.buildGeneration({
          type: 'tool',
          name: c.name || 'tool',
          tool: { name: c.name || 'tool', args: c.args, result: c.result },
          status: c.status || 'ok',
          errorMessage: c.errorMessage,
          errorType: c.errorMessage ? 'ToolError' : undefined,
          latencyMs: c.latencyMs ?? 0,
          parentGenerationId: genId,
          depth: depth + 1,
        }, traceId, toolStart));
      }
    }
  }

  /**
   * Wrap an async (or sync) function that performs an LLM call: times it,
   * records a generation (success or error), and returns the original result.
   */
  public wrapGeneration<T>(meta: WrapGenerationMeta<T>, fn: () => Promise<T> | T): Promise<T> | T {
    const transport = this.getTransport();
    if (!transport || !this.enabled) return fn();

    const start = nowMs();

    const record = (result?: T, error?: any) => {
      let extracted: Partial<RecordGenerationInput> = {};
      if (!error && meta.extract && result !== undefined) {
        try { extracted = meta.extract(result) || {}; } catch { /* never break the call */ }
      }
      this.generation({
        name: meta.name,
        provider: meta.provider,
        operation: meta.operation,
        model: meta.model,
        requestModel: meta.requestModel,
        input: meta.input,
        params: meta.params,
        metadata: meta.metadata,
        latencyMs: nowMs() - start,
        status: error ? 'error' : 'ok',
        errorType: error ? (error.name || error.type || 'Error') : undefined,
        errorMessage: error ? error.message : undefined,
        statusCode: error ? (error.status || error.statusCode) : undefined,
        ...extracted,
      });
    };

    let result: Promise<T> | T;
    try {
      result = fn();
    } catch (err) {
      record(undefined, err);
      throw err;
    }

    if (isThenable(result)) {
      return result.then(
        (value: any) => { record(value); return value; },
        (err: any) => { record(undefined, err); throw err; }
      );
    }

    record(result as T);
    return result;
  }

  /**
   * Attach a quality / eval / feedback score to a trace (or generation).
   * Defaults to the active AI trace when `traceId` is omitted.
   */
  public score(input: ScoreInput): void {
    const transport = this.getTransport();
    if (!transport || !this.enabled || !input?.name) return;

    const ctx = aiStorage.getStore();
    const traceId = input.traceId || ctx?.traceId;
    if (!traceId) return; // a score must belong to a trace

    const payload: AiScorePayload = {
      traceId,
      generationId: input.generationId,
      name: input.name,
      dataType: input.dataType,
      value: input.value,
      stringValue: input.stringValue,
      comment: input.comment,
      authorId: input.authorId,
      timestamp: new Date().toISOString(),
    };
    transport.addAiScore(payload);
  }

  /**
   * Open an `agent` span. Generations, tools, MCP calls and sub-agents invoked
   * inside `fn` nest under it, so the trace tree reflects the agent's work.
   */
  public agent<T>(arg: string | AgentOptions, fn: () => T): T {
    const opts: AgentOptions = typeof arg === 'string' ? { name: arg } : (arg || { name: 'agent' });
    return this.span('agent', {
      name: opts.name || 'agent',
      agent: { name: opts.name || 'agent', role: opts.role, step: opts.step },
      metadata: opts.metadata,
    }, fn);
  }

  /**
   * Open a `tool` span around a tool/function call. The tool name is always
   * recorded (so failures stay attributable); args + the returned result are
   * captured only when content capture is enabled, and masked server-side.
   */
  public tool<T>(arg: string | ToolOptions, fn: () => T): T {
    const opts: ToolOptions = typeof arg === 'string' ? { name: arg } : (arg || { name: 'tool' });
    return this.span('tool', {
      name: opts.name || 'tool',
      tool: { name: opts.name || 'tool', args: opts.args },
      captureResult: opts.captureResult !== false,
      metadata: opts.metadata,
    }, fn);
  }

  /**
   * Open an `mcp` span around a Model Context Protocol server call — answers
   * "which MCP server / tool returned bad data?". Server/method/tool identity
   * is always recorded; the result is captured only under content capture.
   */
  public mcp<T>(opts: McpOptions, fn: () => T): T {
    const o = opts || ({} as McpOptions);
    const name = o.toolName ? `${o.server}/${o.toolName}` : (o.method ? `${o.server} ${o.method}` : o.server);
    return this.span('mcp', {
      name: name || 'mcp',
      mcp: {
        server: o.server,
        transport: o.transport,
        method: o.method,
        toolName: o.toolName,
        resourceUri: o.resourceUri,
      },
      captureResult: o.captureResult !== false,
      // MCP tool results carry an `isError` flag even on a resolved promise.
      resultIsError: (r: any) => r?.isError === true,
      metadata: o.metadata,
    }, fn);
  }

  /**
   * Record a control transfer between agents (multi-agent handoff). This is a
   * point-in-time marker inside the active trace, not a wrapping scope.
   */
  public handoff(input: HandoffInput): void {
    const transport = this.getTransport();
    if (!transport || !this.enabled || !input?.to) return;

    const ctx = aiStorage.getStore();
    if (!ctx) return; // a handoff only makes sense inside a workflow
    const root = ctx.root ?? ctx;
    const startTime = Math.max(0, nowMs() - root.startPerf);

    transport.addAiGeneration(this.buildGeneration({
      type: 'handoff',
      name: `${input.from ?? '?'} → ${input.to}`,
      handoff: { from: input.from, to: input.to, reason: input.reason },
      metadata: input.metadata,
      latencyMs: 0,
      parentGenerationId: ctx.currentSpanId,
      depth: ctx.depth ?? 0,
    }, root.traceId, startTime));
  }

  // -- internal --------------------------------------------------------------

  /**
   * Run `fn` inside a nested span scope of the given structural `type`. Opens a
   * child AI context (fresh `currentSpanId`/`depth`, shared `root`) so anything
   * recorded inside auto-parents to this span, then emits the span observation
   * with its own latency/status. Works for sync + async `fn`, and stays correct
   * under concurrent execution because nesting rides on `aiStorage.run`.
   */
  private span<T>(
    type: AiObservationType,
    spec: {
      name: string;
      agent?: RecordGenerationInput['agent'];
      tool?: { name: string; args?: any };
      mcp?: RecordGenerationInput['mcp'];
      captureResult?: boolean;
      /** Treat a resolved result as a failure (e.g. an MCP CallToolResult with isError). */
      resultIsError?: (result: T) => boolean;
      metadata?: Record<string, any>;
    },
    fn: () => T
  ): T {
    const transport = this.getTransport();
    if (!transport || !this.enabled) return fn();

    const existing = aiStorage.getStore();
    // No active AI trace — open one implicitly so the span has a parent trace.
    if (!existing) {
      return this.trace({ name: spec.name }, () => this.span(type, spec, fn));
    }

    const root = existing.root ?? existing;
    const spanId = generateSpanId();
    const startPerf = nowMs();
    const startTime = Math.max(0, startPerf - root.startPerf);
    const parentGenerationId = existing.currentSpanId;
    const depth = existing.depth ?? 0;

    const child: AiTraceContext = {
      ...existing,
      currentSpanId: spanId,
      depth: depth + 1,
      root,
    };

    const emit = (status: AiStatus, result?: T, error?: any) => {
      if (status === 'error') root.hasError = true;
      transport.addAiGeneration(this.buildGeneration({
        generationId: spanId,
        parentGenerationId,
        depth,
        type,
        name: spec.name,
        agent: spec.agent,
        tool: spec.tool
          ? { name: spec.tool.name, args: spec.tool.args, result: (spec.captureResult && status === 'ok') ? result : undefined }
          : undefined,
        mcp: spec.mcp,
        metadata: spec.metadata,
        latencyMs: nowMs() - startPerf,
        status,
        errorType: error ? (error.name || error.type || 'Error') : undefined,
        errorMessage: error ? error.message : undefined,
        statusCode: error ? (error.status || error.statusCode) : undefined,
      }, root.traceId, startTime));
    };

    // A resolved value can still represent a failure (e.g. an MCP tool result
    // with `isError: true`) — treat it as an error span without throwing.
    const statusOf = (value: T): AiStatus => {
      try { return spec.resultIsError && spec.resultIsError(value) ? 'error' : 'ok'; }
      catch { return 'ok'; }
    };

    return aiStorage.run(child, () => {
      let result: T;
      try {
        result = fn();
      } catch (err) {
        emit('error', undefined, err);
        throw err;
      }

      if (isThenable(result)) {
        return result.then(
          (value: any) => { emit(statusOf(value), value); return value; },
          (err: any) => { emit('error', undefined, err); throw err; }
        ) as unknown as T;
      }

      emit(statusOf(result), result);
      return result;
    });
  }

  private emitTrace(ctx: AiTraceContext, status: AiStatus): void {
    const transport = this.getTransport();
    if (!transport) return;
    const options = this.getOptions() || undefined;

    transport.addAiTrace({
      traceId: ctx.traceId,
      apmTraceId: ctx.apmTraceId,
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      name: ctx.name,
      tags: ctx.tags,
      status,
      latencyMs: nowMs() - ctx.startPerf,
      metadata: ctx.metadata ? sanitizeAttributes(ctx.metadata, options) as Record<string, any> : undefined,
      timestamp: new Date(ctx.startWall).toISOString(),
    });
  }

  private buildGeneration(input: RecordGenerationInput, traceId: string, startTime: number): AiGenerationPayload {
    const options = this.getOptions() || undefined;
    const include = this.captureContent;
    const tokensIn = input.tokensIn ?? 0;
    const tokensOut = input.tokensOut ?? 0;

    return {
      traceId,
      generationId: input.generationId || generateSpanId(),
      parentGenerationId: input.parentGenerationId,
      type: input.type || 'generation',
      name: input.name || 'ai.generation',
      provider: input.provider,
      operation: input.operation || 'chat',
      requestModel: input.requestModel || input.model,
      responseModel: input.responseModel || input.model,
      tokensIn,
      tokensOut,
      reasoningTokens: input.reasoningTokens,
      startTime,
      latencyMs: input.latencyMs ?? 0,
      timeToFirstTokenMs: input.timeToFirstTokenMs,
      streaming: input.streaming ?? false,
      depth: input.depth,
      // params may carry config; sanitize to strip any accidental secrets.
      params: input.params ? sanitizeAttributes(input.params, options) as Record<string, any> : undefined,
      finishReason: input.finishReason,
      status: input.status || 'ok',
      statusCode: input.statusCode,
      errorType: input.errorType,
      errorMessage: input.errorMessage,
      // Content is gated client-side (captureContent) AND masked server-side.
      input: include ? input.input : undefined,
      output: include ? input.output : undefined,
      toolCalls: include ? input.toolCalls : undefined,
      // Structural enrichment. Identity (agent/mcp/handoff + tool.name) is always
      // sent so failures stay attributable; tool args/result are content-gated.
      agent: input.agent,
      tool: input.tool
        ? { name: input.tool.name, args: include ? input.tool.args : undefined, result: include ? input.tool.result : undefined }
        : undefined,
      mcp: input.mcp,
      handoff: input.handoff,
      metadata: input.metadata ? sanitizeAttributes(input.metadata, options) as Record<string, any> : undefined,
      timestamp: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Global accessor — lets provider auto-instrumentations emit AI generations
// without importing the client (avoids a circular dependency). The client
// registers its manager on init.
// ---------------------------------------------------------------------------
const SENZOR_AI_MANAGER = Symbol.for('senzor.ai.manager');

export const registerAiManager = (manager: AiManager): void => {
  (globalThis as any)[SENZOR_AI_MANAGER] = manager;
};

export const getAiManager = (): AiManager | undefined =>
  (globalThis as any)[SENZOR_AI_MANAGER];
