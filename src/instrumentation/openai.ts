import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';
import { recordProviderGeneration } from './ai/emit';
import { isAsyncIterable, wrapAiStream } from './ai/stream';

// ---------------------------------------------------------------------------
// OpenAI SDK Instrumentation
//
// Instruments the official `openai` npm package (v4+) to capture API calls
// to OpenAI services (GPT, DALL-E, Whisper, Embeddings, Assistants, etc.).
//
// Strategy: Patch the core APIClient._request() method — the single
// dispatch point for ALL OpenAI API calls. This covers:
//   - chat.completions.create()
//   - completions.create()
//   - embeddings.create()
//   - images.generate()
//   - audio.transcriptions.create()
//   - moderations.create()
//   - files.*, fine_tuning.*, assistants.*, threads.*, etc.
//
// Also patches specific resource methods for richer attribute capture
// (model name, token usage, etc.).
//
// Captured attributes (following emerging GenAI OTel conventions):
//   - gen_ai.system: 'openai'
//   - gen_ai.request.model: model name (gpt-4, gpt-3.5-turbo, etc.)
//   - gen_ai.operation.name: chat, completions, embeddings, etc.
//   - gen_ai.response.model: actual model used in response
//   - gen_ai.usage.input_tokens: prompt tokens
//   - gen_ai.usage.output_tokens: completion tokens
//   - gen_ai.request.max_tokens: requested max tokens
//   - gen_ai.request.temperature: temperature setting
//   - http.response.status_code: API response status
// ---------------------------------------------------------------------------

/** Map of resource path segments to operation names. */
const OPERATION_MAP: Record<string, string> = {
  'chat/completions': 'chat',
  completions: 'completions',
  embeddings: 'embeddings',
  images: 'images',
  'images/generations': 'images.generate',
  'images/edits': 'images.edit',
  'images/variations': 'images.variation',
  'audio/transcriptions': 'audio.transcribe',
  'audio/translations': 'audio.translate',
  'audio/speech': 'audio.speech',
  moderations: 'moderations',
  'fine_tuning/jobs': 'fine_tuning',
  files: 'files',
  assistants: 'assistants',
  threads: 'threads',
  'threads/runs': 'threads.runs',
  'threads/messages': 'threads.messages',
  batches: 'batches',
  'vector_stores': 'vector_stores',
};

/** Extract operation name from the API path. */
const getOperationName = (path: string): string => {
  if (!path) return 'unknown';

  // Normalize path: strip leading slash, version prefix
  const normalized = path.replace(/^\/?(v1\/)?/, '').replace(/\/[a-f0-9-]{20,}(\/|$)/g, '/');

  // Try exact match first, then prefix match
  for (const [pattern, name] of Object.entries(OPERATION_MAP)) {
    if (normalized === pattern || normalized.startsWith(pattern + '/')) {
      return name;
    }
  }

  // Fallback: first path segment
  return normalized.split('/')[0] || 'api';
};

/** Extract model from request body. */
const getRequestModel = (body: any): string | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  return body.model || undefined;
};

// ---------------------------------------------------------------------------
// Core APIClient._request patching
// ---------------------------------------------------------------------------

const patchOpenAIClient = (openaiModule: any, options?: SenzorOptions) => {
  // openai v4 exports OpenAI class (default export)
  const OpenAI = openaiModule?.OpenAI || openaiModule?.default || openaiModule;

  if (!OpenAI || typeof OpenAI !== 'function') return;

  const proto = OpenAI.prototype;
  if (!proto) return;

  // Find the internal request method — could be _request, post, get, etc.
  // In openai v4, the base client (APIClient) has these methods:
  // post(), get(), put(), patch(), delete() which all call _request()

  // Patch the HTTP methods on the prototype
  const httpMethods = ['post', 'get', 'put', 'patch', 'delete'] as const;

  for (const method of httpMethods) {
    if (typeof proto[method] !== 'function') continue;

    patchMethod(
      proto,
      method,
      `senzor.openai.client.${method}`,
      (original) =>
        function patchedMethod(this: any, path: string, opts?: any) {
          const operationName = getOperationName(path);
          const model = getRequestModel(opts?.body);
          const httpMethod = method.toUpperCase();

          const spanName = model
            ? `OpenAI ${operationName} ${model}`
            : `OpenAI ${operationName}`;

          const span = startCapturedSpan(
            spanName,
            'http',
            {
              'gen_ai.system': 'openai',
              'gen_ai.operation.name': operationName,
              'gen_ai.request.model': model,
              'gen_ai.request.max_tokens': opts?.body?.max_tokens,
              'gen_ai.request.temperature': opts?.body?.temperature,
              'http.request.method': httpMethod,
              'url.path': path,
              library: 'openai',
            },
            options
          );

          if (!span) return original.call(this, path, opts);

          const startedAt = Date.now();

          return runWithCapturedSpan(span, () => {
            try {
              const result = original.call(this, path, opts);

              if (result && typeof result.then === 'function') {
                return result.then(
                  (response: any) => {
                    const endMeta: Record<string, any> = {};

                    // Extract usage from response
                    if (response?.usage) {
                      endMeta['gen_ai.usage.input_tokens'] = response.usage.prompt_tokens;
                      endMeta['gen_ai.usage.output_tokens'] = response.usage.completion_tokens;
                      endMeta['gen_ai.usage.total_tokens'] = response.usage.total_tokens;
                    }

                    // Extract actual model used
                    if (response?.model) {
                      endMeta['gen_ai.response.model'] = response.model;
                    }

                    // Extract finish reason
                    if (response?.choices?.[0]?.finish_reason) {
                      endMeta['gen_ai.response.finish_reason'] = response.choices[0].finish_reason;
                    }

                    span.end(0, endMeta);

                    // First-class AI generation (only for model-bearing calls;
                    // skips files/models-list/etc.). Emitted once here, not in
                    // the _request fallback, to avoid double counting.
                    if (model) {
                      const params = {
                        temperature: opts?.body?.temperature,
                        max_tokens: opts?.body?.max_tokens,
                        top_p: opts?.body?.top_p,
                      };
                      const input = opts?.body?.messages ?? opts?.body?.input ?? opts?.body?.prompt;

                      // Streaming: observe the user's own iteration (never consume
                      // it ourselves). Usage requires stream_options.include_usage;
                      // TTFT is always captured from the first chunk.
                      if (opts?.body?.stream && isAsyncIterable(response)) {
                        let ttft: number | undefined;
                        let usage: any;
                        let respModel: string | undefined;
                        let finishReason: string | undefined;
                        const aggregated: string[] = [];

                        return wrapAiStream(response, {
                          onChunk: (chunk: any) => {
                            if (ttft === undefined) ttft = Date.now() - startedAt;
                            if (chunk?.usage) usage = chunk.usage;
                            if (chunk?.model) respModel = chunk.model;
                            const fr = chunk?.choices?.[0]?.finish_reason;
                            if (fr) finishReason = fr;
                            const delta = chunk?.choices?.[0]?.delta?.content;
                            if (typeof delta === 'string') aggregated.push(delta);
                          },
                          onDone: () => {
                            recordProviderGeneration({
                              provider: 'openai',
                              operation: operationName,
                              requestModel: model,
                              responseModel: respModel,
                              tokensIn: usage?.prompt_tokens,
                              tokensOut: usage?.completion_tokens,
                              reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
                              latencyMs: Date.now() - startedAt,
                              timeToFirstTokenMs: ttft,
                              finishReason,
                              streaming: true,
                              params,
                              input,
                              output: aggregated.length ? aggregated.join('') : undefined,
                              status: 'ok',
                            });
                          },
                        });
                      }

                      recordProviderGeneration({
                        provider: 'openai',
                        operation: operationName,
                        requestModel: model,
                        responseModel: response?.model,
                        tokensIn: response?.usage?.prompt_tokens,
                        tokensOut: response?.usage?.completion_tokens,
                        reasoningTokens: response?.usage?.completion_tokens_details?.reasoning_tokens,
                        latencyMs: Date.now() - startedAt,
                        finishReason: response?.choices?.[0]?.finish_reason,
                        streaming: false,
                        params,
                        input,
                        output: response?.choices ?? response?.data,
                        status: 'ok',
                      });
                    }

                    return response;
                  },
                  (error: any) => {
                    const statusCode = error?.status || error?.statusCode || 500;
                    span.end(statusCode, {
                      'error.message': error?.message,
                      'error.type': error?.name || error?.type || 'OpenAIError',
                      'http.response.status_code': statusCode,
                      'gen_ai.error.code': error?.code,
                    });

                    if (model) {
                      recordProviderGeneration({
                        provider: 'openai',
                        operation: operationName,
                        requestModel: model,
                        latencyMs: Date.now() - startedAt,
                        streaming: !!opts?.body?.stream,
                        status: 'error',
                        statusCode,
                        errorType: error?.name || error?.type || 'OpenAIError',
                        errorMessage: error?.message,
                      });
                    }

                    throw error;
                  }
                );
              }

              span.end(0);
              return result;
            } catch (error: any) {
              const statusCode = error?.status || 500;
              span.end(statusCode, {
                'error.message': error?.message,
                'error.type': error?.name || 'Error',
                'http.response.status_code': statusCode,
              });
              throw error;
            }
          });
        }
    );
  }

  // Also try to patch the internal request dispatcher
  if (typeof proto._request === 'function') {
    patchMethod(
      proto,
      '_request',
      'senzor.openai.client._request',
      (original) =>
        function patchedRequest(this: any, requestOptions: any, ...args: any[]) {
          // _request receives the full request options object
          const path = requestOptions?.path || '';
          const method = requestOptions?.method || 'POST';
          const operationName = getOperationName(path);
          const model = getRequestModel(requestOptions?.body);

          const spanName = model
            ? `OpenAI ${operationName} ${model}`
            : `OpenAI ${operationName}`;

          const span = startCapturedSpan(
            spanName,
            'http',
            {
              'gen_ai.system': 'openai',
              'gen_ai.operation.name': operationName,
              'gen_ai.request.model': model,
              'http.request.method': method,
              'url.path': path,
              library: 'openai',
            },
            options
          );

          if (!span) return original.call(this, requestOptions, ...args);

          return runWithCapturedSpan(span, () => {
            try {
              const result = original.call(this, requestOptions, ...args);

              if (result && typeof result.then === 'function') {
                return result.then(
                  (response: any) => {
                    const endMeta: Record<string, any> = {};

                    if (response?.usage) {
                      endMeta['gen_ai.usage.input_tokens'] = response.usage.prompt_tokens;
                      endMeta['gen_ai.usage.output_tokens'] = response.usage.completion_tokens;
                    }
                    if (response?.model) {
                      endMeta['gen_ai.response.model'] = response.model;
                    }

                    span.end(0, endMeta);
                    return response;
                  },
                  (error: any) => {
                    span.end(error?.status || 500, {
                      'error.message': error?.message,
                      'error.type': error?.name || 'OpenAIError',
                    });
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

export const instrumentOpenAI = (options?: SenzorOptions) => {
  hookRequire('openai', (exports: any) => {
    patchOpenAIClient(exports, options);
  });
};
