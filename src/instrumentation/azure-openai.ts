import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// Azure OpenAI Instrumentation
//
// Instruments the `@azure/openai` package (pre-v2) for Azure-hosted
// OpenAI models.
//
// IMPORTANT: Azure OpenAI SDK v2+ (released 2024) wraps the standard
// `openai` npm package internally. If the user has v2+, our existing
// OpenAI instrumentation already captures those calls automatically.
// This file covers the older, Azure-specific v1.x API.
//
// Patches OpenAIClient.prototype methods:
//   - getChatCompletions()   — chat model inference
//   - getCompletions()       — legacy completion inference
//   - getEmbeddings()        — embedding generation
//   - getImages()            — DALL-E image generation
//   - getAudioTranscription() — Whisper transcription
//   - getAudioTranslation()  — Whisper translation
//
// Captured attributes (OTel GenAI semantic conventions):
//   - gen_ai.system: 'azure_openai'
//   - gen_ai.request.model: deployment name
//   - gen_ai.operation.name: chat, completions, embeddings, etc.
//   - gen_ai.usage.input_tokens: prompt tokens
//   - gen_ai.usage.output_tokens: completion tokens
//   - gen_ai.response.finish_reason: stop, length, etc.
// ---------------------------------------------------------------------------

/** Methods to instrument with their operation name and token extraction strategy. */
const METHODS: {
  name: string;
  operation: string;
  extractUsage: (result: any) => Record<string, any>;
}[] = [
  {
    name: 'getChatCompletions',
    operation: 'chat',
    extractUsage: (result: any) => {
      const meta: Record<string, any> = {};
      if (result?.usage) {
        meta['gen_ai.usage.input_tokens'] = result.usage.promptTokens;
        meta['gen_ai.usage.output_tokens'] = result.usage.completionTokens;
        meta['gen_ai.usage.total_tokens'] = result.usage.totalTokens;
      }
      if (result?.choices?.[0]?.finishReason) {
        meta['gen_ai.response.finish_reason'] = result.choices[0].finishReason;
      }
      if (result?.model) {
        meta['gen_ai.response.model'] = result.model;
      }
      return meta;
    },
  },
  {
    name: 'getCompletions',
    operation: 'completions',
    extractUsage: (result: any) => {
      const meta: Record<string, any> = {};
      if (result?.usage) {
        meta['gen_ai.usage.input_tokens'] = result.usage.promptTokens;
        meta['gen_ai.usage.output_tokens'] = result.usage.completionTokens;
      }
      if (result?.choices?.[0]?.finishReason) {
        meta['gen_ai.response.finish_reason'] = result.choices[0].finishReason;
      }
      return meta;
    },
  },
  {
    name: 'getEmbeddings',
    operation: 'embeddings',
    extractUsage: (result: any) => {
      const meta: Record<string, any> = {};
      if (result?.usage) {
        meta['gen_ai.usage.input_tokens'] = result.usage.promptTokens;
        meta['gen_ai.usage.total_tokens'] = result.usage.totalTokens;
      }
      return meta;
    },
  },
  {
    name: 'getImages',
    operation: 'images',
    extractUsage: () => ({}),
  },
  {
    name: 'getAudioTranscription',
    operation: 'audio.transcribe',
    extractUsage: () => ({}),
  },
  {
    name: 'getAudioTranslation',
    operation: 'audio.translate',
    extractUsage: () => ({}),
  },
];

// ---------------------------------------------------------------------------
// OpenAIClient prototype patching
// ---------------------------------------------------------------------------

const patchAzureOpenAIClient = (azureModule: any, options?: SenzorOptions) => {
  const OpenAIClient = azureModule?.OpenAIClient;
  if (!OpenAIClient?.prototype) return;

  const proto = OpenAIClient.prototype;

  for (const methodConfig of METHODS) {
    if (typeof proto[methodConfig.name] !== 'function') continue;

    patchMethod(
      proto,
      methodConfig.name,
      `senzor.azure-openai.${methodConfig.name}`,
      (original) =>
        function patchedAzureMethod(this: any, deploymentName: string, ...args: any[]) {
          const span = startCapturedSpan(
            `Azure OpenAI ${methodConfig.operation} ${deploymentName}`,
            'http',
            {
              'gen_ai.system': 'azure_openai',
              'gen_ai.operation.name': methodConfig.operation,
              'gen_ai.request.model': deploymentName,
              'cloud.provider': 'azure',
              library: 'azure-openai',
            },
            options
          );

          if (!span) return original.call(this, deploymentName, ...args);

          return runWithCapturedSpan(span, () => {
            try {
              const result = original.call(this, deploymentName, ...args);

              if (result && typeof result.then === 'function') {
                return result.then(
                  (value: any) => {
                    span.end(0, methodConfig.extractUsage(value));
                    return value;
                  },
                  (error: any) => {
                    span.end(error?.status || 500, {
                      'error.message': error?.message,
                      'error.type': error?.name || 'AzureOpenAIError',
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

export const instrumentAzureOpenAI = (options?: SenzorOptions) => {
  hookRequire('@azure/openai', (exports: any) => {
    patchAzureOpenAIClient(exports, options);
  });
};
