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
    };

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
      startTime = Math.max(0, (nowMs() - latency) - ctx.startPerf);
      if (input.status === 'error') ctx.hasError = true;
    }
    if (!traceId) traceId = generateTraceId();

    transport.addAiGeneration(this.buildGeneration(input, traceId, startTime));
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

  // -- internal --------------------------------------------------------------

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
      generationId: generateSpanId(),
      parentGenerationId: input.parentGenerationId,
      type: input.type || 'generation',
      name: input.name || 'ai.generation',
      provider: input.provider,
      operation: input.operation || 'chat',
      requestModel: input.requestModel || input.model,
      responseModel: input.responseModel || input.model,
      tokensIn,
      tokensOut,
      startTime,
      latencyMs: input.latencyMs ?? 0,
      timeToFirstTokenMs: input.timeToFirstTokenMs,
      streaming: input.streaming ?? false,
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
