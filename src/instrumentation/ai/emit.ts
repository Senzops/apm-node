import { getAiManager, RecordGenerationInput } from '../../core/ai';

// ---------------------------------------------------------------------------
// Shared bridge from provider auto-instrumentations to the AI manager.
//
// Provider hooks already create APM HTTP spans (for the APM↔AI cross-link);
// this additionally records a first-class AI generation so the call shows up
// in the AI Monitoring pillar with cost/tokens/latency. Fully isolated — a
// failure here must never affect the instrumented call.
// ---------------------------------------------------------------------------

export const recordProviderGeneration = (input: RecordGenerationInput): void => {
  try {
    const manager = getAiManager();
    if (manager) manager.generation(input);
  } catch {
    /* never break the host call */
  }
};

/** A tool call observed alongside a generation (e.g. an AI SDK agent step). */
export interface ProviderToolCall {
  name: string;
  args?: any;
  result?: any;
  status?: 'ok' | 'error';
  errorMessage?: string;
  latencyMs?: number;
}

/**
 * Record a generation together with the tool calls it produced as one grouped
 * trace (generation → tool children). Used by framework instrumentation whose
 * result exposes the full step/tool structure (e.g. Vercel AI SDK `steps`).
 */
export const recordProviderGenerationWithTools = (
  input: RecordGenerationInput,
  tools?: ProviderToolCall[]
): void => {
  try {
    const manager = getAiManager();
    if (manager) manager.recordGenerationWithChildren(input, tools);
  } catch {
    /* never break the host call */
  }
};
