import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';
import { recordProviderGeneration } from './ai/emit';
import { isAsyncIterable, wrapAiStream } from './ai/stream';

/** Pull billed token counts off a Cohere v1/v2 response. */
const cohereTokens = (result: any): { tokensIn?: number; tokensOut?: number } => {
  const billed = result?.meta?.billedUnits;
  const v1 = result?.meta?.tokens;
  return {
    tokensIn: billed?.inputTokens ?? v1?.inputTokens,
    tokensOut: billed?.outputTokens ?? v1?.outputTokens,
  };
};

// ---------------------------------------------------------------------------
// Cohere SDK Instrumentation
//
// Instruments the `cohere-ai` npm package for Cohere's NLP models
// (Command, Embed, Rerank, Classify, Summarize, etc.).
//
// Patches CohereClient.prototype (or CohereClientV2.prototype) methods:
//   - chat()          — conversational generation (Command R/R+)
//   - chatStream()    — streaming chat
//   - generate()      — text generation (legacy)
//   - embed()         — embedding generation
//   - rerank()        — semantic reranking
//   - classify()      — text classification
//   - summarize()     — text summarization
//   - tokenize()      — tokenization
//   - detokenize()    — detokenization
//
// Captured attributes (OTel GenAI semantic conventions):
//   - gen_ai.system: 'cohere'
//   - gen_ai.request.model: command-r-plus, embed-english-v3.0, etc.
//   - gen_ai.operation.name: chat, generate, embed, rerank, etc.
//   - gen_ai.usage.input_tokens: billed input tokens
//   - gen_ai.usage.output_tokens: billed output tokens
//   - gen_ai.response.finish_reason: COMPLETE, MAX_TOKENS, etc.
// ---------------------------------------------------------------------------

/** Methods to instrument with metadata extractors. */
const METHODS: {
  name: string;
  operation: string;
  getModel: (args: any[]) => string | undefined;
  extractUsage: (result: any) => Record<string, any>;
}[] = [
  {
    name: 'chat',
    operation: 'chat',
    getModel: (args) => args[0]?.model,
    extractUsage: (result) => {
      const meta: Record<string, any> = {};
      // Cohere v2 chat response
      if (result?.meta?.billedUnits) {
        meta['gen_ai.usage.input_tokens'] = result.meta.billedUnits.inputTokens;
        meta['gen_ai.usage.output_tokens'] = result.meta.billedUnits.outputTokens;
      }
      // Cohere v1 chat response
      if (result?.meta?.tokens) {
        meta['gen_ai.usage.input_tokens'] = meta['gen_ai.usage.input_tokens'] || result.meta.tokens.inputTokens;
        meta['gen_ai.usage.output_tokens'] = meta['gen_ai.usage.output_tokens'] || result.meta.tokens.outputTokens;
      }
      if (result?.finishReason || result?.finish_reason) {
        meta['gen_ai.response.finish_reason'] = result.finishReason || result.finish_reason;
      }
      return meta;
    },
  },
  {
    name: 'chatStream',
    operation: 'chat.stream',
    getModel: (args) => args[0]?.model,
    extractUsage: () => ({}), // Stream — usage comes in final event
  },
  {
    name: 'generate',
    operation: 'generate',
    getModel: (args) => args[0]?.model,
    extractUsage: (result) => {
      const meta: Record<string, any> = {};
      if (result?.meta?.billedUnits) {
        meta['gen_ai.usage.input_tokens'] = result.meta.billedUnits.inputTokens;
        meta['gen_ai.usage.output_tokens'] = result.meta.billedUnits.outputTokens;
      }
      return meta;
    },
  },
  {
    name: 'embed',
    operation: 'embed',
    getModel: (args) => args[0]?.model,
    extractUsage: (result) => {
      const meta: Record<string, any> = {};
      if (result?.meta?.billedUnits) {
        meta['gen_ai.usage.input_tokens'] = result.meta.billedUnits.inputTokens;
      }
      return meta;
    },
  },
  {
    name: 'rerank',
    operation: 'rerank',
    getModel: (args) => args[0]?.model,
    extractUsage: (result) => {
      const meta: Record<string, any> = {};
      if (result?.meta?.billedUnits) {
        meta['gen_ai.usage.input_tokens'] = result.meta.billedUnits.searchUnits;
      }
      meta['cohere.results_count'] = result?.results?.length;
      return meta;
    },
  },
  {
    name: 'classify',
    operation: 'classify',
    getModel: (args) => args[0]?.model,
    extractUsage: () => ({}),
  },
  {
    name: 'summarize',
    operation: 'summarize',
    getModel: (args) => args[0]?.model,
    extractUsage: (result) => {
      const meta: Record<string, any> = {};
      if (result?.meta?.billedUnits) {
        meta['gen_ai.usage.input_tokens'] = result.meta.billedUnits.inputTokens;
        meta['gen_ai.usage.output_tokens'] = result.meta.billedUnits.outputTokens;
      }
      return meta;
    },
  },
  {
    name: 'tokenize',
    operation: 'tokenize',
    getModel: (args) => args[0]?.model,
    extractUsage: (result) => ({
      'cohere.token_count': result?.tokens?.length,
    }),
  },
  {
    name: 'detokenize',
    operation: 'detokenize',
    getModel: (args) => args[0]?.model,
    extractUsage: () => ({}),
  },
];

// ---------------------------------------------------------------------------
// CohereClient patching
// ---------------------------------------------------------------------------

const patchCohereClient = (proto: any, clientName: string, options?: SenzorOptions) => {
  if (!proto) return;

  for (const methodConfig of METHODS) {
    if (typeof proto[methodConfig.name] !== 'function') continue;

    patchMethod(
      proto,
      methodConfig.name,
      `senzor.cohere.${clientName}.${methodConfig.name}`,
      (original) =>
        function patchedCohereMethod(this: any, ...args: any[]) {
          const model = methodConfig.getModel(args);

          const spanName = model
            ? `Cohere ${methodConfig.operation} ${model}`
            : `Cohere ${methodConfig.operation}`;

          const span = startCapturedSpan(
            spanName,
            'http',
            {
              'gen_ai.system': 'cohere',
              'gen_ai.operation.name': methodConfig.operation,
              'gen_ai.request.model': model,
              library: 'cohere',
            },
            options
          );

          if (!span) return original.apply(this, args);

          const startedAt = Date.now();
          const emitType =
            methodConfig.operation === 'embed' ? 'embedding' : 'generation';

          return runWithCapturedSpan(span, () => {
            try {
              const result = original.apply(this, args);

              if (result && typeof result.then === 'function') {
                return result.then(
                  (value: any) => {
                    span.end(0, methodConfig.extractUsage(value));
                    if (model) {
                      const { tokensIn, tokensOut } = cohereTokens(value);
                      recordProviderGeneration({
                        provider: 'cohere',
                        operation: methodConfig.operation,
                        type: emitType,
                        requestModel: model,
                        tokensIn,
                        tokensOut,
                        latencyMs: Date.now() - startedAt,
                        finishReason: value?.finishReason || value?.finish_reason,
                        status: 'ok',
                      });
                    }
                    return value;
                  },
                  (error: any) => {
                    span.end(error?.statusCode || error?.status || 500, {
                      'error.message': error?.message,
                      'error.type': error?.name || 'CohereError',
                    });
                    if (model) {
                      recordProviderGeneration({
                        provider: 'cohere',
                        operation: methodConfig.operation,
                        type: emitType,
                        requestModel: model,
                        latencyMs: Date.now() - startedAt,
                        status: 'error',
                        statusCode: error?.statusCode || error?.status || 500,
                        errorType: error?.name || 'CohereError',
                        errorMessage: error?.message,
                      });
                    }
                    throw error;
                  }
                );
              }

              // Streaming (chatStream): observe events for usage without
              // consuming the caller's stream. Final 'message-end'/'stream-end'
              // event carries billed token counts.
              if (model && isAsyncIterable(result)) {
                span.end(0);
                let ttft: number | undefined;
                let tokensIn: number | undefined;
                let tokensOut: number | undefined;
                let finishReason: string | undefined;
                const aggregated: string[] = [];

                return wrapAiStream(result, {
                  onChunk: (ev: any) => {
                    if (ttft === undefined) ttft = Date.now() - startedAt;
                    const text = ev?.delta?.message?.content?.text ?? ev?.text;
                    if (typeof text === 'string') aggregated.push(text);
                    if (ev?.type === 'message-end' || ev?.eventType === 'stream-end') {
                      const u = ev?.delta?.usage?.billedUnits
                        ?? ev?.delta?.usage?.tokens
                        ?? ev?.response?.meta?.billedUnits;
                      if (u) {
                        tokensIn = u.inputTokens ?? tokensIn;
                        tokensOut = u.outputTokens ?? tokensOut;
                      }
                      finishReason = ev?.delta?.finishReason ?? ev?.finishReason ?? ev?.response?.finishReason ?? finishReason;
                    }
                  },
                  onDone: () => {
                    recordProviderGeneration({
                      provider: 'cohere',
                      operation: methodConfig.operation,
                      type: emitType,
                      requestModel: model,
                      tokensIn,
                      tokensOut,
                      latencyMs: Date.now() - startedAt,
                      timeToFirstTokenMs: ttft,
                      finishReason,
                      streaming: true,
                      output: aggregated.length ? aggregated.join('') : undefined,
                      status: 'ok',
                    });
                  },
                });
              }

              span.end(0);
              return result;
            } catch (error: any) {
              span.end(500, { 'error.message': error?.message });
              throw error;
            }
          });
        }
    );
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentCohere = (options?: SenzorOptions) => {
  hookRequire('cohere-ai', (exports: any) => {
    // CohereClient (v1)
    if (exports?.CohereClient?.prototype) {
      patchCohereClient(exports.CohereClient.prototype, 'client', options);
    }
    // CohereClientV2 (v2)
    if (exports?.CohereClientV2?.prototype) {
      patchCohereClient(exports.CohereClientV2.prototype, 'clientV2', options);
    }
    // Default export
    if (exports?.default?.prototype) {
      patchCohereClient(exports.default.prototype, 'default', options);
    }
  });
};
