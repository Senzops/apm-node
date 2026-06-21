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
