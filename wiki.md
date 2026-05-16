# Senzor Node APM SDK Wiki

This wiki contains detailed integration and operational guidance for `@senzops/apm-node`.

The package is the native Senzor SDK for Node.js API services. It captures traces, spans, errors, logs, and task runs without requiring OpenTelemetry in the application.

## 1. Recommended Startup Patterns

### 1.1 Production Preload Mode

Preload mode gives the SDK the best chance to capture all supported libraries because instrumentation is installed before the application imports framework, database, queue, and HTTP client modules.

CommonJS:

```sh
SENZOR_API_KEY=sz_apm_your_key_here node -r @senzops/apm-node/register server.js
```

ESM:

```sh
SENZOR_API_KEY=sz_apm_your_key_here node --import @senzops/apm-node/register server.mjs
```

Docker:

```dockerfile
ENV SENZOR_API_KEY=sz_apm_your_key_here
CMD ["node", "-r", "@senzops/apm-node/register", "dist/server.js"]
```

PM2:

```json
{
  "apps": [
    {
      "name": "orders-api",
      "script": "dist/server.js",
      "node_args": "-r @senzops/apm-node/register",
      "env": {
        "SENZOR_API_KEY": "sz_apm_your_key_here",
        "NODE_ENV": "production"
      }
    }
  ]
}
```

### 1.2 Programmatic Mode

Programmatic mode is useful when your hosting platform does not support preload flags.

Place `Senzor.init()` at the top of the entrypoint, before importing application modules when possible.

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!,
  endpoint: process.env.SENZOR_ENDPOINT,
  batchSize: 100,
  flushInterval: 10000,
  maxSpansPerTrace: 500
});

import './server';
```

## 2. Configuration Reference

```ts
Senzor.init({
  apiKey: 'sz_apm_your_key_here',
  endpoint: 'https://api.senzor.dev',
  batchSize: 100,
  flushInterval: 10000,
  flushTimeoutMs: 5000,
  maxQueueSize: 10000,
  maxSpansPerTrace: 500,
  maxAttributeLength: 2048,
  maxAttributes: 64,
  captureHeaders: false,
  captureDbStatement: true,
  frameworkSpans: true,
  captureMiddlewareSpans: true,
  captureRouterSpans: true,
  captureLifecycleHookSpans: true,
  autoLogs: true,
  debug: false
});
```

| Option | Production recommendation |
| --- | --- |
| `apiKey` | Always pass through environment or secret manager. Do not hardcode. |
| `endpoint` | Use `https://api.senzor.dev` unless your Senzor tenant provides a custom ingest URL. |
| `batchSize` | Start with `100`. Increase for very high-throughput APIs if network overhead matters. |
| `flushInterval` | Start with `10000` ms. Lower for short-lived processes. |
| `flushTimeoutMs` | Keep between `3000` and `10000` ms for API services. |
| `maxQueueSize` | Keep bounded. Increase only after checking memory pressure. |
| `maxSpansPerTrace` | Keep `500` unless traces are expected to fan out heavily. |
| `captureHeaders` | Keep `false` unless sanitized headers are required for debugging. |
| `captureDbStatement` | Keep enabled only if SQL normalization is acceptable for your data policy. |
| `autoLogs` | Keep enabled if correlated logs are wanted. Disable if another log pipeline already owns logs. |
| `debug` | Use only during troubleshooting. |

Enable only selected instrumentation:

```ts
Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!,
  instrumentations: ['http', 'fetch', 'pg', 'redis']
});
```

Disable auto-instrumentation while keeping manual APIs:

```ts
Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!,
  instrumentations: false
});
```

## 3. Environment Variables

The preload entrypoint supports these variables:

```sh
SENZOR_API_KEY=sz_apm_your_key_here
SENZOR_ENDPOINT=https://api.senzor.dev
SENZOR_BATCH_SIZE=100
SENZOR_FLUSH_INTERVAL=10000
SENZOR_FLUSH_TIMEOUT_MS=5000
SENZOR_MAX_QUEUE_SIZE=10000
SENZOR_MAX_SPANS_PER_TRACE=500
SENZOR_CAPTURE_HEADERS=false
SENZOR_CAPTURE_DB_STATEMENT=true
SENZOR_FRAMEWORK_SPANS=true
SENZOR_CAPTURE_MIDDLEWARE_SPANS=true
SENZOR_CAPTURE_ROUTER_SPANS=true
SENZOR_CAPTURE_LIFECYCLE_HOOK_SPANS=true
SENZOR_AUTO_LOGS=true
SENZOR_DEBUG=false
```

Accepted API key variables:

- `SENZOR_API_KEY`
- `SENZOR_APM_API_KEY`
- `SENZOR_SERVICE_API_KEY`

Accepted endpoint variables:

- `SENZOR_ENDPOINT`
- `SENZOR_APM_ENDPOINT`

## 4. Framework Integrations

### 4.1 Express and NestJS

Preload mode automatically captures inbound HTTP requests. For better Express route names and error capture, add the Senzor middleware.

```ts
import express from 'express';
import Senzor from '@senzops/apm-node';

Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!
});

const app = express();

app.use(Senzor.requestHandler());

app.get('/orders/:orderId', async (req, res) => {
  res.json({ orderId: req.params.orderId });
});

app.use(Senzor.errorHandler());

app.listen(3000);
```

For NestJS on Express:

```ts
import Senzor from '@senzops/apm-node';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(Senzor.requestHandler());
  await app.listen(3000);
}

bootstrap();
```

### 4.2 Fastify

```ts
import Fastify from 'fastify';
import Senzor from '@senzops/apm-node';

const fastify = Fastify();

fastify.register(Senzor.fastifyPlugin, {
  apiKey: process.env.SENZOR_API_KEY!
});

fastify.get('/orders/:orderId', async (request) => {
  return { orderId: request.params.orderId };
});

await fastify.listen({ port: 3000 });
```

### 4.3 Next.js App Router

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!
});

export const GET = Senzor.wrapNextRoute(async (request: Request) => {
  const url = new URL(request.url);
  return Response.json({ path: url.pathname });
});
```

### 4.4 Next.js Pages Router

```ts
import type { NextApiRequest, NextApiResponse } from 'next';
import Senzor from '@senzops/apm-node';

Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!
});

export default Senzor.wrapNextPages(
  async function handler(req: NextApiRequest, res: NextApiResponse) {
    res.status(200).json({ ok: true });
  }
);
```

For serverless functions:

```ts
await Senzor.flush();
```

### 4.5 H3, Nuxt, Nitro

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!
});

export default Senzor.wrapH3(
  defineEventHandler(async (event) => {
    return { ok: true };
  })
);
```

### 4.6 Vanilla Node HTTP

```ts
import http from 'http';
import Senzor from '@senzops/apm-node';

Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!
});

const server = http.createServer(async (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

server.listen(3000);
```

With preload mode, no manual request wrapper is required.

## 5. Database and Cache Instrumentation

### 5.1 PostgreSQL

Supported package: `pg`.

```ts
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const result = await pool.query(
  'SELECT id, email FROM users WHERE id = $1',
  [userId]
);
```

Captured span example:

```json
{
  "name": "Postgres SELECT",
  "type": "db",
  "meta": {
    "operation": "SELECT",
    "db.system.name": "postgresql",
    "db.operation.name": "SELECT",
    "db.query.text": "SELECT id, email FROM users WHERE id = $?",
    "rowCount": 1,
    "library": "pg"
  }
}
```

### 5.2 MongoDB

Supported package: `mongodb`.

```ts
const user = await db.collection('users').findOne({ _id: userId });
const orders = await db.collection('orders').find({ userId }).toArray();
```

Captured operations include common collection operations and cursor execution:

- `findOne`
- `find`
- `aggregate`
- `insertOne`
- `insertMany`
- `updateOne`
- `updateMany`
- `deleteOne`
- `deleteMany`
- `bulkWrite`
- `countDocuments`

### 5.3 Mongoose

Supported package: `mongoose`.

```ts
const user = await User.findById(userId).exec();
await user.save();
```

Captured metadata includes model name, collection name, operation, and driver family.

### 5.4 MySQL and MySQL2

Supported packages:

- `mysql`
- `mysql2`

```ts
const [rows] = await connection.execute(
  'SELECT id, email FROM users WHERE id = ?',
  [userId]
);
```

Captured metadata includes SQL operation, sanitized statement, row count when available, and package name.

### 5.5 Redis and ioredis

Supported packages:

- `redis`
- `ioredis`

```ts
await redis.get(`user:${userId}`);
await redis.set(`user:${userId}`, JSON.stringify(user));
```

Captured span names follow the command name:

- `Redis GET`
- `Redis SET`
- `Redis HGETALL`
- `Redis DEL`

## 6. HTTP Client Instrumentation

The SDK propagates distributed tracing headers on outgoing calls:

```txt
traceparent: 00-f3b2c2c9c70443f5a4b7f0ff6d5b9a17-9d8a4d5f17e24d2a-01
x-senzor-trace-id: f3b2c2c9c70443f5a4b7f0ff6d5b9a17
x-senzor-parent-span-id: 9d8a4d5f17e24d2a
```

Supported clients:

- Node `http.request`
- Node `https.request`
- Node `http.get`
- Node `https.get`
- Global `fetch`
- `undici`

Example:

```ts
const response = await fetch('https://inventory.internal/items/sku_123');
const data = await response.json();
```

Captured span example:

```json
{
  "name": "GET inventory.internal",
  "type": "http",
  "status": 200,
  "meta": {
    "method": "GET",
    "library": "fetch",
    "http.request.method": "GET",
    "url.path": "/items/sku_123",
    "server.address": "inventory.internal"
  }
}
```

## 7. Logs and Errors

### 7.1 Correlated Console Logs

```ts
console.info('order accepted', {
  orderId: 'ord_123',
  customerId: 'cus_456'
});
```

Captured log example:

```json
{
  "message": "order accepted",
  "level": "info",
  "traceId": "f3b2c2c9c70443f5a4b7f0ff6d5b9a17",
  "attributes": {
    "orderId": "ord_123",
    "customerId": "cus_456"
  },
  "timestamp": "2026-05-16T15:30:00.000Z"
}
```

Disable console log capture:

```ts
Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!,
  autoLogs: false
});
```

### 7.2 Manual Error Capture

```ts
try {
  await chargeCustomer(customerId);
} catch (error) {
  Senzor.captureException(error, {
    customerId,
    operation: 'charge_customer'
  });
  throw error;
}
```

Captured error example:

```json
{
  "errorClass": "Error",
  "message": "Card declined",
  "traceId": "f3b2c2c9c70443f5a4b7f0ff6d5b9a17",
  "context": {
    "customerId": "cus_456",
    "operation": "charge_customer"
  },
  "timestamp": "2026-05-16T15:30:00.000Z"
}
```

Global handlers capture:

- `uncaughtExceptionMonitor`
- `uncaughtException`
- `unhandledRejection`
- `warning`
- `multipleResolves`
- `SIGTERM`
- `SIGINT`

## 8. Background Tasks

### 8.1 Manual Task Wrapping

```ts
const rebuildSearchIndex = Senzor.wrapTask(
  'rebuild_search_index',
  'custom',
  {
    metadata: {
      owner: 'search',
      schedule: 'manual'
    }
  },
  async () => {
    await rebuildIndex();
  }
);

await rebuildSearchIndex();
```

### 8.2 BullMQ

When `bullmq` is installed and auto-instrumentation is enabled, worker jobs are captured as task runs.

```ts
import { Worker } from 'bullmq';

new Worker('billing', async (job) => {
  await sendInvoice(job.data.invoiceId);
});
```

Captured task fields include:

- `taskName`
- `taskType`
- `queueDelay`
- `attempts`
- `isDeadLetter`
- `metadata.jobId`
- `metadata.queueName`
- `resourceMetrics`

### 8.3 node-cron

```ts
import cron from 'node-cron';

cron.schedule(
  '*/5 * * * *',
  async () => {
    await syncReports();
  },
  {
    name: 'sync_reports'
  }
);
```

The SDK wraps scheduled handlers and sends each execution as a task run.

## 9. Manual Traces and Spans

### 9.1 Manual Trace

Use `track()` when the runtime cannot use framework wrappers and you already have timing data.

```ts
Senzor.track({
  method: 'POST',
  route: '/webhooks/payment',
  path: '/webhooks/payment',
  status: 202,
  duration: 18.7,
  spans: []
});
```

### 9.2 Manual Span

```ts
const span = Senzor.startSpan('reserve_inventory', 'function');

try {
  await reserveInventory(orderId);
  span.end({ orderId }, 200);
} catch (error) {
  span.end({ orderId, error: String(error) }, 500);
  throw error;
}
```

Span types:

- `http`
- `db`
- `function`
- `custom`

## 10. Payload Format

### 10.1 APM Ingest

Endpoint:

```txt
POST /api/ingest/apm
```

Payload:

```json
{
  "traces": [
    {
      "traceId": "f3b2c2c9c70443f5a4b7f0ff6d5b9a17",
      "parentTraceId": "8cb1f2e2f43e4b2b8b3411c7df81e7e0",
      "parentSpanId": "6c62c908a21d4f49",
      "method": "GET",
      "route": "/orders/:orderId",
      "path": "/orders/ord_123?include=items",
      "status": 200,
      "duration": 53.29,
      "ip": "203.0.113.10",
      "userAgent": "Mozilla/5.0",
      "timestamp": "2026-05-16T15:30:00.000Z",
      "spans": [
        {
          "spanId": "9d8a4d5f17e24d2a",
          "parentSpanId": "91f6c551d5a2403f",
          "name": "GET inventory.internal",
          "type": "http",
          "startTime": 5.41,
          "duration": 22.16,
          "status": 200,
          "meta": {
            "method": "GET",
            "library": "fetch",
            "http.request.method": "GET",
            "server.address": "inventory.internal"
          }
        }
      ]
    }
  ],
  "errors": [],
  "logs": []
}
```

### 10.2 Task Ingest

Endpoint:

```txt
POST /api/ingest/task
```

Payload:

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
      "triggerTraceId": "f3b2c2c9c70443f5a4b7f0ff6d5b9a17",
      "metadata": {
        "jobId": "142",
        "queueName": "billing"
      },
      "resourceMetrics": {
        "memoryDeltaBytes": 1048576,
        "cpuUserUs": 12000,
        "cpuSystemUs": 3000
      },
      "isDeadLetter": false,
      "spans": [],
      "timestamp": "2026-05-16T15:30:00.000Z"
    }
  ],
  "errors": [],
  "logs": []
}
```

## 11. Security, Privacy, and Cardinality

The SDK is conservative by default.

Sensitive keys are redacted from attributes, headers, logs, and error context:

- `authorization`
- `cookie`
- `set-cookie`
- `password`
- `passwd`
- `pwd`
- `secret`
- `token`
- `api-key`
- `x-api-key`
- `access-token`
- `refresh-token`
- `client-secret`
- `private-key`

Cardinality controls:

- URL routes are normalized, for example `/users/123` becomes `/users/:id`.
- UUID-like IDs and Mongo ObjectIds are normalized in routes.
- Attribute count and string length are bounded.
- Span count per trace is bounded.
- Queue size is bounded.

Production recommendations:

- Keep `captureHeaders` disabled unless required.
- Never capture request bodies by default.
- Avoid putting raw customer data into span names.
- Use route templates and IDs in metadata, not in operation names.

## 12. Transport Behavior

The SDK batches telemetry and sends it asynchronously.

Behavior:

- Queues are bounded with `maxQueueSize`.
- Flush occurs on `batchSize` or `flushInterval`.
- Ingest calls have a timeout with `flushTimeoutMs`.
- Failed batches are requeued within queue limits.
- SDK ingest requests are marked as internal so they are not traced recursively.
- A best-effort flush runs during `beforeExit`.

Serverless recommendation:

```ts
await Senzor.flush();
```

Call this after the response is prepared but before the function exits when deterministic delivery matters.

## 13. Troubleshooting

### Missing spans

Check the startup order first. Preload mode should be used when possible:

```sh
node -r @senzops/apm-node/register server.js
```

If programmatic mode is used, initialize before importing `pg`, `mongodb`, `redis`, framework modules, or HTTP clients.

### Duplicate traces

The SDK deduplicates active traces in common cases. If duplicates still appear, check whether the app is using both native preload mode and custom manual `track()` calls for the same request.

### No data in Senzor

Verify:

- `SENZOR_API_KEY` is present.
- `endpoint` points to the expected Senzor environment.
- The runtime can reach the ingest endpoint.
- `Senzor.flush()` is called in short-lived runtimes.
- `debug: true` shows flush attempts.

### High memory usage

Tune:

```ts
Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!,
  maxQueueSize: 5000,
  maxSpansPerTrace: 250,
  maxAttributes: 32,
  maxAttributeLength: 1024
});
```

### High-cardinality routes

Use framework wrappers where possible so route templates are available:

```ts
app.use(Senzor.requestHandler());
```

For manual traces, pass normalized routes:

```ts
Senzor.track({
  method: 'GET',
  route: '/users/:id',
  path: '/users/123',
  status: 200,
  duration: 12.4
});
```

## 14. Build and Publish

Build the package:

```sh
npm run build
```

The build produces:

- CommonJS: `dist/index.js`
- ESM: `dist/index.mjs`
- Browser/global bundle: `dist/index.global.js`
- Preload entrypoint: `dist/register.js` and `dist/register.mjs`
- Type declarations: `dist/index.d.ts`, `dist/register.d.ts`

Before publishing, verify:

```sh
npx tsc --noEmit
npm run build
```
