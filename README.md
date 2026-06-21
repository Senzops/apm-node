# @senzops/apm-node

Official Node.js APM SDK for [Senzor](https://senzor.dev). Zero-dependency, production-grade distributed tracing, error tracking, log correlation, background task monitoring, and runtime metrics for Node.js services.

Replaces OpenTelemetry auto-instrumentation with a lightweight, Senzor-native alternative. 43 auto-instrumentations, 8 framework wrappers, and full AWS Lambda support in a single package with zero runtime dependencies.

## Installation

```sh
npm install @senzops/apm-node
```

## Quick Start

### Option 1: Preload Mode (Recommended)

Preload ensures instrumentation hooks install before your application imports any library.

```sh
# CommonJS
SENZOR_API_KEY=sz_apm_xxx node -r @senzops/apm-node/register server.js

# ESM
SENZOR_API_KEY=sz_apm_xxx node --import @senzops/apm-node/register server.mjs
```

### Option 2: Programmatic Init

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!,
});
```

Initialize as early as possible, before importing application modules.

---

## Auto-Instrumentation Coverage

All instrumentations activate automatically when the corresponding library is imported. No configuration required.

### Web Frameworks & HTTP

| # | Library | Instrumentation Key | What's Captured |
|---|---------|-------------------|-----------------|
| 1 | Node `http` / `https` | `http` | Inbound requests, outbound calls, distributed trace propagation |
| 2 | `fetch` (global) | `fetch` | Outbound HTTP, W3C Traceparent propagation |
| 3 | `undici` | `undici` | Outbound HTTP via Node's native HTTP client |
| 4 | Express | `express` | Route matching, middleware spans, error capture |
| 5 | Fastify | `fastify` | Route matching, hook spans, lifecycle spans |
| 6 | Koa | `koa` | Middleware stack, route detection |
| 7 | NestJS | `nestjs` | Controller/method resolution, Guards, Interceptors, Pipes |
| 8 | Hapi | `hapi` | Route handling, request lifecycle |
| 9 | Restify | `restify` | Route matching, handler chain spans |
| 10 | Connect | `connect` | Middleware stack instrumentation |

### Databases

| # | Library | Instrumentation Key | What's Captured |
|---|---------|-------------------|-----------------|
| 11 | `pg` (PostgreSQL) | `pg` | Queries, prepared statements, row counts, sanitized SQL |
| 12 | `mongodb` | `mongo` | Collection operations (find, insert, update, delete, aggregate, bulk) |
| 13 | `mongoose` | `mongoose` | Model operations with model/collection names |
| 14 | `mysql` / `mysql2` | `mysql` | Queries, sanitized SQL, connection metadata |
| 15 | `redis` / `ioredis` | `redis` | Commands (GET, SET, HGETALL, etc.), key names |
| 16 | `knex` | `knex` | Query builder operations, raw queries, transactions |
| 17 | `tedious` (SQL Server) | `tedious` | T-SQL queries, stored procedures, row counts |
| 18 | `cassandra-driver` | `cassandra` | CQL queries, batch operations, prepared statements |
| 19 | `memcached` | `memcached` | get, set, delete, incr/decr, flush operations |

### Messaging & Queues

| # | Library | Instrumentation Key | What's Captured |
|---|---------|-------------------|-----------------|
| 20 | `kafkajs` | `kafka` | Producer send, consumer message processing, topic/partition |
| 21 | `amqplib` (RabbitMQ) | `amqplib` | Publish, consume, ack/nack, queue/exchange names |
| 22 | `socket.io` | `socketio` | Event emit/receive, namespace, room operations |
| 23 | `bullmq` | `bullmq` | Worker job processing as task runs, queue delay, retries |
| 24 | `node-cron` | `cron` | Scheduled job execution as task runs |

### AI / LLM SDKs

| # | Library | Instrumentation Key | What's Captured |
|---|---------|-------------------|-----------------|
| 25 | `openai` | `openai` | Chat completions, embeddings, images, audio, model, token usage |
| 26 | `@anthropic-ai/sdk` | `anthropic` | Messages, completions, model, input/output tokens, stop reason |
| 27 | `@google/generative-ai` | `google-genai` | generateContent, chat, embeddings, countTokens, token usage |
| 28 | `@google-cloud/vertexai` | `google-genai` | Vertex AI generateContent, generateContentStream |
| 29 | `@azure/openai` | `azure-openai` | Chat, completions, embeddings, images, audio (v1.x API) |
| 30 | `cohere-ai` | `cohere` | Chat, embed, rerank, classify, summarize, tokenize |
| 31 | `@mistralai/mistralai` | `mistral` | Chat, FIM, embeddings, model, token usage |
| 32 | `ai` (Vercel AI SDK) | `vercel-ai` | generateText/streamText/generateObject/streamObject/embed, all fronted providers, streaming usage |
| 33 | `@langchain/core` | `langchain` | Chat model `invoke` across providers, normalized `usage_metadata` |
| 34 | `groq-sdk` | `groq` | Chat completions, embeddings, audio, streaming token usage |
| 35 | `ollama` | `ollama` | Local chat/generate/embeddings, prompt_eval_count / eval_count |

All AI instrumentations follow [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reason`) **and** feed the first-class AI Monitoring pillar (cost, tokens, latency, traces). Beyond auto-instrumentation, monitor ANY model — including unsupported providers and in-browser models (WebLLM) — with the manual API: `Senzor.ai.trace()`, `Senzor.ai.generation()`, `Senzor.ai.wrapGeneration()`.

### Cloud & Infrastructure

| # | Library | Instrumentation Key | What's Captured |
|---|---------|-------------------|-----------------|
| 32 | `@aws-sdk/*` (AWS SDK v3) | `aws-sdk` | All AWS service calls (S3, DynamoDB, SQS, SNS, Lambda, etc.), request ID, region, HTTP status |
| 33 | AWS Bedrock Runtime | `aws-sdk` | Model invocations with GenAI attributes (tokens, model ID, finish reason) |
| 34 | Firebase Admin (Firestore) | `firebase` | Document CRUD, collection queries, transactions, batch commits |
| 35 | Firebase Admin (Auth) | `firebase` | User management, token verification, session cookies (16 methods) |
| 36 | Firebase Admin (FCM) | `firebase` | Push notification delivery, multicast, topic operations (9 methods) |

### Logging Libraries

| # | Library | Instrumentation Key | What's Captured |
|---|---------|-------------------|-----------------|
| 37 | `pino` | `pino` | Trace/span ID injection into structured log output |
| 38 | `winston` | `winston` | Trace/span ID injection into transport output |
| 39 | `bunyan` | `bunyan` | Trace/span ID injection into log records |

### RPC & Network

| # | Library | Instrumentation Key | What's Captured |
|---|---------|-------------------|-----------------|
| 40 | `@grpc/grpc-js` | `grpc` | Unary/streaming calls, service/method, status codes, metadata propagation |
| 41 | `graphql` | `graphql` | Resolvers, operation name/type, field paths, errors |
| 42 | Node `dns` | `dns` | DNS lookups, resolve calls, hostname, record types |
| 43 | Node `net` | `net` | TCP socket connections, data transfer, connection timing |

### Utilities

| # | Library | Instrumentation Key | What's Captured |
|---|---------|-------------------|-----------------|
| 44 | `dataloader` | `dataloader` | Batch load calls, batch size, cache hits |
| 45 | `lru-memoizer` | `lru-memoizer` | Memoized function calls, cache hit/miss |
| 46 | `generic-pool` | `generic-pool` | Pool acquire/release, pool size, pending count |
| 47 | Node `fs` | `fs` | File system reads, writes, stats, directory operations |

### Runtime Metrics

Collected every 15 seconds (configurable) and sent alongside trace data:

- **Event Loop**: lag (p50, p99, max), utilization (ELU)
- **Garbage Collection**: duration by GC type (minor, major, incremental, weakcb)
- **Memory**: heap used/total, RSS, external, array buffers
- **Active Handles & Requests**: open file descriptors, active network connections

---

## Framework Wrappers

### Express

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

const app = express();
app.use(Senzor.requestHandler());    // First middleware
app.get('/users/:id', handler);
app.use(Senzor.errorHandler());      // Last middleware
app.listen(3000);
```

### Fastify

```ts
import Senzor from '@senzops/apm-node';

fastify.register(Senzor.fastifyPlugin, {
  apiKey: process.env.SENZOR_API_KEY!,
});
```

### NestJS

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(Senzor.requestHandler());
  await app.listen(3000);
}
```

### Next.js (App Router)

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

export const GET = Senzor.wrapNextRoute(async (req) => {
  return Response.json({ ok: true });
});
```

### Next.js (Pages Router)

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

export default Senzor.wrapNextPages(async (req, res) => {
  res.status(200).json({ ok: true });
});
```

### H3 / Nuxt / Nitro

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

export default Senzor.wrapH3(defineEventHandler(async (event) => {
  return { ok: true };
}));
```

### Nitro Plugin (Cloudflare Workers)

```ts
import { Senzor } from '@senzops/apm-node';

export default defineNitroPlugin((nitroApp) => {
  Senzor.init({ apiKey: '<YOUR_APM_KEY>' });
  Senzor.nitroPlugin(nitroApp);
});
```

### Cloudflare Workers

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

export default {
  fetch: Senzor.worker(async (request, env, ctx) => {
    return new Response('OK');
  }),
};
```

### AWS Lambda

Three deployment options, from zero-code to code-level:

#### Option 1: Lambda Extension Layer (Zero Code Changes, Recommended)

Build and publish a Lambda Layer, then reconfigure your function. No changes to your application code.

```sh
# 1. Build the layer
mkdir -p senzor-layer/nodejs && cd senzor-layer/nodejs
npm init -y && npm install @senzops/apm-node
cd .. && zip -r senzor-apm-layer.zip nodejs/

# 2. Publish
aws lambda publish-layer-version \
  --layer-name senzor-apm-node \
  --zip-file fileb://senzor-apm-layer.zip \
  --compatible-runtimes nodejs18.x nodejs20.x nodejs22.x

# 3. Attach to function and configure
aws lambda update-function-configuration \
  --function-name my-function \
  --layers <LAYER_ARN> \
  --handler @senzops/apm-node/dist/lambda-handler.handler \
  --environment Variables="{ \
    SENZOR_API_KEY=sz_apm_xxx, \
    SENZOR_LAMBDA_HANDLER=index.handler, \
    NODE_OPTIONS=--require @senzops/apm-node/register \
  }"
```

The auto-handler wrapper reads `SENZOR_LAMBDA_HANDLER` to load your original handler, wraps it with full APM instrumentation, and re-exports it for Lambda to invoke.

**AWS CDK:**

```ts
const senzorLayer = new lambda.LayerVersion(this, 'SenzorApmLayer', {
  code: lambda.Code.fromAsset(path.join(__dirname, 'senzor-layer')),
  compatibleRuntimes: [lambda.Runtime.NODEJS_18_X, lambda.Runtime.NODEJS_20_X],
  description: 'Senzor APM Lambda Extension Layer',
});

const fn = new lambda.Function(this, 'MyFunction', {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: '@senzops/apm-node/dist/lambda-handler.handler',
  code: lambda.Code.fromAsset('lambda'),
  layers: [senzorLayer],
  environment: {
    SENZOR_API_KEY: 'sz_apm_xxx',
    SENZOR_LAMBDA_HANDLER: 'index.handler',
    NODE_OPTIONS: '--require @senzops/apm-node/register',
  },
});
```

Also works with SAM, Serverless Framework, Terraform, and the AWS Console. See the [wiki](wiki.md#4-aws-lambda-integration) for full examples.

#### Option 2: Code-Level Handler Wrapper

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

export const handler = Senzor.wrapLambda(async (event, context) => {
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
});
```

#### What's Captured

Both approaches provide:
- **Cold start detection** tagged on the first invocation per container
- **Trigger-type detection**: API Gateway v1/v2, ALB, SQS, SNS, DynamoDB Streams, EventBridge, S3, Scheduled events
- **Lambda context extraction**: function name, request ID, memory limit, log group, invoked ARN, region, account ID
- **Forced flush** before each invocation returns (Lambda freezes the process immediately after)
- **Lambda Extensions API** registration for SHUTDOWN lifecycle safety-net flush
- **Auto-optimized settings**: runtime metrics disabled, batch size 10, flush on demand only

---

## Background Task Monitoring

### Auto-Instrumented Tasks

BullMQ workers and node-cron jobs are captured automatically as task runs with queue delay, retry count, dead-letter detection, and CPU/memory resource metrics.

### Manual Task Wrapping

```ts
const processPayment = Senzor.wrapTask(
  'process_payment',
  'custom',
  { metadata: { owner: 'billing' } },
  async (invoiceId: string) => {
    await chargeCustomer(invoiceId);
  }
);

await processPayment('inv_123');
```

---

## Manual Spans

```ts
const span = Senzor.startSpan('calculate_invoice', 'function');
try {
  const total = await calculateInvoice(invoiceId);
  span.end({ invoiceId, total }, 200);
} catch (error) {
  span.end({ invoiceId, error: String(error) }, 500);
  throw error;
}
```

Span types: `http`, `db`, `function`, `custom`, `rpc`, `messaging`, `dns`, `net`.

---

## Error Tracking

Automatic capture of `uncaughtException`, `unhandledRejection`, process warnings, `SIGTERM`, and `SIGINT` with full stack traces, process context, and memory snapshots.

Manual capture:

```ts
Senzor.captureException(error, { userId, operation: 'charge' });
```

---

## Log Correlation

Console logs (`log`, `info`, `warn`, `error`, `debug`) are automatically captured and correlated with the active trace or task context. Structured logging libraries (pino, winston, bunyan) get trace/span IDs injected for correlation.

---

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | **required** | Senzor service API key |
| `endpoint` | `string` | `https://api.senzor.dev` | Ingest endpoint |
| `batchSize` | `number` | `100` | Flush threshold |
| `flushInterval` | `number` | `10000` | Flush interval (ms) |
| `flushTimeoutMs` | `number` | `5000` | Per-request timeout (ms) |
| `maxQueueSize` | `number` | `10000` | Max queued items before drop |
| `maxSpansPerTrace` | `number` | `500` | Max child spans per trace |
| `maxAttributeLength` | `number` | `2048` | Max string length for attributes |
| `maxAttributes` | `number` | `64` | Max attributes per object |
| `captureHeaders` | `boolean` | `false` | Capture sanitized request headers |
| `captureDbStatement` | `boolean` | `true` | Capture sanitized SQL in spans |
| `instrumentations` | `boolean \| string[]` | `true` | Enable/disable specific instrumentations |
| `frameworkSpans` | `boolean` | `true` | Capture framework middleware/router spans |
| `captureMiddlewareSpans` | `boolean` | `true` | Capture middleware execution spans |
| `captureRouterSpans` | `boolean` | `true` | Capture router dispatch spans |
| `captureLifecycleHookSpans` | `boolean` | `true` | Capture framework lifecycle hook spans |
| `autoLogs` | `boolean` | `true` | Capture and correlate console logs |
| `runtimeMetrics` | `boolean` | `true` | Collect runtime metrics (event loop, GC, heap) |
| `runtimeMetricsInterval` | `number` | `15000` | Runtime metrics collection interval (ms) |
| `debug` | `boolean` | `false` | Print SDK diagnostics |

### Selective Instrumentation

```ts
// Enable only specific instrumentations
Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!,
  instrumentations: ['http', 'fetch', 'pg', 'redis', 'openai'],
});

// Disable all auto-instrumentation (manual APIs only)
Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!,
  instrumentations: false,
});
```

All instrumentation key names:

```
http, fetch, undici, express, fastify, koa, nestjs, hapi, restify, connect,
pg, mongo, mongoose, mysql, redis, knex, tedious, cassandra, memcached,
kafka, amqplib, socketio, bullmq, cron,
openai, anthropic, google-genai, azure-openai, cohere, mistral,
aws-sdk, firebase,
pino, winston, bunyan,
grpc, graphql, dns, net,
dataloader, lru-memoizer, generic-pool, fs
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SENZOR_API_KEY` | Service API key |
| `SENZOR_ENDPOINT` | Ingest endpoint |
| `SENZOR_DEBUG` | `true` / `1` to enable diagnostics |
| `SENZOR_AUTO_LOGS` | `false` to disable log capture |
| `SENZOR_BATCH_SIZE` | Batch size |
| `SENZOR_FLUSH_INTERVAL` | Flush interval (ms) |
| `SENZOR_FLUSH_TIMEOUT_MS` | Flush timeout (ms) |
| `SENZOR_MAX_QUEUE_SIZE` | Max queued items |
| `SENZOR_MAX_SPANS_PER_TRACE` | Max spans per trace |
| `SENZOR_CAPTURE_HEADERS` | `true` to capture headers |
| `SENZOR_CAPTURE_DB_STATEMENT` | `false` for restrictive SQL |
| `SENZOR_FRAMEWORK_SPANS` | `false` to disable framework spans |
| `SENZOR_CAPTURE_MIDDLEWARE_SPANS` | `false` to disable middleware spans |
| `SENZOR_CAPTURE_ROUTER_SPANS` | `false` to disable router spans |
| `SENZOR_CAPTURE_LIFECYCLE_HOOK_SPANS` | `false` to disable lifecycle spans |
| `SENZOR_RUNTIME_METRICS` | `false` to disable runtime metrics |
| `SENZOR_RUNTIME_METRICS_INTERVAL` | Collection interval (ms) |

Alternative API key variables: `SENZOR_APM_API_KEY`, `SENZOR_SERVICE_API_KEY`.
Alternative endpoint variables: `SENZOR_APM_ENDPOINT`.

---

## Distributed Tracing

The SDK automatically propagates trace context on outgoing HTTP calls:

```
traceparent: 00-{traceId}-{spanId}-01
x-senzor-trace-id: {traceId}
x-senzor-parent-span-id: {spanId}
```

Incoming `traceparent` headers are parsed to link upstream traces.

---

## Security Defaults

Sensitive fields are automatically redacted from attributes, headers, logs, and error context:

`authorization`, `cookie`, `set-cookie`, `password`, `secret`, `token`, `apiKey`, `x-api-key`, `accessToken`, `refreshToken`, `clientSecret`, `privateKey`

Header capture is disabled by default. SQL statements are normalized to strip literal values.

---

## Public API Reference

```ts
Senzor.init(options)                    // Initialize SDK
Senzor.preload(options)                 // Preload instrumentation hooks
Senzor.flush()                          // Force flush queued telemetry
Senzor.track(data)                      // Send a manual trace
Senzor.startSpan(name, type)            // Start a manual span
Senzor.captureException(error, ctx)     // Capture an error

Senzor.wrapTask(name, type, opts, fn)   // Wrap a function as a task
Senzor.startTask(name, type, opts, fn)  // Start a task context

Senzor.requestHandler()                 // Express request middleware
Senzor.errorHandler()                   // Express error middleware
Senzor.fastifyPlugin                    // Fastify plugin
Senzor.wrapNextRoute(handler)           // Next.js App Router wrapper
Senzor.wrapNextPages(handler)           // Next.js Pages Router wrapper
Senzor.wrapH3(handler)                  // H3/Nuxt/Nitro wrapper
Senzor.nitroPlugin                      // Nitro plugin (Cloudflare Workers)
Senzor.worker(handler)                  // Cloudflare Workers wrapper
Senzor.wrapLambda(handler)              // AWS Lambda wrapper
```

---

## Requirements

- Node.js >= 18.0.0 (or Bun >= 1.0.0)
- A Senzor service API key
- Network access to the Senzor ingest endpoint

## License

MIT
