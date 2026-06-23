import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { recordProviderGeneration } from './ai/emit';
import { getAiManager } from '../core/ai';

// ---------------------------------------------------------------------------
// LangChain.js Instrumentation (`@langchain/core`)
//
// Patches `BaseChatModel.prototype.invoke` — the dominant call path that every
// provider chat model (ChatOpenAI, ChatAnthropic, ChatGoogleGenerativeAI, ...)
// funnels through. Patching the single base method (rather than each provider
// or both invoke+generate) avoids double counting.
//
// Token usage is read from the returned message's `usage_metadata`
// ({ input_tokens, output_tokens }) — the normalized field LangChain populates
// across providers in recent versions. Provider is derived from `_llmType()`.
//
// `.stream()` is a separate path (returns a chunk stream) and is not covered
// here — users on streaming can use the manual `Senzor.ai.wrapGeneration` API.
// ---------------------------------------------------------------------------

const modelNameOf = (self: any): string | undefined =>
  self?.model ?? self?.modelName ?? self?.model_name;

const providerOf = (self: any): string => {
  try {
    const t = typeof self?._llmType === 'function' ? self._llmType() : undefined;
    if (typeof t === 'string' && t.length) return t;
  } catch { /* ignore */ }
  return 'langchain';
};

const usageOf = (message: any): { tokensIn?: number; tokensOut?: number } => {
  const u = message?.usage_metadata;
  if (u) return { tokensIn: u.input_tokens, tokensOut: u.output_tokens };
  // Fallbacks for older shapes.
  const r = message?.response_metadata?.tokenUsage ?? message?.response_metadata?.usage;
  if (r) {
    return {
      tokensIn: r.promptTokens ?? r.prompt_tokens ?? r.input_tokens,
      tokensOut: r.completionTokens ?? r.completion_tokens ?? r.output_tokens,
    };
  }
  return {};
};

const patchInvoke = (proto: any) => {
  if (!proto || typeof proto.invoke !== 'function') return;

  patchMethod(
    proto,
    'invoke',
    'senzor.langchain.chat.invoke',
    (original) =>
      function patchedInvoke(this: any, input: any, ...rest: any[]) {
        const model = modelNameOf(this);
        const provider = providerOf(this);
        const startedAt = Date.now();

        const result = original.call(this, input, ...rest);
        if (!result || typeof result.then !== 'function') return result;

        return result.then(
          (message: any) => {
            const { tokensIn, tokensOut } = usageOf(message);
            recordProviderGeneration({
              provider,
              operation: 'chat',
              requestModel: model,
              responseModel: message?.response_metadata?.model_name ?? model,
              tokensIn,
              tokensOut,
              latencyMs: Date.now() - startedAt,
              finishReason:
                message?.response_metadata?.finish_reason ??
                message?.response_metadata?.stop_reason,
              input,
              output: message?.content,
              metadata: { framework: 'langchain' },
              status: 'ok',
            });
            return message;
          },
          (error: any) => {
            recordProviderGeneration({
              provider,
              operation: 'chat',
              requestModel: model,
              latencyMs: Date.now() - startedAt,
              metadata: { framework: 'langchain' },
              status: 'error',
              errorType: error?.name || 'LangChainError',
              errorMessage: error?.message,
            });
            throw error;
          }
        );
      }
  );
};

// ---------------------------------------------------------------------------
// Tool execution. Patch the tool base class's OWN `invoke` so each tool call
// becomes a `tool` observation. Routed through `manager.tool()` so it nests
// under the active AI trace (if the user wrapped the run in `Senzor.ai.trace`/
// `agent`), or stands alone otherwise. We only patch a prototype that owns
// `invoke` to avoid patching the generic Runnable.invoke (which would wrap
// every chain/model and double-count).
// ---------------------------------------------------------------------------
const patchToolInvoke = (proto: any) => {
  if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'invoke') || typeof proto.invoke !== 'function') return;

  patchMethod(
    proto,
    'invoke',
    'senzor.langchain.tool.invoke',
    (original) =>
      function patchedToolInvoke(this: any, input: any, ...rest: any[]) {
        const manager = getAiManager();
        if (!manager) return original.call(this, input, ...rest);
        const name = this?.name ?? 'tool';
        try {
          return manager.tool({ name, args: input }, () => original.call(this, input, ...rest));
        } catch {
          return original.call(this, input, ...rest);
        }
      }
  );
};

export const instrumentLangchain = (_options?: SenzorOptions) => {
  hookRequire('@langchain/core/language_models/chat_models', (exports: any) => {
    if (exports?.BaseChatModel?.prototype) {
      patchInvoke(exports.BaseChatModel.prototype);
    }
  });
  hookRequire('@langchain/core/tools', (exports: any) => {
    if (!exports) return;
    // Patch whichever tool base classes define their own invoke. Subclasses
    // that inherit invoke are covered transitively.
    for (const cls of ['StructuredTool', 'Tool', 'DynamicTool', 'DynamicStructuredTool']) {
      patchToolInvoke(exports?.[cls]?.prototype);
    }
  });
};
