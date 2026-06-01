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
