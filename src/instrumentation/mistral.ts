import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';
import { recordProviderGeneration } from './ai/emit';
import { isAsyncIterable, wrapAiStream } from './ai/stream';

// ---------------------------------------------------------------------------
// Mistral AI SDK Instrumentation
//
// Instruments the official `@mistralai/mistralai` package.
//
// Mistral SDK architecture: The `Mistral` class has resource namespaces
// (chat, fim, embeddings, classifiers, models, agents, files, etc.) that
// each have async methods returning promises.
//
// The SDK also has an internal `_request` or `_fetch` method on the base
// client. We patch both the high-level resource methods AND the internal
// dispatch for full coverage.
//
// Patches:
//   - Mistral.prototype methods (post, get, etc.) — internal HTTP dispatch
//   - chat.complete() / chat.stream() — via resource namespaces
//   - embeddings.create()
//   - fim.complete() / fim.stream()
//   - classifiers.moderate() / classifiers.moderateChat()
//
// Captured attributes (OTel GenAI semantic conventions):
//   - gen_ai.system: 'mistral'
//   - gen_ai.request.model: mistral-large, codestral, etc.
//   - gen_ai.operation.name: chat, embeddings, fim, classify
//   - gen_ai.usage.input_tokens: prompt tokens
//   - gen_ai.usage.output_tokens: completion tokens
//   - gen_ai.response.model: actual model from response
//   - gen_ai.response.finish_reason: stop, length, etc.
// ---------------------------------------------------------------------------

/** Extract token usage from Mistral response. */
const extractMistralUsage = (result: any): Record<string, any> => {
  const meta: Record<string, any> = {};

  if (result?.usage) {
    meta['gen_ai.usage.input_tokens'] = result.usage.promptTokens ?? result.usage.prompt_tokens;
    meta['gen_ai.usage.output_tokens'] = result.usage.completionTokens ?? result.usage.completion_tokens;
    meta['gen_ai.usage.total_tokens'] = result.usage.totalTokens ?? result.usage.total_tokens;
  }

  if (result?.model) {
    meta['gen_ai.response.model'] = result.model;
  }

  const finishReason = result?.choices?.[0]?.finishReason
    ?? result?.choices?.[0]?.finish_reason;
  if (finishReason) {
    meta['gen_ai.response.finish_reason'] = finishReason;
  }

  return meta;
};

// ---------------------------------------------------------------------------
// Resource method patching
// ---------------------------------------------------------------------------

/** Patch a specific method on a resource namespace object. */
const patchResourceMethod = (
  resource: any,
  methodName: string,
  operation: string,
  getModel: (args: any[]) => string | undefined,
  extractUsage: (result: any) => Record<string, any>,
  patchKey: string,
  options?: SenzorOptions
) => {
  if (!resource || typeof resource[methodName] !== 'function') return;

  patchMethod(
    resource,
    methodName,
    patchKey,
    (original) =>
      function patchedMistralMethod(this: any, ...args: any[]) {
        const model = getModel(args);
        const spanName = model
          ? `Mistral ${operation} ${model}`
          : `Mistral ${operation}`;

        const span = startCapturedSpan(
          spanName,
          'http',
          {
            'gen_ai.system': 'mistral',
            'gen_ai.operation.name': operation,
            'gen_ai.request.model': model,
            library: 'mistral',
          },
          options
        );

        if (!span) return original.apply(this, args);

        const startedAt = Date.now();
        const emitType = operation.startsWith('embed') ? 'embedding' : 'generation';

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.apply(this, args);

            if (result && typeof result.then === 'function') {
              return result.then(
                (value: any) => {
                  span.end(0, extractUsage(value));
                  recordProviderGeneration({
                    provider: 'mistral',
                    operation,
                    type: emitType,
                    requestModel: model,
                    responseModel: value?.model,
                    tokensIn: value?.usage?.promptTokens ?? value?.usage?.prompt_tokens,
                    tokensOut: value?.usage?.completionTokens ?? value?.usage?.completion_tokens,
                    latencyMs: Date.now() - startedAt,
                    finishReason:
                      value?.choices?.[0]?.finishReason ?? value?.choices?.[0]?.finish_reason,
                    status: 'ok',
                  });
                  return value;
                },
                (error: any) => {
                  span.end(error?.statusCode || error?.status || 500, {
                    'error.message': error?.message,
                    'error.type': error?.name || 'MistralError',
                  });
                  recordProviderGeneration({
                    provider: 'mistral',
                    operation,
                    type: emitType,
                    requestModel: model,
                    latencyMs: Date.now() - startedAt,
                    status: 'error',
                    statusCode: error?.statusCode || error?.status || 500,
                    errorType: error?.name || 'MistralError',
                    errorMessage: error?.message,
                  });
                  throw error;
                }
              );
            }

            // Streaming (chat.stream / fim.stream): each event is a
            // CompletionEvent whose `.data` carries the delta and (on the final
            // event) usage. Observed without consuming the caller's stream.
            if (model && isAsyncIterable(result)) {
              span.end(0);
              let ttft: number | undefined;
              let tokensIn: number | undefined;
              let tokensOut: number | undefined;
              let respModel: string | undefined;
              let finishReason: string | undefined;
              const aggregated: string[] = [];

              return wrapAiStream(result, {
                onChunk: (ev: any) => {
                  if (ttft === undefined) ttft = Date.now() - startedAt;
                  const data = ev?.data ?? ev;
                  const text = data?.choices?.[0]?.delta?.content;
                  if (typeof text === 'string') aggregated.push(text);
                  if (data?.model) respModel = data.model;
                  if (data?.usage) {
                    tokensIn = data.usage.promptTokens ?? data.usage.prompt_tokens ?? tokensIn;
                    tokensOut = data.usage.completionTokens ?? data.usage.completion_tokens ?? tokensOut;
                  }
                  const fr = data?.choices?.[0]?.finishReason ?? data?.choices?.[0]?.finish_reason;
                  if (fr) finishReason = fr;
                },
                onDone: () => {
                  recordProviderGeneration({
                    provider: 'mistral',
                    operation,
                    type: emitType,
                    requestModel: model,
                    responseModel: respModel,
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
};

// ---------------------------------------------------------------------------
// Mistral client patching
// ---------------------------------------------------------------------------

const patchMistralClient = (mistralModule: any, options?: SenzorOptions) => {
  const Mistral = mistralModule?.Mistral
    || mistralModule?.MistralClient
    || mistralModule?.default;

  if (!Mistral || typeof Mistral !== 'function') return;

  const proto = Mistral.prototype;
  if (!proto) return;

  // Patch internal HTTP methods on the client prototype
  const httpMethods = ['post', 'get', 'put', 'patch', 'delete'] as const;
  for (const method of httpMethods) {
    if (typeof proto[method] !== 'function') continue;

    patchMethod(
      proto,
      method,
      `senzor.mistral.client.${method}`,
      (original) =>
        function patchedHttpMethod(this: any, path: string, ...args: any[]) {
          const body = args[0]?.body || args[0];
          const model = body?.model;
          const operation = path?.replace(/^\/?(v1\/)?/, '').split('/')[0] || 'api';

          const spanName = model
            ? `Mistral ${operation} ${model}`
            : `Mistral ${operation}`;

          const span = startCapturedSpan(
            spanName,
            'http',
            {
              'gen_ai.system': 'mistral',
              'gen_ai.operation.name': operation,
              'gen_ai.request.model': model,
              'http.request.method': method.toUpperCase(),
              'url.path': path,
              library: 'mistral',
            },
            options
          );

          if (!span) return original.call(this, path, ...args);

          return runWithCapturedSpan(span, () => {
            try {
              const result = original.call(this, path, ...args);

              if (result && typeof result.then === 'function') {
                return result.then(
                  (value: any) => {
                    span.end(0, extractMistralUsage(value));
                    return value;
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

  // Try to patch resource namespaces on instances
  // These are created in the constructor, so we wrap the constructor
  try {
    const tempClient = new Mistral({ apiKey: '__senzor_probe__' });

    // Patch chat resource
    if (tempClient.chat) {
      const chatProto = Object.getPrototypeOf(tempClient.chat);
      if (chatProto) {
        patchResourceMethod(chatProto, 'complete', 'chat', (a) => a[0]?.model, extractMistralUsage, 'senzor.mistral.chat.complete', options);
        patchResourceMethod(chatProto, 'stream', 'chat.stream', (a) => a[0]?.model, () => ({}), 'senzor.mistral.chat.stream', options);
      }
    }

    // Patch embeddings resource
    if (tempClient.embeddings) {
      const embedProto = Object.getPrototypeOf(tempClient.embeddings);
      if (embedProto) {
        patchResourceMethod(embedProto, 'create', 'embeddings', (a) => a[0]?.model, extractMistralUsage, 'senzor.mistral.embeddings.create', options);
      }
    }

    // Patch fim resource
    if ((tempClient as any).fim) {
      const fimProto = Object.getPrototypeOf((tempClient as any).fim);
      if (fimProto) {
        patchResourceMethod(fimProto, 'complete', 'fim', (a) => a[0]?.model, extractMistralUsage, 'senzor.mistral.fim.complete', options);
        patchResourceMethod(fimProto, 'stream', 'fim.stream', (a) => a[0]?.model, () => ({}), 'senzor.mistral.fim.stream', options);
      }
    }
  } catch {
    // Mistral constructor may require a real API key — resource patching is best-effort
    // The HTTP method patches on the prototype still cover all calls
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentMistral = (options?: SenzorOptions) => {
  hookRequire('@mistralai/mistralai', (exports: any) => {
    patchMistralClient(exports, options);
  });
};
