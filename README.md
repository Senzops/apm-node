# @senzops/apm-node

Official Node.js SDK for Senzor APM.

`@senzops/apm-node` captures application traces, spans, errors, logs, and task runs from Node.js API services and sends them to Senzor using the Senzor ingestion format. It is designed to be used directly instead of OpenTelemetry in Senzor-instrumented Node services.

The SDK has two supported modes:

- Production auto-instrumentation through a preload entrypoint.
- Explicit framework wrappers and manual APIs for environments where preload is not available.

## Installation

```sh
npm install @senzops/apm-node
```

```sh
yarn add @senzops/apm-node
```

```sh
pnpm add @senzops/apm-node
```

## Requirements

- Node.js `18.0.0` or newer.
- A Senzor service API key.
- Network access from the application runtime to the Senzor ingest endpoint.

## Recommended Production Setup

Use preload mode so Senzor can patch Node and common libraries before your application imports them.

```sh
SENZOR_API_KEY=sz_apm_your_key_here node -r @senzops/apm-node/register server.js
```

For ESM applications:

```sh
SENZOR_API_KEY=sz_apm_your_key_here node --import @senzops/apm-node/register server.mjs
```

With preload enabled, the SDK can automatically capture inbound HTTP requests for common Node frameworks because it instruments the underlying `http` and `https` server lifecycle.

## Programmatic Setup

If preload mode is not possible, initialize Senzor as early as possible in your application entrypoint.

```js
const Senzor = require('@senzops/apm-node').default;

Senzor.init({
  apiKey: 'sz_apm_your_key_here',
  endpoint: 'https://api.senzor.dev',
  batchSize: 100,
  flushInterval: 10000
});
```

For TypeScript or ESM:

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!
});
```

## What Gets Captured

The SDK captures these signals using the Senzor ingestion format:

- APM traces for inbound API requests.
- Child spans for outgoing HTTP calls, database operations, cache calls, and custom work.
- Errors with trace or task context.
- Console logs correlated with the active trace or task.
- Background task runs for queues and scheduled jobs.

Current native auto-instrumentation coverage:

| Area | Libraries and runtimes |
| --- | --- |
| Inbound HTTP | Node `http`, Node `https`, Express, NestJS, Fastify, Koa, H3, Nuxt/Nitro, Restify, Hapi-style services through Node server capture |
| Outbound HTTP | `http`, `https`, `fetch`, `undici` |
| Databases | `pg`, `mongodb`, `mongoose`, `mysql`, `mysql2` |
| Cache | `redis`, `ioredis` |
| Jobs | `bullmq`, `node-cron` |
| Logs | `console.log`, `console.info`, `console.warn`, `console.error`, `console.debug` |
| Errors | `uncaughtException`, `unhandledRejection`, process warnings, manual captured exceptions |

## Express Example

Preload mode is preferred:

```sh
SENZOR_API_KEY=sz_apm_your_key_here node -r @senzops/apm-node/register app.js
```

You can still use the Express middleware to refine route detection and capture Express error objects:

```js
const express = require('express');
const Senzor = require('@senzops/apm-node').default;

Senzor.init({
  apiKey: process.env.SENZOR_API_KEY
});

const app = express();

app.use(Senzor.requestHandler());

app.get('/users/:id', async (req, res) => {
  res.json({ id: req.params.id });
});

app.use(Senzor.errorHandler());

app.listen(3000);
```

## Fastify Example

```ts
import Fastify from 'fastify';
import Senzor from '@senzops/apm-node';

const fastify = Fastify();

fastify.register(Senzor.fastifyPlugin, {
  apiKey: process.env.SENZOR_API_KEY!
});

fastify.get('/health', async () => ({ ok: true }));

await fastify.listen({ port: 3000 });
```

## Next.js Example

App Router:

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!
});

export const GET = Senzor.wrapNextRoute(async () => {
  return Response.json({ ok: true });
});
```

Pages Router:

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!
});

export default Senzor.wrapNextPages(async function handler(req, res) {
  res.status(200).json({ ok: true });
});
```

In serverless runtimes, flush before the function exits when you need deterministic delivery:

```ts
await Senzor.flush();
```

## Manual Spans

Use manual spans for business operations that are not covered by auto-instrumentation.

```ts
const span = Senzor.startSpan('calculate_invoice_total', 'function');

try {
  const total = await calculateInvoiceTotal(invoiceId);
  span.end({ invoiceId, total }, 200);
  return total;
} catch (error) {
  span.end({ invoiceId, error: String(error) }, 500);
  Senzor.captureException(error, { invoiceId });
  throw error;
}
```

## Background Tasks

```ts
const sendInvoiceEmail = Senzor.wrapTask(
  'send_invoice_email',
  'custom',
  { metadata: { owner: 'billing' } },
  async (invoiceId: string) => {
    await sendEmail(invoiceId);
  }
);

await sendInvoiceEmail('inv_123');
```

Auto-instrumented task integrations:

- BullMQ workers.
- node-cron scheduled jobs.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | Required for sending data | Senzor service API key. |
| `endpoint` | `string` | `https://api.senzor.dev/api/ingest/apm` | Senzor ingest endpoint or base URL. |
| `batchSize` | `number` | `100` | Flush when this many queued telemetry items are collected. |
| `flushInterval` | `number` | `10000` | Flush interval in milliseconds. |
| `flushTimeoutMs` | `number` | `5000` | Timeout for a single ingest request. |
| `maxQueueSize` | `number` | `10000` | Maximum queued items per queue before old items are dropped. |
| `maxSpansPerTrace` | `number` | `500` | Maximum child spans retained for a single trace or task. |
| `maxAttributeLength` | `number` | `2048` | Maximum string length for attributes and metadata values. |
| `maxAttributes` | `number` | `64` | Maximum number of attributes retained per object. |
| `captureHeaders` | `boolean` | `false` | Capture sanitized request headers in trace metadata. |
| `captureDbStatement` | `boolean` | SDK sanitizes SQL by default | Controls how much SQL statement text is retained. |
| `instrumentations` | `boolean \| string[]` | `true` | Disable all instrumentation with `false`, or enable only named integrations. |
| `frameworkSpans` | `boolean` | `true` | Capture framework middleware, router, handler, and lifecycle spans. |
| `captureMiddlewareSpans` | `boolean` | `true` | Capture middleware spans for supported frameworks. |
| `captureRouterSpans` | `boolean` | `true` | Capture router/route-dispatch spans. |
| `captureLifecycleHookSpans` | `boolean` | `true` | Capture lifecycle hook spans such as Fastify hooks. |
| `ignoreFrameworkSpanTypes` | `string[]` | `[]` | Skip selected framework span types such as `middleware` or `router`. |
| `autoLogs` | `boolean` | `true` | Capture console logs and correlate them with active traces or tasks. |
| `debug` | `boolean` | `false` | Print SDK diagnostics. |

Named instrumentation values include:

```ts
[
  'http',
  'express',
  'fastify',
  'koa',
  'fetch',
  'undici',
  'mongo',
  'mongoose',
  'pg',
  'mysql',
  'redis',
  'bullmq',
  'cron'
]
```

## Environment Variables

The preload entrypoint reads these environment variables:

| Variable | Description |
| --- | --- |
| `SENZOR_API_KEY` | Service API key. |
| `SENZOR_APM_API_KEY` | Alternative API key variable. |
| `SENZOR_SERVICE_API_KEY` | Alternative API key variable. |
| `SENZOR_ENDPOINT` | Ingest endpoint or base URL. |
| `SENZOR_APM_ENDPOINT` | Alternative endpoint variable. |
| `SENZOR_DEBUG` | Set to `true` or `1` to enable SDK diagnostics. |
| `SENZOR_AUTO_LOGS` | Set to `false` to disable console log capture. |
| `SENZOR_BATCH_SIZE` | Batch size. |
| `SENZOR_FLUSH_INTERVAL` | Flush interval in milliseconds. |
| `SENZOR_FLUSH_TIMEOUT_MS` | Flush timeout in milliseconds. |
| `SENZOR_MAX_QUEUE_SIZE` | Maximum queued telemetry items per queue. |
| `SENZOR_MAX_SPANS_PER_TRACE` | Maximum spans retained per trace. |
| `SENZOR_CAPTURE_HEADERS` | Set to `true` to capture sanitized headers. |
| `SENZOR_CAPTURE_DB_STATEMENT` | Set to `false` for more restrictive SQL metadata. |
| `SENZOR_FRAMEWORK_SPANS` | Set to `false` to disable framework execution spans. |
| `SENZOR_CAPTURE_MIDDLEWARE_SPANS` | Set to `false` to disable middleware spans. |
| `SENZOR_CAPTURE_ROUTER_SPANS` | Set to `false` to disable router spans. |
| `SENZOR_CAPTURE_LIFECYCLE_HOOK_SPANS` | Set to `false` to disable lifecycle hook spans. |

## Ingestion Payload Shape

The SDK sends APM data to `/api/ingest/apm`:

```json
{
  "traces": [
    {
      "traceId": "f3b2c2c9c70443f5a4b7f0ff6d5b9a17",
      "method": "GET",
      "route": "/users/:id",
      "path": "/users/123?include=roles",
      "status": 200,
      "duration": 42.81,
      "ip": "203.0.113.10",
      "userAgent": "Mozilla/5.0",
      "timestamp": "2026-05-16T15:30:00.000Z",
      "spans": [
        {
          "spanId": "9d8a4d5f17e24d2a",
          "parentSpanId": "91f6c551d5a2403f",
          "name": "Postgres SELECT",
          "type": "db",
          "startTime": 4.22,
          "duration": 12.45,
          "status": 0,
          "meta": {
            "operation": "SELECT",
            "db.system.name": "postgresql",
            "db.operation.name": "SELECT"
          }
        }
      ]
    }
  ],
  "errors": [],
  "logs": []
}
```

Task data is sent to `/api/ingest/task`:

```json
{
  "runs": [
    {
      "runId": "3917bd35-b1d6-4e23-a1d2-d969e1a7d6a1",
      "taskName": "billing:send_invoice_email",
      "taskType": "queue",
      "status": "success",
      "duration": 188.3,
      "queueDelay": 92,
      "attempts": 1,
      "resourceMetrics": {
        "memoryDeltaBytes": 1048576,
        "cpuUserUs": 12000,
        "cpuSystemUs": 3000
      },
      "spans": [],
      "timestamp": "2026-05-16T15:30:00.000Z"
    }
  ],
  "errors": [],
  "logs": []
}
```

## Security Defaults

The SDK redacts common sensitive fields from attributes, headers, errors, and logs:

- `authorization`
- `cookie`
- `set-cookie`
- `password`
- `secret`
- `token`
- `apiKey`
- `x-api-key`
- `accessToken`
- `refreshToken`
- `clientSecret`
- `privateKey`

Header capture is disabled by default. SQL metadata is normalized to reduce sensitive values and high-cardinality payloads.

## Production Notes

- Use preload mode whenever possible.
- Initialize the SDK before importing application modules when preload mode is not available.
- Keep `debug` disabled in production unless actively troubleshooting.
- Use `Senzor.flush()` before serverless function exit.
- Keep route names low-cardinality, for example `/users/:id` instead of `/users/123`.
- Do not capture request or response bodies unless your service has a strict data policy and the ingestion backend is prepared for that data.

## Public API

```ts
Senzor.init(options)
Senzor.preload(options)
Senzor.flush()
Senzor.track(data)
Senzor.startSpan(name, type)
Senzor.captureException(error, context)
Senzor.wrapTask(name, type, options, fn)
Senzor.startTask(name, type, options, fn)
Senzor.requestHandler()
Senzor.errorHandler()
Senzor.wrapNextRoute(handler)
Senzor.wrapNextPages(handler)
Senzor.wrapH3(handler)
Senzor.fastifyPlugin
```
