import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';
import { recordProviderGeneration } from './ai/emit';
import { isAsyncIterable, wrapAiStream } from './ai/stream';

// ---------------------------------------------------------------------------
// Anthropic SDK Instrumentation
//
// Instruments the official `@anthropic-ai/sdk` package (v0.20+).
//
// The Anthropic SDK is architecturally identical to OpenAI v4 — both are
// built on the same Stainless-generated base client (`APIClient`) with
// HTTP dispatch via `.post()`, `.get()`, etc.
//
// Patches:
//   - Anthropic.prototype.post/get/put/patch/delete — HTTP dispatch methods
//   - Anthropic.prototype._request — internal request dispatcher
//
// This covers ALL API calls:
//   - messages.create() (streaming & non-streaming)
//   - messages.batches.create()
//   - completions.create() (legacy)
//
// Captured attributes (OTel GenAI semantic conventions):
//   - gen_ai.system: 'anthropic'
//   - gen_ai.request.model: claude-sonnet-4-20250514, etc.
//   - gen_ai.operation.name: messages, completions, batches
//   - gen_ai.response.model: actual model from response
//   - gen_ai.usage.input_tokens: prompt token count
//   - gen_ai.usage.output_tokens: completion token count
//   - gen_ai.request.max_tokens: max_tokens parameter
//   - gen_ai.request.temperature: temperature parameter
//   - gen_ai.response.stop_reason: end_turn, max_tokens, etc.
// ---------------------------------------------------------------------------

/** Map API path segments to operation names. */
const OPERATION_MAP: Record<string, string> = {
  messages: 'messages',
  'messages/batches': 'messages.batches',
  completions: 'completions',
};

const getOperationName = (path: string): string => {
  if (!path) return 'unknown';
  const normalized = path.replace(/^\/?(v1\/)?/, '');

  for (const [pattern, name] of Object.entries(OPERATION_MAP)) {
    if (normalized === pattern || normalized.startsWith(pattern + '/')) {
      return name;
    }
  }

  return normalized.split('/')[0] || 'api';
};

const getRequestModel = (body: any): string | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  return body.model || undefined;
};

// ---------------------------------------------------------------------------
// Core client patching
// ---------------------------------------------------------------------------

const patchAnthropicClient = (anthropicModule: any, options?: SenzorOptions) => {
  const Anthropic = anthropicModule?.Anthropic
    || anthropicModule?.default
    || anthropicModule;

  if (!Anthropic || typeof Anthropic !== 'function') return;

  const proto = Anthropic.prototype;
  if (!proto) return;

  // Patch HTTP dispatch methods
  const httpMethods = ['post', 'get', 'put', 'patch', 'delete'] as const;

  for (const method of httpMethods) {
    if (typeof proto[method] !== 'function') continue;

    patchMethod(
      proto,
      method,
      `senzor.anthropic.client.${method}`,
      (original) =>
        function patchedMethod(this: any, path: string, opts?: any) {
          const operationName = getOperationName(path);
          const model = getRequestModel(opts?.body);
          const httpMethod = method.toUpperCase();

          const spanName = model
            ? `Anthropic ${operationName} ${model}`
            : `Anthropic ${operationName}`;

          const span = startCapturedSpan(
            spanName,
            'http',
            {
              'gen_ai.system': 'anthropic',
              'gen_ai.operation.name': operationName,
              'gen_ai.request.model': model,
              'gen_ai.request.max_tokens': opts?.body?.max_tokens,
              'gen_ai.request.temperature': opts?.body?.temperature,
              'gen_ai.request.top_p': opts?.body?.top_p,
              'http.request.method': httpMethod,
              'url.path': path,
              library: 'anthropic',
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

                    // Anthropic response format
                    if (response?.usage) {
                      endMeta['gen_ai.usage.input_tokens'] = response.usage.input_tokens;
                      endMeta['gen_ai.usage.output_tokens'] = response.usage.output_tokens;
                    }
                    if (response?.model) {
                      endMeta['gen_ai.response.model'] = response.model;
                    }
                    if (response?.stop_reason) {
                      endMeta['gen_ai.response.stop_reason'] = response.stop_reason;
                    }

                    span.end(0, endMeta);

                    // First-class AI generation. Emitted once here (not in the
                    // _request fallback) and only for model-bearing calls.
                    if (model) {
                      const params = {
                        temperature: opts?.body?.temperature,
                        max_tokens: opts?.body?.max_tokens,
                        top_p: opts?.body?.top_p,
                      };
                      const input = opts?.body?.messages ?? opts?.body?.prompt;

                      // Streaming: Anthropic emits usage natively via SSE events
                      // (message_start → input_tokens, message_delta → output_tokens).
                      if (opts?.body?.stream && isAsyncIterable(response)) {
                        let ttft: number | undefined;
                        let inputTokens: number | undefined;
                        let outputTokens: number | undefined;
                        let respModel: string | undefined;
                        let stopReason: string | undefined;
                        const aggregated: string[] = [];

                        return wrapAiStream(response, {
                          onChunk: (event: any) => {
                            if (ttft === undefined) ttft = Date.now() - startedAt;
                            if (event?.type === 'message_start') {
                              inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
                              outputTokens = event.message?.usage?.output_tokens ?? outputTokens;
                              respModel = event.message?.model ?? respModel;
                            } else if (event?.type === 'message_delta') {
                              if (event.usage?.output_tokens != null) outputTokens = event.usage.output_tokens;
                              if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
                            } else if (event?.type === 'content_block_delta') {
                              const text = event.delta?.text;
                              if (typeof text === 'string') aggregated.push(text);
                            }
                          },
                          onDone: () => {
                            recordProviderGeneration({
                              provider: 'anthropic',
                              operation: operationName,
                              requestModel: model,
                              responseModel: respModel,
                              tokensIn: inputTokens,
                              tokensOut: outputTokens,
                              latencyMs: Date.now() - startedAt,
                              timeToFirstTokenMs: ttft,
                              finishReason: stopReason,
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
                        provider: 'anthropic',
                        operation: operationName,
                        requestModel: model,
                        responseModel: response?.model,
                        tokensIn: response?.usage?.input_tokens,
                        tokensOut: response?.usage?.output_tokens,
                        latencyMs: Date.now() - startedAt,
                        finishReason: response?.stop_reason,
                        streaming: false,
                        params,
                        input,
                        output: response?.content,
                        status: 'ok',
                      });
                    }

                    return response;
                  },
                  (error: any) => {
                    const statusCode = error?.status || error?.statusCode || 500;
                    span.end(statusCode, {
                      'error.message': error?.message,
                      'error.type': error?.name || error?.type || 'AnthropicError',
                      'http.response.status_code': statusCode,
                      'gen_ai.error.code': error?.error?.type,
                    });

                    if (model) {
                      recordProviderGeneration({
                        provider: 'anthropic',
                        operation: operationName,
                        requestModel: model,
                        latencyMs: Date.now() - startedAt,
                        streaming: !!opts?.body?.stream,
                        status: 'error',
                        statusCode,
                        errorType: error?.name || error?.type || 'AnthropicError',
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
              span.end(error?.status || 500, {
                'error.message': error?.message,
                'error.type': error?.name || 'Error',
              });
              throw error;
            }
          });
        }
    );
  }

  // Also patch _request as fallback
  if (typeof proto._request === 'function') {
    patchMethod(
      proto,
      '_request',
      'senzor.anthropic.client._request',
      (original) =>
        function patchedRequest(this: any, requestOptions: any, ...args: any[]) {
          const path = requestOptions?.path || '';
          const method = requestOptions?.method || 'POST';
          const operationName = getOperationName(path);
          const model = getRequestModel(requestOptions?.body);

          const spanName = model
            ? `Anthropic ${operationName} ${model}`
            : `Anthropic ${operationName}`;

          const span = startCapturedSpan(
            spanName,
            'http',
            {
              'gen_ai.system': 'anthropic',
              'gen_ai.operation.name': operationName,
              'gen_ai.request.model': model,
              'http.request.method': method,
              'url.path': path,
              library: 'anthropic',
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
                      endMeta['gen_ai.usage.input_tokens'] = response.usage.input_tokens;
                      endMeta['gen_ai.usage.output_tokens'] = response.usage.output_tokens;
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

export const instrumentAnthropic = (options?: SenzorOptions) => {
  hookRequire('@anthropic-ai/sdk', (exports: any) => {
    patchAnthropicClient(exports, options);
  });
};
