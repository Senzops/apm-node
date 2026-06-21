import { SenzorOptions } from '../../core/types';
import { hookRequire } from '../hook';
import { patchMethod } from '../patch';
import { runWithCapturedSpan, startCapturedSpan } from '../span';
import { recordProviderGeneration } from './emit';
import { isAsyncIterable, wrapAiStream } from './stream';

// ---------------------------------------------------------------------------
// Shared instrumentation for OpenAI-compatible, Stainless-generated clients
// (Groq, and any vendor that mirrors the OpenAI wire format). Captures APM
// spans + first-class AI generations (incl. streaming via the non-consuming
// wrapper). Generations are emitted only from `post` (the model-bearing
// dispatch), so files/models-list/etc. and the get/put/... span patches don't
// double count.
// ---------------------------------------------------------------------------

const OPERATION_MAP: Record<string, string> = {
  'chat/completions': 'chat',
  completions: 'completions',
  embeddings: 'embeddings',
  'audio/transcriptions': 'audio.transcribe',
  'audio/translations': 'audio.translate',
};

const getOperationName = (path: string): string => {
  if (!path) return 'unknown';
  const normalized = path.replace(/^\/?(openai\/)?(v1\/)?/, '');
  for (const [pattern, name] of Object.entries(OPERATION_MAP)) {
    if (normalized === pattern || normalized.startsWith(pattern + '/')) return name;
  }
  return normalized.split('/')[0] || 'api';
};

export const instrumentOpenAICompatible = (
  moduleName: string,
  getClass: (mod: any) => any,
  provider: string,
  label: string,
  options?: SenzorOptions
) => {
  hookRequire(moduleName, (exports: any) => {
    const Client = getClass(exports);
    if (typeof Client !== 'function' || !Client.prototype) return;

    const proto = Client.prototype;
    const httpMethods = ['post', 'get', 'put', 'patch', 'delete'] as const;

    for (const method of httpMethods) {
      if (typeof proto[method] !== 'function') continue;

      patchMethod(
        proto,
        method,
        `senzor.${provider}.client.${method}`,
        (original) =>
          function patchedMethod(this: any, path: string, opts?: any) {
            const operationName = getOperationName(path);
            const model = opts?.body?.model;
            const spanName = model ? `${label} ${operationName} ${model}` : `${label} ${operationName}`;

            const span = startCapturedSpan(
              spanName,
              'http',
              {
                'gen_ai.system': provider,
                'gen_ai.operation.name': operationName,
                'gen_ai.request.model': model,
                'http.request.method': method.toUpperCase(),
                'url.path': path,
                library: provider,
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
                      if (response?.usage) {
                        endMeta['gen_ai.usage.input_tokens'] = response.usage.prompt_tokens;
                        endMeta['gen_ai.usage.output_tokens'] = response.usage.completion_tokens;
                      }
                      if (response?.model) endMeta['gen_ai.response.model'] = response.model;
                      span.end(0, endMeta);

                      if (model && method === 'post') {
                        const params = {
                          temperature: opts?.body?.temperature,
                          max_tokens: opts?.body?.max_tokens,
                          top_p: opts?.body?.top_p,
                        };
                        const input = opts?.body?.messages ?? opts?.body?.input ?? opts?.body?.prompt;

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
                                provider,
                                operation: operationName,
                                requestModel: model,
                                responseModel: respModel,
                                tokensIn: usage?.prompt_tokens,
                                tokensOut: usage?.completion_tokens,
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
                          provider,
                          operation: operationName,
                          requestModel: model,
                          responseModel: response?.model,
                          tokensIn: response?.usage?.prompt_tokens,
                          tokensOut: response?.usage?.completion_tokens,
                          latencyMs: Date.now() - startedAt,
                          finishReason: response?.choices?.[0]?.finish_reason,
                          streaming: false,
                          params,
                          input,
                          output: response?.choices,
                          status: 'ok',
                        });
                      }

                      return response;
                    },
                    (error: any) => {
                      const statusCode = error?.status || error?.statusCode || 500;
                      span.end(statusCode, {
                        'error.message': error?.message,
                        'error.type': error?.name || `${label}Error`,
                        'http.response.status_code': statusCode,
                      });
                      if (model && method === 'post') {
                        recordProviderGeneration({
                          provider,
                          operation: operationName,
                          requestModel: model,
                          latencyMs: Date.now() - startedAt,
                          streaming: !!opts?.body?.stream,
                          status: 'error',
                          statusCode,
                          errorType: error?.name || `${label}Error`,
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
  });
};
