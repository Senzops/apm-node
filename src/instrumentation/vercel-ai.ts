import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { recordProviderGeneration, recordProviderGenerationWithTools, ProviderToolCall } from './ai/emit';

// ---------------------------------------------------------------------------
// Vercel AI SDK Instrumentation (`ai` package)
//
// The AI SDK is the dominant TS abstraction layer — one hook covers every
// provider it fronts (OpenAI, Anthropic, Google, Mistral, Groq, ...). Its API
// is functional, not class-based: generateText / streamText / generateObject /
// streamObject / embed / embedMany. We wrap those module exports in place.
//
// Provider attribution comes from the passed model object: `model.provider`
// (e.g. "openai.chat") → "openai", and `model.modelId` is the model name.
//
// Streaming is non-intrusive: streamText/streamObject return `usage` and
// `finishReason` as PROMISES that settle when the stream finishes, so we attach
// to those rather than touching the user's `textStream`.
// ---------------------------------------------------------------------------

const vendorOf = (model: any): string => {
  const p = model?.provider;
  if (typeof p === 'string' && p.length) return p.split('.')[0];
  return 'vercel-ai';
};

const commonParams = (params: any) => ({
  temperature: params?.temperature,
  maxTokens: params?.maxTokens,
  topP: params?.topP,
});

const inputOf = (params: any) => params?.messages ?? params?.prompt ?? params?.value ?? params?.values;

/**
 * Flatten the tool calls executed during a (possibly multi-step) generateText /
 * generateObject call into child observations. The AI SDK exposes them on
 * `value.steps[].toolResults` (multi-step agent loop) and/or the top-level
 * `value.toolResults`; each result carries { toolName, args, result }.
 */
const collectTools = (value: any): ProviderToolCall[] => {
  const tools: ProviderToolCall[] = [];
  try {
    const steps = Array.isArray(value?.steps) && value.steps.length ? value.steps : [value];
    for (const step of steps) {
      const results = Array.isArray(step?.toolResults) ? step.toolResults : [];
      for (const r of results) {
        tools.push({ name: r?.toolName || 'tool', args: r?.args, result: r?.result, status: 'ok' });
      }
      // Tool calls that produced no result (e.g. the model requested a tool but
      // execution failed/was skipped) — still surface which tool was invoked.
      const calls = Array.isArray(step?.toolCalls) ? step.toolCalls : [];
      for (const c of calls) {
        const hasResult = results.some((r: any) => r?.toolCallId && r.toolCallId === c?.toolCallId);
        if (!hasResult) tools.push({ name: c?.toolName || 'tool', args: c?.args, status: 'error', errorMessage: 'No tool result' });
      }
    }
  } catch { /* never break the host call */ }
  return tools;
};

/** Wrap a Promise-returning op (generateText, generateObject, embed, embedMany). */
const wrapAwaitable = (original: Function, operation: string, type: 'generation' | 'embedding') =>
  function patchedVercelOp(this: any, params: any) {
    const model = params?.model;
    const modelId = model?.modelId;
    const provider = vendorOf(model);
    const startedAt = Date.now();

    const result = original.apply(this, arguments as any);
    if (!result || typeof result.then !== 'function') return result;

    return result.then(
      (value: any) => {
        const usage = value?.usage;
        const genInput = {
          provider,
          operation,
          type,
          requestModel: modelId,
          responseModel: value?.response?.modelId ?? modelId,
          // text usage: promptTokens/completionTokens; embeddings: tokens.
          tokensIn: usage?.promptTokens ?? usage?.tokens,
          tokensOut: usage?.completionTokens,
          reasoningTokens: usage?.reasoningTokens,
          latencyMs: Date.now() - startedAt,
          finishReason: value?.finishReason,
          params: commonParams(params),
          input: inputOf(params),
          output: value?.text ?? value?.object,
          status: 'ok' as const,
        };
        // For text generation, also surface any tool calls as child observations
        // so the agent loop (model → tools) is visible as one grouped trace.
        const tools = type === 'generation' ? collectTools(value) : [];
        if (tools.length) recordProviderGenerationWithTools(genInput, tools);
        else recordProviderGeneration(genInput);
        return value;
      },
      (error: any) => {
        recordProviderGeneration({
          provider,
          operation,
          type,
          requestModel: modelId,
          latencyMs: Date.now() - startedAt,
          status: 'error',
          errorType: error?.name || 'AISDKError',
          errorMessage: error?.message,
        });
        throw error;
      }
    );
  };

/** Wrap a streaming op (streamText, streamObject). `usage`/`finishReason` are promises. */
const wrapStreaming = (original: Function, operation: string) =>
  function patchedVercelStream(this: any, params: any) {
    const model = params?.model;
    const modelId = model?.modelId;
    const provider = vendorOf(model);
    const startedAt = Date.now();

    const result = original.apply(this, arguments as any);

    try {
      const usageP = result?.usage;
      if (usageP && typeof usageP.then === 'function') {
        const finishP =
          result?.finishReason && typeof result.finishReason.then === 'function'
            ? result.finishReason.catch(() => undefined)
            : Promise.resolve(undefined);

        Promise.all([usageP, finishP]).then(
          ([usage, finishReason]: any[]) => {
            recordProviderGeneration({
              provider,
              operation,
              requestModel: modelId,
              tokensIn: usage?.promptTokens ?? usage?.tokens,
              tokensOut: usage?.completionTokens,
              latencyMs: Date.now() - startedAt,
              finishReason,
              streaming: true,
              params: commonParams(params),
              input: inputOf(params),
              status: 'ok',
            });
          },
          () => { /* stream errored — surfaced to the caller already */ }
        ).catch(() => {});
      }
    } catch {
      /* never break the host call */
    }

    return result;
  };

export const instrumentVercelAi = (options?: SenzorOptions) => {
  hookRequire('ai', (exports: any) => {
    if (!exports) return;
    patchMethod(exports, 'generateText', 'senzor.vercel-ai.generateText', (o) => wrapAwaitable(o, 'generateText', 'generation'));
    patchMethod(exports, 'generateObject', 'senzor.vercel-ai.generateObject', (o) => wrapAwaitable(o, 'generateObject', 'generation'));
    patchMethod(exports, 'embed', 'senzor.vercel-ai.embed', (o) => wrapAwaitable(o, 'embed', 'embedding'));
    patchMethod(exports, 'embedMany', 'senzor.vercel-ai.embedMany', (o) => wrapAwaitable(o, 'embedMany', 'embedding'));
    patchMethod(exports, 'streamText', 'senzor.vercel-ai.streamText', (o) => wrapStreaming(o, 'streamText'));
    patchMethod(exports, 'streamObject', 'senzor.vercel-ai.streamObject', (o) => wrapStreaming(o, 'streamObject'));
  });
};
