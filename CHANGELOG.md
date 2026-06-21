# 1.4.0

feat(ai): first-class AI Monitoring (LLM observability) pillar. New `Senzor.ai` API — `trace()` (group a multi-step workflow), `generation()` (record one LLM/tool/retrieval/embedding call), `wrapGeneration()` (time + record any model call) — for monitoring ANY AI provider manually. Provider auto-instrumentations (OpenAI, Anthropic, Azure OpenAI, Gemini/Vertex, Cohere, Mistral) now additionally emit first-class AI generations (model, tokens, latency, finish reason; opt-in prompt/output capture) to a new `/api/ingest/ai` pillar, in addition to the existing APM spans. New `ai` options: `{ enabled, captureContent (default false), sampleRate }`. AI traces auto-link to the active APM trace. Cost is computed server-side. Browser/edge builds expose the manual API for in-browser models (e.g. WebLLM).

feat(ai): expanded coverage — Vercel AI SDK (`ai`: generateText/streamText/generateObject/streamObject/embed/embedMany, provider auto-attributed from the model), LangChain.js (`@langchain/core` chat-model `invoke` with normalized `usage_metadata`), Groq (`groq-sdk`, OpenAI-compatible + streaming) and Ollama (`ollama`, local models, prompt_eval_count/eval_count incl. streaming). New instrumentation keys: `vercel-ai`, `langchain`, `groq`, `ollama`. Backend adds a top-consumers endpoint (cost/calls/tokens by user and by session) surfaced on the source dashboard.

feat(ai): quality/eval scores — new `Senzor.ai.score({ name, value, ... })` attaches numeric/boolean/categorical scores (user feedback, automated evals) to the active trace or a specific generation. Score averages surface on the source dashboard and per-trace; the dashboard adds thumbs up/down feedback.

feat(ai): streaming token accounting now also covers Cohere (`chatStream`) and Mistral (`chat.stream`/`fim.stream`) via the same non-consuming wrapper, completing streaming usage capture across all instrumented providers.

feat(ai): streaming token accounting via a non-consuming Proxy wrapper — observes the caller's own iteration to capture usage, time-to-first-token, finish reason and aggregated output without ever reading the stream ourselves (OpenAI usage requires `stream_options.include_usage`; Anthropic + Gemini expose usage natively). Other stream methods (`toReadableStream`, `tee`, …) are forwarded untouched.

# 1.3.9

fix(transport): split each flush into size-bounded requests (new `maxBatchBytes` option, default ~0.9MB) so a single POST can never exceed the ingest body limit; classify failures (retryable network/5xx/429 vs non-retryable 4xx) and drop+count non-retryable or oversized-single-item payloads instead of restoring them — fixes the death spiral where large instrumented payloads (413) silently halted telemetry until restart

# 1.3.8

fix(bullmq): forward all processJob arguments (token, fetchNextCallback) so lock tokens match — resolves "Lock mismatch ... moveToFinished from active" (code -6) and restores worker concurrency backpressure

# 1.3.7

fix: redis instrumentation

# 1.3.6

fix(mysql): resolve dummy thenable exception for callback-based queries

# 1.3.5

chore: address performance bugs

# 1.3.4

fix: resolve native Node.js ESM context loss and require-cache patching regressions
fix: support built-in modules auto-instrumentation (DNS, HTTP, FS, Net, perf_hooks) in ESM Node.js
feat: optimize Worker bundle payload by redirecting Node-specific packages to stub targets

# 1.3.3

fix: regression from v2 to v3

# 1.3.2

fix: package stability issues

# 1.3.1

feat: add support for aws lambda extension layer

# 1.3.0

feat: AI SDK instrumentation — Anthropic, Google Gemini (generative-ai + Vertex AI), Azure OpenAI, Cohere, Mistral
feat: Firebase Admin SDK instrumentation — Firestore CRUD/queries, Auth (16 methods), FCM Messaging (9 methods)
feat: AWS Lambda handler wrapper (wrapLambda) with cold start detection, trigger-type detection, Lambda context extraction, forced flush, and Lambda Extensions API SHUTDOWN registration
feat: AWS Bedrock Runtime GenAI attribute extraction (InvokeModel, Converse API) with token usage and finish reason
feat: Lambda environment auto-detection in register.ts — disables runtime metrics, optimizes batch/flush settings
feat: 43 total auto-instrumentations

# 1.2.2

fix: resolve ESM compatibility in hookRequire for framework span capture

# 1.2.1

feat: more enriched spans

# 1.2.0

feat: enhance package to be like OTEL

# 1.1.18

chore: introduce more robust ip extraction

# 1.1.17

feat: add logs monitoring

# 1.1.16

feat: support traceparent of RUM

# 1.1.15

feat: make setupGlobalErrorHandlers more robust and send much refined data

# 1.1.14

chore: make task auto instrumentation more robust
fix: ESM module patching
fix: module importing and patching for cron and bullmq auto instrumentation

# 1.1.12

feat: add advanced features in task monitoring

# 1.1.10

fix: module resolution for task monitoring instrumentations

# 1.1.9

feat: add task monitoring

# 1.1.8

feat: add error tracking in apm

# 1.1.7

stable working code
