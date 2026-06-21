import { SenzorOptions } from '../core/types';
import { instrumentOpenAICompatible } from './ai/openai-compatible';

// ---------------------------------------------------------------------------
// Groq SDK Instrumentation (`groq-sdk`)
//
// Groq's SDK is Stainless-generated and OpenAI wire-compatible (chat
// completions, embeddings, audio), so it shares the OpenAI-compatible
// instrumentation: APM spans + first-class AI generations with cost/tokens/
// latency and non-consuming streaming token accounting.
// ---------------------------------------------------------------------------

export const instrumentGroq = (options?: SenzorOptions) => {
  instrumentOpenAICompatible(
    'groq-sdk',
    (mod: any) => mod?.Groq || mod?.default || mod,
    'groq',
    'Groq',
    options
  );
};
