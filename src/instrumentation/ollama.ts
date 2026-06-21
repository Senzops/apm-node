import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';
import { recordProviderGeneration } from './ai/emit';
import { isAsyncIterable, wrapAiStream } from './ai/stream';

// ---------------------------------------------------------------------------
// Ollama Instrumentation (`ollama` package — local/self-hosted models)
//
// Native API (not OpenAI-compatible): Ollama.prototype.chat / generate /
// embeddings / embed. Token usage is reported as `prompt_eval_count` (input)
// and `eval_count` (output). Self-hosted models are unpriced by default, so
// cost resolves to 0 unless a per-source pricing override is configured.
//
// Both `import { Ollama }` (class) and `import ollama` (default instance) share
// the same prototype, so prototype patching covers both.
// ---------------------------------------------------------------------------

interface OllamaOp {
  name: string;
  operation: string;
  type: 'generation' | 'embedding';
  hasTokens: boolean;
}

const OPS: OllamaOp[] = [
  { name: 'chat', operation: 'chat', type: 'generation', hasTokens: true },
  { name: 'generate', operation: 'generate', type: 'generation', hasTokens: true },
  { name: 'embeddings', operation: 'embeddings', type: 'embedding', hasTokens: false },
  { name: 'embed', operation: 'embeddings', type: 'embedding', hasTokens: false },
];

const patchOllamaProto = (proto: any, options?: SenzorOptions) => {
  if (!proto) return;

  for (const op of OPS) {
    if (typeof proto[op.name] !== 'function') continue;

    patchMethod(
      proto,
      op.name,
      `senzor.ollama.${op.name}`,
      (original) =>
        function patchedOllamaMethod(this: any, request: any) {
          const model = request?.model;
          const span = startCapturedSpan(
            model ? `Ollama ${op.operation} ${model}` : `Ollama ${op.operation}`,
            'http',
            {
              'gen_ai.system': 'ollama',
              'gen_ai.operation.name': op.operation,
              'gen_ai.request.model': model,
              library: 'ollama',
            },
            options
          );

          if (!span) return original.call(this, request);

          const startedAt = Date.now();
          const params = {
            temperature: request?.options?.temperature,
            top_p: request?.options?.top_p,
            num_predict: request?.options?.num_predict,
          };
          const input = request?.messages ?? request?.prompt;

          const emitOk = (value: any, ttft?: number, streaming = false, output?: any) =>
            recordProviderGeneration({
              provider: 'ollama',
              operation: op.operation,
              type: op.type,
              requestModel: model,
              responseModel: value?.model,
              tokensIn: op.hasTokens ? value?.prompt_eval_count : undefined,
              tokensOut: op.hasTokens ? value?.eval_count : undefined,
              latencyMs: Date.now() - startedAt,
              timeToFirstTokenMs: ttft,
              finishReason: value?.done_reason,
              streaming,
              params,
              input,
              output,
              status: 'ok',
            });

          return runWithCapturedSpan(span, () => {
            try {
              const result = original.call(this, request);

              if (result && typeof result.then === 'function') {
                return result.then(
                  (value: any) => {
                    span.end(0);
                    if (model) {
                      emitOk(
                        value,
                        undefined,
                        false,
                        value?.message?.content ?? value?.response
                      );
                    }
                    return value;
                  },
                  (error: any) => {
                    span.end(500, { 'error.message': error?.message });
                    if (model) {
                      recordProviderGeneration({
                        provider: 'ollama',
                        operation: op.operation,
                        type: op.type,
                        requestModel: model,
                        latencyMs: Date.now() - startedAt,
                        status: 'error',
                        errorType: error?.name || 'OllamaError',
                        errorMessage: error?.message,
                      });
                    }
                    throw error;
                  }
                );
              }

              // Streaming: returns an async iterable; the final chunk carries
              // prompt_eval_count / eval_count / done_reason.
              if (model && request?.stream && isAsyncIterable(result)) {
                let ttft: number | undefined;
                let last: any;
                const aggregated: string[] = [];
                span.end(0);
                return wrapAiStream(result, {
                  onChunk: (chunk: any) => {
                    if (ttft === undefined) ttft = Date.now() - startedAt;
                    last = chunk;
                    const text = chunk?.message?.content ?? chunk?.response;
                    if (typeof text === 'string') aggregated.push(text);
                  },
                  onDone: () => {
                    emitOk(last, ttft, true, aggregated.length ? aggregated.join('') : undefined);
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

export const instrumentOllama = (options?: SenzorOptions) => {
  hookRequire('ollama', (exports: any) => {
    if (!exports) return;
    // Class export
    if (typeof exports.Ollama === 'function' && exports.Ollama.prototype) {
      patchOllamaProto(exports.Ollama.prototype, options);
    }
    // Default singleton instance — patch its prototype (covers both).
    const instance = exports.default ?? exports;
    if (instance && typeof instance === 'object') {
      const proto = Object.getPrototypeOf(instance);
      if (proto && proto !== exports.Ollama?.prototype) {
        patchOllamaProto(proto, options);
      }
    }
  });
};
