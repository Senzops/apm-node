import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';
import { recordProviderGeneration } from './ai/emit';
import { isAsyncIterable, wrapAiStream } from './ai/stream';

/** Emit a first-class AI generation for a Gemini call. */
const emitGemini = (
  system: 'google_ai' | 'vertex_ai',
  operation: string,
  model: string,
  startedAt: number,
  value: any,
  error: any,
  extra?: { type?: 'generation' | 'embedding'; input?: any; output?: any }
) => {
  const response = value?.response || value;
  const usage = response?.usageMetadata;
  recordProviderGeneration({
    provider: system === 'vertex_ai' ? 'google-vertex' : 'google-genai',
    operation,
    type: extra?.type,
    requestModel: model,
    // The unified @google/genai SDK reports the resolved model on the response.
    responseModel: response?.modelVersion,
    tokensIn: usage?.promptTokenCount,
    tokensOut: usage?.candidatesTokenCount,
    // Gemini "thinking" tokens (extended reasoning) — undefined on older SDKs.
    reasoningTokens: usage?.thoughtsTokenCount,
    latencyMs: Date.now() - startedAt,
    finishReason: response?.candidates?.[0]?.finishReason,
    // Content is gated client-side (captureContent) and masked server-side.
    input: extra?.input,
    output: error ? undefined : extra?.output,
    status: error ? 'error' : 'ok',
    errorType: error ? (error.name || 'GoogleGenAIError') : undefined,
    errorMessage: error ? error.message : undefined,
  });
};

// ---------------------------------------------------------------------------
// Google Generative AI (Gemini) Instrumentation
//
// Instruments both the client-side `@google/generative-ai` package and the
// server-side `@google-cloud/vertexai` package for Google's Gemini models.
//
// @google/generative-ai patches:
//   - GenerativeModel.prototype.generateContent()
//   - GenerativeModel.prototype.generateContentStream()
//   - GenerativeModel.prototype.countTokens()
//   - GenerativeModel.prototype.embedContent()
//   - GenerativeModel.prototype.batchEmbedContents()
//   - ChatSession.prototype.sendMessage()
//   - ChatSession.prototype.sendMessageStream()
//
// @google-cloud/vertexai patches:
//   - GenerativeModel.prototype.generateContent()
//   - GenerativeModel.prototype.generateContentStream()
//
// Captured attributes (OTel GenAI semantic conventions):
//   - gen_ai.system: 'google_ai' | 'vertex_ai'
//   - gen_ai.request.model: gemini-1.5-pro, etc.
//   - gen_ai.operation.name: generateContent, chat, embedContent, etc.
//   - gen_ai.usage.input_tokens: promptTokenCount
//   - gen_ai.usage.output_tokens: candidatesTokenCount
//   - gen_ai.response.finish_reason: from candidates[0].finishReason
// ---------------------------------------------------------------------------

/** Extract token usage from Gemini response. */
const extractUsage = (response: any): Record<string, any> => {
  const meta: Record<string, any> = {};
  const usage = response?.usageMetadata;

  if (usage) {
    if (usage.promptTokenCount !== undefined) {
      meta['gen_ai.usage.input_tokens'] = usage.promptTokenCount;
    }
    if (usage.candidatesTokenCount !== undefined) {
      meta['gen_ai.usage.output_tokens'] = usage.candidatesTokenCount;
    }
    if (usage.totalTokenCount !== undefined) {
      meta['gen_ai.usage.total_tokens'] = usage.totalTokenCount;
    }
  }

  // Extract finish reason from first candidate
  const finishReason = response?.candidates?.[0]?.finishReason;
  if (finishReason) {
    meta['gen_ai.response.finish_reason'] = finishReason;
  }

  return meta;
};

/** Extract usage from a GenerateContentResponse (may be wrapped). */
const extractResponseUsage = (result: any): Record<string, any> => {
  // result could be GenerateContentResult { response } or the response directly
  const response = result?.response || result;
  return extractUsage(response);
};

// ---------------------------------------------------------------------------
// @google/generative-ai patching
// ---------------------------------------------------------------------------

const patchGoogleGenAI = (genaiModule: any, options?: SenzorOptions) => {
  // Patch GenerativeModel
  const GenerativeModel = genaiModule?.GenerativeModel;
  if (GenerativeModel?.prototype) {
    const proto = GenerativeModel.prototype;

    // --- generateContent ---
    patchMethod(
      proto,
      'generateContent',
      'senzor.google-genai.generateContent',
      (original) =>
        function patchedGenerateContent(this: any, request: any) {
          const modelName = this.model || this.modelName || 'unknown';

          const span = startCapturedSpan(
            `Gemini generateContent ${modelName}`,
            'http',
            {
              'gen_ai.system': 'google_ai',
              'gen_ai.operation.name': 'generateContent',
              'gen_ai.request.model': modelName,
              'gen_ai.request.temperature': this.generationConfig?.temperature,
              'gen_ai.request.max_tokens': this.generationConfig?.maxOutputTokens,
              'gen_ai.request.top_p': this.generationConfig?.topP,
              library: 'google-genai',
            },
            options
          );

          if (!span) return original.call(this, request);

          const startedAt = Date.now();

          return runWithCapturedSpan(span, () => {
            try {
              const result = original.call(this, request);

              if (result && typeof result.then === 'function') {
                return result.then(
                  (value: any) => {
                    span.end(0, extractResponseUsage(value));
                    emitGemini('google_ai', 'generateContent', modelName, startedAt, value, null);
                    return value;
                  },
                  (error: any) => {
                    span.end(error?.status || 500, {
                      'error.message': error?.message,
                      'error.type': error?.name || 'GoogleGenAIError',
                    });
                    emitGemini('google_ai', 'generateContent', modelName, startedAt, null, error);
                    throw error;
                  }
                );
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

    // --- generateContentStream ---
    if (typeof proto.generateContentStream === 'function') {
      patchMethod(
        proto,
        'generateContentStream',
        'senzor.google-genai.generateContentStream',
        (original) =>
          function patchedGenerateContentStream(this: any, request: any) {
            const modelName = this.model || this.modelName || 'unknown';

            const span = startCapturedSpan(
              `Gemini generateContentStream ${modelName}`,
              'http',
              {
                'gen_ai.system': 'google_ai',
                'gen_ai.operation.name': 'generateContentStream',
                'gen_ai.request.model': modelName,
                library: 'google-genai',
              },
              options
            );

            if (!span) return original.call(this, request);

            const startedAt = Date.now();

            return runWithCapturedSpan(span, () => {
              try {
                const result = original.call(this, request);

                if (result && typeof result.then === 'function') {
                  return result.then(
                    (streamResult: any) => {
                      // Stream result has a .response promise for final aggregated response
                      if (streamResult?.response && typeof streamResult.response.then === 'function') {
                        streamResult.response.then(
                          (resp: any) => {
                            span.end(0, extractUsage(resp));
                            emitGemini('google_ai', 'generateContentStream', modelName, startedAt, resp, null);
                          },
                          (err: any) => {
                            span.end(0);
                            emitGemini('google_ai', 'generateContentStream', modelName, startedAt, null, err);
                          }
                        );
                      } else {
                        span.end(0);
                      }
                      return streamResult;
                    },
                    (error: any) => {
                      span.end(error?.status || 500, { 'error.message': error?.message });
                      throw error;
                    }
                  );
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

    // --- countTokens ---
    if (typeof proto.countTokens === 'function') {
      patchMethod(
        proto,
        'countTokens',
        'senzor.google-genai.countTokens',
        (original) =>
          function patchedCountTokens(this: any, request: any) {
            const modelName = this.model || this.modelName || 'unknown';

            const span = startCapturedSpan(
              `Gemini countTokens ${modelName}`,
              'http',
              {
                'gen_ai.system': 'google_ai',
                'gen_ai.operation.name': 'countTokens',
                'gen_ai.request.model': modelName,
                library: 'google-genai',
              },
              options
            );

            if (!span) return original.call(this, request);

            return runWithCapturedSpan(span, () => {
              try {
                const result = original.call(this, request);
                if (result && typeof result.then === 'function') {
                  return result.then(
                    (value: any) => {
                      span.end(0, {
                        'gen_ai.usage.total_tokens': value?.totalTokens,
                      });
                      return value;
                    },
                    (error: any) => {
                      span.end(500, { 'error.message': error?.message });
                      throw error;
                    }
                  );
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

    // --- embedContent ---
    if (typeof proto.embedContent === 'function') {
      patchMethod(
        proto,
        'embedContent',
        'senzor.google-genai.embedContent',
        (original) =>
          function patchedEmbedContent(this: any, request: any) {
            const modelName = this.model || this.modelName || 'unknown';

            const span = startCapturedSpan(
              `Gemini embedContent ${modelName}`,
              'http',
              {
                'gen_ai.system': 'google_ai',
                'gen_ai.operation.name': 'embedContent',
                'gen_ai.request.model': modelName,
                library: 'google-genai',
              },
              options
            );

            if (!span) return original.call(this, request);

            return runWithCapturedSpan(span, () => {
              try {
                const result = original.call(this, request);
                if (result && typeof result.then === 'function') {
                  return result.then(
                    (value: any) => { span.end(0); return value; },
                    (error: any) => {
                      span.end(500, { 'error.message': error?.message });
                      throw error;
                    }
                  );
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
  }

  // Patch ChatSession
  const ChatSession = genaiModule?.ChatSession;
  if (ChatSession?.prototype) {
    const chatProto = ChatSession.prototype;

    for (const method of ['sendMessage', 'sendMessageStream'] as const) {
      if (typeof chatProto[method] !== 'function') continue;

      patchMethod(
        chatProto,
        method,
        `senzor.google-genai.chat.${method}`,
        (original) =>
          function patchedChatMethod(this: any, ...args: any[]) {
            const modelName = this.model || this._model || 'unknown';
            const isStream = method === 'sendMessageStream';

            const span = startCapturedSpan(
              `Gemini chat.${method} ${modelName}`,
              'http',
              {
                'gen_ai.system': 'google_ai',
                'gen_ai.operation.name': isStream ? 'chat.stream' : 'chat',
                'gen_ai.request.model': modelName,
                library: 'google-genai',
              },
              options
            );

            if (!span) return original.apply(this, args);

            const startedAt = Date.now();
            const chatOp = isStream ? 'chat.stream' : 'chat';

            return runWithCapturedSpan(span, () => {
              try {
                const result = original.apply(this, args);
                if (result && typeof result.then === 'function') {
                  return result.then(
                    (value: any) => {
                      span.end(0, extractResponseUsage(value));
                      emitGemini('google_ai', chatOp, modelName, startedAt, value, null);
                      return value;
                    },
                    (error: any) => {
                      span.end(500, { 'error.message': error?.message });
                      emitGemini('google_ai', chatOp, modelName, startedAt, null, error);
                      throw error;
                    }
                  );
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
  }
};

// ---------------------------------------------------------------------------
// @google-cloud/vertexai patching (same model classes, different system tag)
// ---------------------------------------------------------------------------

const patchVertexAI = (vertexModule: any, options?: SenzorOptions) => {
  const GenerativeModel = vertexModule?.GenerativeModel;
  if (!GenerativeModel?.prototype) return;

  const proto = GenerativeModel.prototype;

  for (const method of ['generateContent', 'generateContentStream'] as const) {
    if (typeof proto[method] !== 'function') continue;

    patchMethod(
      proto,
      method,
      `senzor.vertexai.${method}`,
      (original) =>
        function patchedVertexMethod(this: any, request: any) {
          const modelName = this.model || this.modelName || 'unknown';

          const span = startCapturedSpan(
            `VertexAI ${method} ${modelName}`,
            'http',
            {
              'gen_ai.system': 'vertex_ai',
              'gen_ai.operation.name': method,
              'gen_ai.request.model': modelName,
              library: 'vertex-ai',
            },
            options
          );

          if (!span) return original.call(this, request);

          const startedAt = Date.now();

          return runWithCapturedSpan(span, () => {
            try {
              const result = original.call(this, request);
              if (result && typeof result.then === 'function') {
                return result.then(
                  (value: any) => {
                    span.end(0, extractResponseUsage(value));
                    emitGemini('vertex_ai', method, modelName, startedAt, value, null);
                    return value;
                  },
                  (error: any) => {
                    span.end(500, { 'error.message': error?.message });
                    emitGemini('vertex_ai', method, modelName, startedAt, null, error);
                    throw error;
                  }
                );
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
// @google/genai patching (the NEW unified Google Gen AI SDK)
//
// Structurally different from @google/generative-ai: the entry is `GoogleGenAI`
// and calls go through `ai.models.*`. The public `generateContent`/`embedContent`
// (and the automatic-function-calling loop, and `chat.sendMessage`) ALL funnel
// through the `Models.prototype.*Internal` methods — the reliable single
// chokepoints. We patch only those, so each model turn is recorded exactly once
// (patching `Chat.sendMessage` too would double-count, since it internally calls
// `modelsModule.generateContent` → `generateContentInternal`). Streaming
// (`generateContentStreamInternal`, used by both `models.generateContentStream`
// and `chat.sendMessageStream`) is observed without consuming the stream.
// ---------------------------------------------------------------------------

// Aggregate response text from the candidate parts directly. We deliberately do
// NOT use the SDK's `response.text` getter: on a function-call / "thinking"
// response (every agentic turn) that getter logs a `console.warn`, which would
// spam host logs. This reads the same text without side effects.
const safeText = (value: any): string | undefined => {
  try {
    const r = value?.response || value;
    const parts = r?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return undefined;
    const text = parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
    return text || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Build a patched async method for the new SDK (shared shape across calls).
 *
 * The first-class AI generation is emitted REGARDLESS of whether an APM/task
 * span context is active — AI Monitoring is an independent pillar, so a Gemini
 * call in a plain script (no enclosing HTTP/task trace) is still recorded. The
 * APM span is created opportunistically (only when a context exists) for the
 * APM↔AI cross-link. Content is read only when capture is enabled.
 */
const wrapGenaiV2 = (
  operation: string,
  type: 'generation' | 'embedding',
  getModel: (params: any) => string | undefined,
  getInput: (params: any) => any,
  options?: SenzorOptions,
) => (original: Function) =>
  function patchedGenaiV2(this: any, params: any, ...rest: any[]) {
    const model = getModel(params) || 'unknown';
    const capture = options?.ai?.captureContent === true;
    const span = startCapturedSpan(
      `Gemini ${operation} ${model}`,
      'http',
      { 'gen_ai.system': 'google_ai', 'gen_ai.operation.name': operation, 'gen_ai.request.model': model, library: 'google-genai' },
      options,
    );
    const startedAt = Date.now();

    const exec = () => {
      let result: any;
      try {
        result = original.call(this, params, ...rest);
      } catch (error: any) {
        span?.end(500, { 'error.message': error?.message });
        emitGemini('google_ai', operation, model, startedAt, null, error, { type });
        throw error;
      }

      if (result && typeof result.then === 'function') {
        return result.then(
          (value: any) => {
            span?.end(0, extractResponseUsage(value));
            emitGemini('google_ai', operation, model, startedAt, value, null, {
              type,
              input: capture ? getInput(params) : undefined,
              output: capture && type !== 'embedding' ? safeText(value) : undefined,
            });
            return value;
          },
          (error: any) => {
            span?.end(error?.status || 500, { 'error.message': error?.message, 'error.type': error?.name || 'GoogleGenAIError' });
            emitGemini('google_ai', operation, model, startedAt, null, error, { type });
            throw error;
          },
        );
      }

      // Non-thenable (unexpected for these methods) — close the span, no emit.
      span?.end(0);
      return result;
    };

    return span ? runWithCapturedSpan(span, exec) : exec();
  };

/**
 * Patch a streaming method (an `async` fn that resolves to an AsyncGenerator of
 * response chunks). We wrap the resolved stream with `wrapAiStream` — a Proxy
 * that observes each chunk as the consumer pulls it WITHOUT consuming the stream
 * ourselves — and emit one generation when iteration ends. Usage / finish reason
 * come off the final chunk; TTFT off the first; text is aggregated from parts.
 */
const wrapGenaiV2Stream = (
  operation: string,
  getModel: (params: any) => string | undefined,
  getInput: (params: any) => any,
  options?: SenzorOptions,
) => (original: Function) =>
  function patchedGenaiV2Stream(this: any, params: any, ...rest: any[]) {
    const model = getModel(params) || 'unknown';
    const capture = options?.ai?.captureContent === true;
    const span = startCapturedSpan(
      `Gemini ${operation} ${model}`,
      'http',
      { 'gen_ai.system': 'google_ai', 'gen_ai.operation.name': operation, 'gen_ai.request.model': model, library: 'google-genai' },
      options,
    );
    const startedAt = Date.now();

    const emitError = (error: any) => {
      recordProviderGeneration({
        provider: 'google-genai', operation, requestModel: model,
        latencyMs: Date.now() - startedAt, streaming: true, status: 'error',
        errorType: error?.name || 'GoogleGenAIError', errorMessage: error?.message,
      });
    };

    const exec = () => {
      let resultPromise: any;
      try {
        resultPromise = original.call(this, params, ...rest);
      } catch (error: any) {
        span?.end(500, { 'error.message': error?.message });
        emitError(error);
        throw error;
      }
      if (!resultPromise || typeof resultPromise.then !== 'function') {
        span?.end(0);
        return resultPromise;
      }

      return resultPromise.then(
        (stream: any) => {
          if (!isAsyncIterable(stream)) { span?.end(0); return stream; }

          let ttft: number | undefined;
          let usage: any;
          let respModel: string | undefined;
          let finishReason: string | undefined;
          const textParts: string[] = [];

          return wrapAiStream(stream, {
            onChunk: (chunk: any) => {
              if (ttft === undefined) ttft = Date.now() - startedAt;
              if (chunk?.usageMetadata) usage = chunk.usageMetadata; // final chunk carries cumulative usage
              if (chunk?.modelVersion) respModel = chunk.modelVersion;
              const fr = chunk?.candidates?.[0]?.finishReason;
              if (fr) finishReason = fr;
              if (capture) {
                const parts = chunk?.candidates?.[0]?.content?.parts;
                if (Array.isArray(parts)) for (const p of parts) if (typeof p?.text === 'string') textParts.push(p.text);
              }
            },
            onDone: (error?: any) => {
              span?.end(error ? 500 : 0);
              if (error) { emitError(error); return; }
              recordProviderGeneration({
                provider: 'google-genai',
                operation,
                requestModel: model,
                responseModel: respModel,
                tokensIn: usage?.promptTokenCount,
                tokensOut: usage?.candidatesTokenCount,
                reasoningTokens: usage?.thoughtsTokenCount,
                latencyMs: Date.now() - startedAt,
                timeToFirstTokenMs: ttft,
                finishReason,
                streaming: true,
                input: capture ? getInput(params) : undefined,
                output: capture && textParts.length ? textParts.join('') : undefined,
                status: 'ok',
              });
            },
          });
        },
        (error: any) => {
          span?.end(error?.status || 500, { 'error.message': error?.message, 'error.type': error?.name || 'GoogleGenAIError' });
          emitError(error);
          throw error;
        },
      );
    };

    return span ? runWithCapturedSpan(span, exec) : exec();
  };

const patchGoogleGenAIV2 = (genaiModule: any, options?: SenzorOptions) => {
  // Model + input come from the request params handed to the *Internal methods.
  const modelsProto = genaiModule?.Models?.prototype;
  if (!modelsProto) return;

  if (typeof modelsProto.generateContentInternal === 'function') {
    patchMethod(modelsProto, 'generateContentInternal', 'senzor.google-genai-v2.generateContent',
      wrapGenaiV2('generateContent', 'generation', (p) => p?.model, (p) => p?.contents, options));
  }
  if (typeof modelsProto.generateContentStreamInternal === 'function') {
    // Chokepoint for both `models.generateContentStream` and `chat.sendMessageStream`.
    patchMethod(modelsProto, 'generateContentStreamInternal', 'senzor.google-genai-v2.generateContentStream',
      wrapGenaiV2Stream('generateContentStream', (p) => p?.model, (p) => p?.contents, options));
  }
  if (typeof modelsProto.embedContentInternal === 'function') {
    patchMethod(modelsProto, 'embedContentInternal', 'senzor.google-genai-v2.embedContent',
      wrapGenaiV2('embedContent', 'embedding', (p) => p?.model, (p) => p?.contents, options));
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentGoogleGenAI = (options?: SenzorOptions) => {
  // Old client SDK.
  hookRequire('@google/generative-ai', (exports: any) => {
    patchGoogleGenAI(exports, options);
  });

  // New unified SDK.
  hookRequire('@google/genai', (exports: any) => {
    patchGoogleGenAIV2(exports, options);
  });

  hookRequire('@google-cloud/vertexai', (exports: any) => {
    patchVertexAI(exports, options);
  });
};
