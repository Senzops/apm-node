import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';
import { recordProviderGeneration } from './ai/emit';

/** Emit a first-class AI generation for a Gemini call. */
const emitGemini = (
  system: 'google_ai' | 'vertex_ai',
  operation: string,
  model: string,
  startedAt: number,
  value: any,
  error: any
) => {
  const response = value?.response || value;
  const usage = response?.usageMetadata;
  recordProviderGeneration({
    provider: system === 'vertex_ai' ? 'google-vertex' : 'google-genai',
    operation,
    requestModel: model,
    tokensIn: usage?.promptTokenCount,
    tokensOut: usage?.candidatesTokenCount,
    latencyMs: Date.now() - startedAt,
    finishReason: response?.candidates?.[0]?.finishReason,
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
// Public API
// ---------------------------------------------------------------------------

export const instrumentGoogleGenAI = (options?: SenzorOptions) => {
  hookRequire('@google/generative-ai', (exports: any) => {
    patchGoogleGenAI(exports, options);
  });

  hookRequire('@google-cloud/vertexai', (exports: any) => {
    patchVertexAI(exports, options);
  });
};
