# Senzor Node APM SDK — Complete Guide

Comprehensive integration, configuration, and operational reference for `@senzops/apm-node`.

The SDK captures distributed traces, child spans, errors, logs, background task runs, and runtime metrics from Node.js services and sends them to Senzor. It replaces OpenTelemetry auto-instrumentation with a zero-dependency, Senzor-native alternative.

**43 auto-instrumentations. 8 framework wrappers. Zero runtime dependencies.**

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Startup Modes](#2-startup-modes)
3. [Framework Integration Guide](#3-framework-integration-guide)
4. [AWS Lambda Integration](#4-aws-lambda-integration)
5. [Cloudflare Workers Integration](#5-cloudflare-workers-integration)
6. [Auto-Instrumentation Reference](#6-auto-instrumentation-reference)
7. [AI / LLM SDK Instrumentation](#7-ai--llm-sdk-instrumentation)
8. [Database & Cache Instrumentation](#8-database--cache-instrumentation)
9. [Messaging & Queue Instrumentation](#9-messaging--queue-instrumentation)
10. [Cloud Provider Instrumentation](#10-cloud-provider-instrumentation)
11. [gRPC, GraphQL & Network](#11-grpc-graphql--network)
12. [Log Correlation](#12-log-correlation)
13. [Background Task Monitoring](#13-background-task-monitoring)
14. [Manual Traces & Spans](#14-manual-traces--spans)
15. [Error Tracking](#15-error-tracking)
16. [Runtime Metrics](#16-runtime-metrics)
17. [Distributed Tracing & Context Propagation](#17-distributed-tracing--context-propagation)
18. [Configuration Reference](#18-configuration-reference)
19. [Environment Variables](#19-environment-variables)
20. [Security, Privacy & Cardinality](#20-security-privacy--cardinality)
21. [Transport Behavior](#21-transport-behavior)
22. [Ingestion Payload Format](#22-ingestion-payload-format)
23. [Deployment Patterns](#23-deployment-patterns)
24. [Troubleshooting](#24-troubleshooting)
25. [Public API Reference](#25-public-api-reference)
26. [Build & Publish](#26-build--publish)

---

## 1. Getting Started

### Install

```sh
npm install @senzops/apm-node
```

### Minimal Setup

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });
```

That's it. Once initialized, the SDK automatically instruments all supported libraries that your application imports. No additional configuration or per-library setup is required.

---

## 2. Startup Modes

### 2.1 Preload Mode (Recommended for Production)

Preload mode gives the SDK the best coverage because it installs instrumentation hooks before the application imports any library.

**CommonJS:**

```sh
SENZOR_API_KEY=sz_apm_xxx node -r @senzops/apm-node/register server.js
```

**ESM:**

```sh
SENZOR_API_KEY=sz_apm_xxx node --import @senzops/apm-node/register server.mjs
```

**Docker:**

```dockerfile
ENV SENZOR_API_KEY=sz_apm_xxx
CMD ["node", "-r", "@senzops/apm-node/register", "dist/server.js"]
```

**PM2:**

```json
{
  "apps": [{
    "name": "orders-api",
    "script": "dist/server.js",
    "node_args": "-r @senzops/apm-node/register",
    "env": {
      "SENZOR_API_KEY": "sz_apm_xxx",
      "NODE_ENV": "production"
    }
  }]
}
```

### 2.2 Programmatic Mode

When preload flags are unavailable (some serverless platforms, custom runtimes), initialize at the very top of your entrypoint.

```ts
// init.ts — import this FIRST
import Senzor from '@senzops/apm-node';

Senzor.init({
  apiKey: process.env.SENZOR_API_KEY!,
  endpoint: process.env.SENZOR_ENDPOINT,
  batchSize: 100,
  flushInterval: 10000,
});

// Then import your app
import './server';
```

### 2.3 When to Use Which

| Scenario | Mode |
|----------|------|
| Standard Node.js server (Express, Fastify, Koa, etc.) | Preload |
| Docker, Kubernetes, PM2 | Preload |
| Next.js API routes | Programmatic + wrapper |
| Nuxt / Nitro / H3 | Programmatic + wrapper |
| Cloudflare Workers | Programmatic + wrapper |
| AWS Lambda | Programmatic + `wrapLambda`, or Lambda Layer with preload |
| Serverless without `NODE_OPTIONS` support | Programmatic |

---

## 3. Framework Integration Guide

### 3.1 Express

Preload mode captures inbound HTTP automatically. Add middleware for route detection and error capture:

```ts
import express from 'express';
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

const app = express();

// MUST be the first middleware
app.use(Senzor.requestHandler());

app.get('/users/:id', async (req, res) => {
  res.json({ id: req.params.id });
});

// MUST be the last middleware
app.use(Senzor.errorHandler());

app.listen(3000);
```

### 3.2 Fastify

```ts
import Fastify from 'fastify';
import Senzor from '@senzops/apm-node';

const fastify = Fastify();

fastify.register(Senzor.fastifyPlugin, {
  apiKey: process.env.SENZOR_API_KEY!,
});

fastify.get('/orders/:orderId', async (request) => {
  return { orderId: request.params.orderId };
});

await fastify.listen({ port: 3000 });
```

### 3.3 NestJS

NestJS runs on Express (default) or Fastify. For Express:

```ts
import Senzor from '@senzops/apm-node';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// Initialize BEFORE creating the Nest app
Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(Senzor.requestHandler());
  await app.listen(3000);
}

bootstrap();
```

The NestJS instrumentation auto-captures:
- Controller and method resolution
- Guards, Interceptors, Pipes execution
- Exception filter processing

### 3.4 Koa

```ts
import Koa from 'koa';
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

const app = new Koa();

app.use(async (ctx) => {
  ctx.body = { ok: true };
});

app.listen(3000);
```

With preload mode, Koa middleware stack is automatically instrumented.

### 3.5 Hapi

```ts
import Hapi from '@hapi/hapi';
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

const server = Hapi.server({ port: 3000 });

server.route({
  method: 'GET',
  path: '/users/{id}',
  handler: (request) => ({ id: request.params.id }),
});

await server.start();
```

### 3.6 Restify

```ts
import restify from 'restify';
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

const server = restify.createServer();

server.get('/users/:id', (req, res, next) => {
  res.send({ id: req.params.id });
  next();
});

server.listen(3000);
```

### 3.7 Next.js

**App Router:**

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

export const GET = Senzor.wrapNextRoute(async (request: Request) => {
  return Response.json({ ok: true });
});
```

**Pages Router:**

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

export default Senzor.wrapNextPages(async (req, res) => {
  res.status(200).json({ ok: true });
});
```

### 3.8 H3 / Nuxt / Nitro

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

export default Senzor.wrapH3(defineEventHandler(async (event) => {
  return { ok: true };
}));
```

**Nitro Plugin (for Cloudflare Workers preset):**

```ts
// server/plugins/senzor.ts
import { Senzor } from '@senzops/apm-node';

export default defineNitroPlugin((nitroApp) => {
  Senzor.init({ apiKey: '<YOUR_APM_KEY>' });
  Senzor.nitroPlugin(nitroApp);
});
```

### 3.9 Vanilla Node HTTP Server

```ts
import http from 'http';
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

server.listen(3000);
```

With preload mode, no wrapper is needed — `http.createServer` is automatically instrumented.

---

## 4. AWS Lambda Integration

Three deployment methods, from zero-code to code-level:

| Method | Code Changes | Setup | Coverage |
|--------|-------------|-------|----------|
| **Extension Layer** (recommended) | None | Add layer + set env vars | Full: auto-handler wrapping + all auto-instrumentation |
| **Handler Wrapper** | Modify handler file | `npm install` + code change | Full |
| **Preload Layer** | None | Add layer + `NODE_OPTIONS` | Partial: outgoing calls/DB only, no handler wrapping |

### 4.1 Lambda Extension Layer (Zero Code Changes, Recommended)

The Extension Layer approach works identically to New Relic and Datadog Lambda Layers. You package `@senzops/apm-node` as a Lambda Layer, point the function's handler to Senzor's auto-wrapper, and set `SENZOR_LAMBDA_HANDLER` to your original handler. No code changes.

**How it works:**

1. Lambda invokes `@senzops/apm-node/dist/lambda-handler.handler`
2. The auto-wrapper reads `SENZOR_LAMBDA_HANDLER` (e.g., `index.handler`)
3. It dynamically loads your original handler module from `LAMBDA_TASK_ROOT`
4. It wraps your handler with `wrapLambda()` for full APM coverage
5. It re-exports the wrapped function for Lambda to invoke

**Step 1: Build the Lambda Layer**

```sh
mkdir -p senzor-layer/nodejs
cd senzor-layer/nodejs
npm init -y
npm install @senzops/apm-node
cd ..
zip -r senzor-apm-layer.zip nodejs/
```

**Step 2: Publish the Layer**

```sh
aws lambda publish-layer-version \
  --layer-name senzor-apm-node \
  --zip-file fileb://senzor-apm-layer.zip \
  --compatible-runtimes nodejs18.x nodejs20.x nodejs22.x
```

**Step 3: Configure Your Function**

```sh
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

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `SENZOR_API_KEY` | Yes | Your Senzor APM API key |
| `SENZOR_LAMBDA_HANDLER` | Yes | Original handler path (e.g., `index.handler`, `src/app.myHandler`) |
| `NODE_OPTIONS` | Recommended | `--require @senzops/apm-node/register` for full preload coverage |

The handler path supports nested exports: `SENZOR_LAMBDA_HANDLER=src/handlers.api.get` resolves to `require('src/handlers').api.get`.

### 4.2 Extension Layer with AWS CDK

```ts
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';

// Create the Senzor APM Layer
const senzorLayer = new lambda.LayerVersion(this, 'SenzorApmLayer', {
  code: lambda.Code.fromAsset(path.join(__dirname, 'senzor-layer')),
  compatibleRuntimes: [
    lambda.Runtime.NODEJS_18_X,
    lambda.Runtime.NODEJS_20_X,
    lambda.Runtime.NODEJS_22_X,
  ],
  description: 'Senzor APM Node.js Lambda Extension Layer',
});

// Attach to your Lambda function
const fn = new lambda.Function(this, 'MyFunction', {
  runtime: lambda.Runtime.NODEJS_20_X,
  // Point handler to Senzor's auto-wrapper
  handler: '@senzops/apm-node/dist/lambda-handler.handler',
  code: lambda.Code.fromAsset('lambda'),
  layers: [senzorLayer],
  environment: {
    SENZOR_API_KEY: senzorApiKey.stringValue,
    // Your original handler path
    SENZOR_LAMBDA_HANDLER: 'index.handler',
    NODE_OPTIONS: '--require @senzops/apm-node/register',
  },
});
```

Build the layer directory first:

```sh
mkdir -p senzor-layer/nodejs && cd senzor-layer/nodejs
npm init -y && npm install @senzops/apm-node
```

### 4.3 Extension Layer with AWS SAM

```yaml
# template.yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31

Globals:
  Function:
    Layers:
      - !Ref SenzorApmLayer
    Environment:
      Variables:
        SENZOR_API_KEY: !Ref SenzorApiKey
        NODE_OPTIONS: '--require @senzops/apm-node/register'

Resources:
  SenzorApmLayer:
    Type: AWS::Serverless::LayerVersion
    Properties:
      LayerName: senzor-apm-node
      ContentUri: senzor-layer/
      CompatibleRuntimes:
        - nodejs18.x
        - nodejs20.x
        - nodejs22.x

  MyFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: '@senzops/apm-node/dist/lambda-handler.handler'
      Runtime: nodejs20.x
      CodeUri: src/
      Environment:
        Variables:
          SENZOR_LAMBDA_HANDLER: index.handler
```

### 4.4 Extension Layer with Serverless Framework

```yaml
# serverless.yml
service: my-service

provider:
  name: aws
  runtime: nodejs20.x
  environment:
    SENZOR_API_KEY: ${ssm:/senzor/api-key}
    NODE_OPTIONS: '--require @senzops/apm-node/register'

layers:
  senzorApm:
    path: senzor-layer
    compatibleRuntimes:
      - nodejs18.x
      - nodejs20.x
      - nodejs22.x

functions:
  api:
    handler: '@senzops/apm-node/dist/lambda-handler.handler'
    layers:
      - !Ref SenzorApmLambdaLayer
    environment:
      SENZOR_LAMBDA_HANDLER: src/handlers/api.handler
```

### 4.5 Extension Layer via AWS Console

1. **Create the Layer zip** locally:
   ```sh
   mkdir -p senzor-layer/nodejs && cd senzor-layer/nodejs
   npm init -y && npm install @senzops/apm-node
   cd .. && zip -r senzor-apm-layer.zip nodejs/
   ```

2. **Upload the Layer**: Go to Lambda > Layers > Create layer. Upload `senzor-apm-layer.zip`. Set compatible runtimes to `nodejs18.x`, `nodejs20.x`, `nodejs22.x`.

3. **Attach to your function**: Go to your Lambda function > Layers > Add a layer. Choose "Custom layers" and select `senzor-apm-node`.

4. **Update function configuration**:
   - **Handler**: `@senzops/apm-node/dist/lambda-handler.handler`
   - **Environment variables**:
     - `SENZOR_API_KEY` = your API key
     - `SENZOR_LAMBDA_HANDLER` = your original handler (e.g., `index.handler`)
     - `NODE_OPTIONS` = `--require @senzops/apm-node/register`

### 4.6 Extension Layer with Terraform

```hcl
resource "aws_lambda_layer_version" "senzor_apm" {
  filename            = "senzor-apm-layer.zip"
  layer_name          = "senzor-apm-node"
  compatible_runtimes = ["nodejs18.x", "nodejs20.x", "nodejs22.x"]
  description         = "Senzor APM Node.js Lambda Extension Layer"
}

resource "aws_lambda_function" "api" {
  function_name = "my-function"
  runtime       = "nodejs20.x"
  handler       = "@senzops/apm-node/dist/lambda-handler.handler"
  filename      = "function.zip"
  role          = aws_iam_role.lambda.arn

  layers = [aws_lambda_layer_version.senzor_apm.arn]

  environment {
    variables = {
      SENZOR_API_KEY         = var.senzor_api_key
      SENZOR_LAMBDA_HANDLER  = "index.handler"
      NODE_OPTIONS           = "--require @senzops/apm-node/register"
    }
  }
}
```

### 4.7 Code-Level Handler Wrapper

When you prefer code-level control or cannot use Lambda Layers:

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

export const handler = Senzor.wrapLambda(async (event, context) => {
  // Your Lambda logic
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
});
```

### 4.8 What Gets Captured

Both the Extension Layer and code-level wrapper capture the same telemetry:

**Cold Start Detection:**
The first invocation in each container is tagged with `faas.coldstart: true`. Subsequent warm invocations are tagged `false`.

**Trigger-Type Detection:**
The wrapper inspects the event shape and automatically detects:

| Trigger | Detection |
|---------|-----------|
| API Gateway v1 (REST API) | `event.httpMethod` or `event.requestContext.httpMethod` |
| API Gateway v2 (HTTP API) | `event.requestContext.http.method` |
| Application Load Balancer | `event.requestContext.elb` |
| SQS | `event.Records[0].eventSource === 'aws:sqs'` |
| SNS | `event.Records[0].EventSource === 'aws:sns'` |
| DynamoDB Streams | `event.Records[0].eventSource === 'aws:dynamodb'` |
| S3 | `event.Records[0].eventSource === 'aws:s3'` |
| EventBridge | `event.source` + `event.detail-type` + `event.detail` |
| Scheduled (CloudWatch Events) | `event.source === 'aws.events'` |

For HTTP triggers (API Gateway, ALB), the wrapper extracts method, path, headers, client IP, and status code. For messaging triggers, it extracts queue/topic names, batch sizes, and table names.

**Lambda Context Extraction:**

| Attribute | Source |
|-----------|--------|
| `faas.name` | `context.functionName` |
| `faas.version` | `context.functionVersion` |
| `faas.execution` | `context.awsRequestId` |
| `faas.max_memory` | `context.memoryLimitInMB` |
| `faas.coldstart` | Module-level boolean flag |
| `faas.trigger` | `http`, `pubsub`, `datasource`, `timer`, `other` |
| `cloud.provider` | `aws` |
| `cloud.platform` | `aws_lambda` |
| `cloud.region` | `AWS_REGION` env var |
| `cloud.account.id` | Parsed from invoked ARN |
| `cloud.resource_id` | `context.invokedFunctionArn` |
| `aws.log.group.names` | `context.logGroupName` |

**Forced Flush:**
After every invocation, the wrapper calls `await Senzor.flush()` before returning to the Lambda runtime. Lambda freezes the process immediately after the handler returns.

**Lambda Extensions API:**
The wrapper registers as an internal Lambda extension to receive `SHUTDOWN` lifecycle events. This provides a safety-net flush when the execution environment is being terminated.

### 4.9 Lambda Auto-Detection

When running inside Lambda (detected via `AWS_LAMBDA_FUNCTION_NAME` env var), the SDK automatically optimizes settings:

| Setting | Default | Lambda Override |
|---------|---------|-----------------|
| `runtimeMetrics` | `true` | `false` (meaningless per-invocation) |
| `batchSize` | `100` | `10` (short-lived invocations) |
| `flushInterval` | `10000` | `0` (flush on demand only) |

---

## 5. Cloudflare Workers Integration

### 5.1 Direct Worker

```ts
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: '<YOUR_APM_KEY>' });

export default {
  fetch: Senzor.worker(async (request, env, ctx) => {
    const url = new URL(request.url);
    return new Response(JSON.stringify({ path: url.pathname }), {
      headers: { 'content-type': 'application/json' },
    });
  }),
};
```

The worker wrapper automatically:
- Starts a trace with method, path, headers, and client IP
- Captures response status code
- Uses `ctx.waitUntil()` for non-blocking flush when available
- Falls back to `await flush()` otherwise

### 5.2 Nitro + Cloudflare Workers

```ts
// server/plugins/senzor.ts
import { Senzor } from '@senzops/apm-node';

export default defineNitroPlugin((nitroApp) => {
  Senzor.init({ apiKey: '<YOUR_APM_KEY>' });
  Senzor.nitroPlugin(nitroApp);
});
```

---

## 6. Auto-Instrumentation Reference

Complete table of all 43+ auto-instrumentations. All activate automatically when the library is present in `node_modules` and imported by your application.

### Web Frameworks & HTTP (10)

| Instrumentation Key | npm Package(s) | Captured Signals |
|---------------------|----------------|------------------|
| `http` | Node built-in `http`/`https` | Inbound requests, outbound calls, status codes, timing |
| `fetch` | Global `fetch` | Outbound HTTP, W3C Traceparent propagation |
| `undici` | `undici` | Outbound HTTP via Node's native client |
| `express` | `express` | Route matching, middleware chain, error capture |
| `fastify` | `fastify` | Route matching, hooks, lifecycle spans |
| `koa` | `koa` | Middleware stack, route detection |
| `nestjs` | `@nestjs/core` | Controllers, Guards, Interceptors, Pipes |
| `hapi` | `@hapi/hapi` | Route handling, request lifecycle |
| `restify` | `restify` | Route matching, handler chain |
| `connect` | `connect` | Middleware stack |

### Databases & Cache (9)

| Instrumentation Key | npm Package(s) | Captured Signals |
|---------------------|----------------|------------------|
| `pg` | `pg` | Queries, prepared statements, row counts, sanitized SQL |
| `mongo` | `mongodb` | find, insert, update, delete, aggregate, bulkWrite, cursor |
| `mongoose` | `mongoose` | Model operations, model/collection names |
| `mysql` | `mysql`, `mysql2` | Queries, sanitized SQL, row counts |
| `redis` | `redis`, `ioredis` | All commands (GET, SET, HGETALL, DEL, etc.) |
| `knex` | `knex` | Query builder, raw queries, transactions, streaming |
| `tedious` | `tedious` | T-SQL queries, stored procedures, row counts, batch SQL |
| `cassandra` | `cassandra-driver` | CQL queries, batch operations, prepared statements, consistency |
| `memcached` | `memcached` | get, set, gets, cas, append, prepend, incr, decr, del, flush |

### Messaging & Queues (5)

| Instrumentation Key | npm Package(s) | Captured Signals |
|---------------------|----------------|------------------|
| `kafka` | `kafkajs` | Producer send, consumer processing, topic, partition, offset |
| `amqplib` | `amqplib` | Publish, consume, ack/nack, queue, exchange, routing key |
| `socketio` | `socket.io` | Event emit/receive, namespace, room, acknowledgements |
| `bullmq` | `bullmq` | Worker jobs as task runs, queue delay, retries, dead-letter |
| `cron` | `node-cron` | Scheduled jobs as task runs, schedule expression |

### AI / LLM SDKs (7)

| Instrumentation Key | npm Package(s) | Captured Signals |
|---------------------|----------------|------------------|
| `openai` | `openai` | Chat completions, embeddings, images, audio, assistants, token usage |
| `anthropic` | `@anthropic-ai/sdk` | Messages, completions, model, input/output tokens, stop reason |
| `google-genai` | `@google/generative-ai`, `@google-cloud/vertexai` | generateContent, chat, embeddings, countTokens, token usage |
| `azure-openai` | `@azure/openai` | Chat, completions, embeddings, images, audio (v1.x) |
| `cohere` | `cohere-ai` | Chat, generate, embed, rerank, classify, summarize, tokenize |
| `mistral` | `@mistralai/mistralai` | Chat, FIM, embeddings, model, token usage |
| `aws-sdk` (Bedrock) | `@aws-sdk/client-bedrock-runtime` | InvokeModel, Converse, token usage, model ID, finish reason |

### Cloud & Infrastructure (3)

| Instrumentation Key | npm Package(s) | Captured Signals |
|---------------------|----------------|------------------|
| `aws-sdk` | `@aws-sdk/*`, `@smithy/smithy-client` | All AWS service calls: S3, DynamoDB, SQS, SNS, Lambda, SES, etc. |
| `firebase` | `firebase-admin`, `@google-cloud/firestore` | Firestore CRUD/queries, Auth (16 methods), FCM Messaging (9 methods) |
| `generic-pool` | `generic-pool` | Pool acquire/release, pool size, pending count, queue size |

### Logging (3)

| Instrumentation Key | npm Package(s) | Captured Signals |
|---------------------|----------------|------------------|
| `pino` | `pino` | Trace/span ID injection into log records |
| `winston` | `winston` | Trace/span ID injection into transport output |
| `bunyan` | `bunyan` | Trace/span ID injection into serialized records |

### RPC & Network (4)

| Instrumentation Key | npm Package(s) | Captured Signals |
|---------------------|----------------|------------------|
| `grpc` | `@grpc/grpc-js` | Unary/streaming calls, service/method, status codes, metadata |
| `graphql` | `graphql` | Resolver execution, operation name/type, field paths, errors |
| `dns` | Node built-in `dns` | Lookups, resolve, hostname, record types, timing |
| `net` | Node built-in `net` | TCP socket connect, data transfer, connection duration |

### Utilities (3)

| Instrumentation Key | npm Package(s) | Captured Signals |
|---------------------|----------------|------------------|
| `dataloader` | `dataloader` | Batch load calls, batch size, individual key loads |
| `lru-memoizer` | `lru-memoizer` | Memoized function calls, cache hit/miss |
| `fs` | Node built-in `fs` | readFile, writeFile, stat, readdir, mkdir, unlink, rename, etc. |

---

## 7. AI / LLM SDK Instrumentation

All AI SDK instrumentations follow [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).

### Common Attributes Captured

| Attribute | Description |
|-----------|-------------|
| `gen_ai.system` | `openai`, `anthropic`, `google_ai`, `vertex_ai`, `azure_openai`, `cohere`, `mistral`, `aws_bedrock` |
| `gen_ai.request.model` | Model name from request (e.g., `gpt-4o`, `claude-sonnet-4-20250514`, `gemini-1.5-pro`) |
| `gen_ai.response.model` | Actual model from response (may differ for aliases) |
| `gen_ai.operation.name` | `chat`, `embeddings`, `images`, `audio`, `fim`, `rerank`, `classify` |
| `gen_ai.usage.input_tokens` | Prompt/input token count |
| `gen_ai.usage.output_tokens` | Completion/output token count |
| `gen_ai.usage.total_tokens` | Total tokens (when available) |
| `gen_ai.response.finish_reason` | `stop`, `length`, `tool_calls`, `end_turn`, etc. |

### OpenAI

```ts
import OpenAI from 'openai';

const openai = new OpenAI();
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
});
// Span: "OpenAI chat gpt-4o" with token usage
```

### Anthropic

```ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();
const message = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
});
// Span: "Anthropic messages claude-sonnet-4-20250514" with input/output tokens
```

### Google Gemini

```ts
import { GoogleGenerativeAI } from '@google/generative-ai';

const genai = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
const model = genai.getGenerativeModel({ model: 'gemini-1.5-pro' });
const result = await model.generateContent('Hello');
// Span: "Gemini generateContent gemini-1.5-pro" with token usage
```

### Cohere

```ts
import { CohereClient } from 'cohere-ai';

const cohere = new CohereClient({ token: process.env.COHERE_API_KEY! });
const response = await cohere.chat({ model: 'command-r-plus', message: 'Hello' });
// Span: "Cohere chat command-r-plus" with billed units
```

### Mistral

```ts
import { Mistral } from '@mistralai/mistralai';

const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY! });
const response = await mistral.chat.complete({
  model: 'mistral-large-latest',
  messages: [{ role: 'user', content: 'Hello' }],
});
// Span: "Mistral chat mistral-large-latest" with token usage
```

### AWS Bedrock

AWS Bedrock calls made through `@aws-sdk/client-bedrock-runtime` are automatically captured with GenAI attributes via the AWS SDK instrumentation. Both InvokeModel and Converse APIs are supported.

```ts
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient({ region: 'us-east-1' });
const response = await client.send(new InvokeModelCommand({
  modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
  body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
}));
// Span: "AWS BedrockRuntime InvokeModel" with gen_ai.* attributes and token usage
```

### Azure OpenAI (v1.x)

```ts
import { OpenAIClient, AzureKeyCredential } from '@azure/openai';

const client = new OpenAIClient(endpoint, new AzureKeyCredential(key));
const response = await client.getChatCompletions('gpt-4-deployment', messages);
// Span: "Azure OpenAI chat gpt-4-deployment" with token usage
```

Note: Azure OpenAI SDK v2+ wraps the standard `openai` npm package internally, which is already covered by the OpenAI instrumentation.

---

## 8. Database & Cache Instrumentation

### PostgreSQL (`pg`)

```ts
const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
```

Span: `Postgres SELECT` with `db.system.name: 'postgresql'`, `db.operation.name: 'SELECT'`, sanitized SQL, row count.

### MongoDB (`mongodb`)

```ts
const user = await db.collection('users').findOne({ _id: userId });
```

Span: `Mongo users findOne` with `db.system.name: 'mongodb'`, `db.collection.name: 'users'`, `db.operation.name: 'findOne'`.

### Mongoose

```ts
const user = await User.findById(userId).exec();
```

Span includes model name, collection name, and operation.

### MySQL / MySQL2

```ts
const [rows] = await connection.execute('SELECT * FROM users WHERE id = ?', [userId]);
```

Span: `MySQL SELECT` with sanitized SQL and row count.

### Redis / ioredis

```ts
await redis.get(`user:${userId}`);
```

Span: `Redis GET` with command name and key.

### Knex

```ts
const users = await knex('users').where({ active: true }).select('*');
```

Span: `Knex SELECT users` with query builder context, sanitized SQL, and binding count.

### SQL Server (Tedious)

```ts
const request = new Request('SELECT * FROM Users WHERE Id = @id', callback);
request.addParameter('id', TYPES.Int, userId);
connection.execSql(request);
```

Span: `SQLServer SELECT` with sanitized T-SQL, row count, and stored procedure name.

### Cassandra

```ts
const result = await client.execute('SELECT * FROM users WHERE id = ?', [userId], { prepare: true });
```

Span: `Cassandra SELECT` with `db.system.name: 'cassandra'`, keyspace, consistency level, sanitized CQL.

### Memcached

```ts
memcached.get('session:abc', (err, data) => { });
```

Span: `Memcached GET` with command name and key.

---

## 9. Messaging & Queue Instrumentation

### Kafka (kafkajs)

```ts
// Producer
await producer.send({ topic: 'orders', messages: [{ value: JSON.stringify(order) }] });
// Span: "Kafka SEND orders" with topic, partition, message count

// Consumer
await consumer.run({
  eachMessage: async ({ topic, message }) => { /* ... */ },
});
// Span: "Kafka RECEIVE orders" with topic, partition, offset
```

### RabbitMQ (amqplib)

```ts
// Publish
channel.publish('exchange', 'routing.key', Buffer.from(JSON.stringify(data)));
// Span: "RabbitMQ PUBLISH exchange" with exchange, routing key

// Consume
channel.consume('queue-name', (msg) => { channel.ack(msg); });
// Span: "RabbitMQ RECEIVE queue-name" with queue name, delivery tag
```

### Socket.IO

```ts
io.on('connection', (socket) => {
  socket.on('message', (data) => { /* ... */ });
  socket.emit('response', { ok: true });
});
// Spans for emit and receive with event names, namespace, room
```

---

## 10. Cloud Provider Instrumentation

### AWS SDK v3

All AWS services are instrumented through the single `Client.send()` dispatch point:

```ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: 'us-east-1' });
await s3.send(new PutObjectCommand({ Bucket: 'my-bucket', Key: 'file.txt', Body: data }));
// Span: "AWS S3 PutObject" with rpc.service, rpc.method, aws.request_id, aws.region
```

Covers: S3, DynamoDB, SQS, SNS, Lambda, SES, CloudWatch, Kinesis, EventBridge, Secrets Manager, SSM, STS, IAM, EC2, ECS, EKS, RDS, ElastiCache, Redshift, Cognito, Route53, CloudFront, API Gateway, Step Functions, CodeBuild, KMS, Bedrock Runtime, and any other AWS service using SDK v3.

### Firebase Admin

**Firestore:**

```ts
const doc = await db.collection('users').doc('user123').get();
await db.collection('users').doc('user123').set({ name: 'Alice' });
const snapshot = await db.collection('users').where('active', '==', true).get();
// Spans: "Firestore GET users/user123", "Firestore SET users/user123", "Firestore QUERY users"
```

Captured operations: GET, SET, ADD, UPDATE, DELETE, CREATE, LIST, QUERY, TX_GET, BATCH_COMMIT.

**Auth:**

```ts
const user = await admin.auth().getUser(uid);
const token = await admin.auth().verifyIdToken(idToken);
// Spans: "Firebase Auth getUser", "Firebase Auth verifyIdToken"
```

16 methods captured: createUser, getUser, getUserByEmail, getUserByPhoneNumber, listUsers, deleteUser, deleteUsers, updateUser, verifyIdToken, verifySessionCookie, createSessionCookie, revokeRefreshTokens, setCustomUserClaims, generateEmailVerificationLink, generatePasswordResetLink, generateSignInWithEmailLink.

**FCM Messaging:**

```ts
await admin.messaging().send({ notification: { title: 'Hi' }, token: deviceToken });
// Span: "Firebase FCM send" with success/failure counts
```

9 methods captured: send, sendEach, sendEachForMulticast, sendMulticast, sendToDevice, sendToTopic, sendToCondition, subscribeToTopic, unsubscribeFromTopic.

---

## 11. gRPC, GraphQL & Network

### gRPC

```ts
// Server and client calls automatically instrumented
// Span: "grpc /package.Service/Method" with rpc.system, rpc.service, rpc.method, status code
```

Supports unary, client streaming, server streaming, and bidirectional streaming.

### GraphQL

```ts
// Resolver-level instrumentation
// Span: "GraphQL query GetUser" with operation name, operation type, field path
```

Captures query/mutation/subscription operations and individual field resolver execution.

### DNS

```ts
import dns from 'dns';

dns.lookup('example.com', (err, address) => { /* ... */ });
// Span: "DNS lookup example.com" with hostname, record type
```

### Net (TCP Sockets)

```ts
import net from 'net';

const socket = net.createConnection({ host: 'db.internal', port: 5432 });
// Span: "TCP CONNECT db.internal:5432" with host, port, connection duration
```

---

## 12. Log Correlation

### Console Logs

All `console.log`, `console.info`, `console.warn`, `console.error`, and `console.debug` calls are automatically captured and correlated with the active trace or task context.

```ts
app.get('/users/:id', async (req, res) => {
  console.info('fetching user', { userId: req.params.id });
  // Log is captured with traceId, level "info", and attributes { userId: "123" }
  const user = await getUser(req.params.id);
  res.json(user);
});
```

### Structured Logging Libraries

Pino, Winston, and Bunyan get trace/span IDs automatically injected into log records:

```ts
import pino from 'pino';
const logger = pino();

app.get('/users/:id', (req, res) => {
  logger.info({ userId: req.params.id }, 'fetching user');
  // Output includes: traceId, spanId alongside your log fields
});
```

Disable console log capture:

```ts
Senzor.init({ apiKey: '...', autoLogs: false });
```

---

## 13. Background Task Monitoring

### Auto-Instrumented

**BullMQ** workers are captured as task runs with queue delay, retry counts, dead-letter detection, and CPU/memory resource metrics.

**node-cron** scheduled jobs are captured as task runs with the cron schedule expression.

### Manual Task Wrapping

```ts
const processPayment = Senzor.wrapTask(
  'process_payment',       // task name
  'custom',                // type: 'cron' | 'queue' | 'pipeline' | 'custom'
  { metadata: { owner: 'billing' } },
  async (invoiceId: string) => {
    await chargeCustomer(invoiceId);
  }
);

await processPayment('inv_123');
```

### Low-Level Task API

```ts
Senzor.startTask('rebuild_index', 'custom', { metadata: { trigger: 'manual' } }, async () => {
  try {
    await rebuildSearchIndex();
    // endTask is called automatically on success
  } catch (error) {
    Senzor.captureException(error);
    throw error; // endTask('failed') on throw
  }
});
```

Task payloads include:
- `taskName`, `taskType`, `status`, `duration`
- `queueDelay`, `attempts`, `isDeadLetter` (for BullMQ)
- `resourceMetrics`: heap memory delta, CPU user/system time
- `triggerTraceId`: links tasks triggered by HTTP requests

---

## 14. Manual Traces & Spans

### Manual Span

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

### Manual Trace

For environments where framework wrappers can't be used:

```ts
Senzor.track({
  method: 'POST',
  route: '/webhooks/payment',
  path: '/webhooks/payment',
  status: 202,
  duration: 18.7,
  spans: [],
});
```

---

## 15. Error Tracking

### Automatic

The SDK captures these global events:

| Event | Severity |
|-------|----------|
| `uncaughtExceptionMonitor` | fatal |
| `uncaughtException` | fatal |
| `unhandledRejection` | error |
| `warning` | warning |
| `multipleResolves` | warning |
| `SIGTERM` | info |
| `SIGINT` | info |

Each captured error includes: stack trace, process context (pid, platform, uptime, NODE_ENV), memory snapshot (RSS, heap, external), and SDK metadata.

### Manual

```ts
try {
  await chargeCustomer(customerId);
} catch (error) {
  Senzor.captureException(error, { customerId, operation: 'charge' });
  throw error;
}
```

Errors are correlated with the active trace or task context.

---

## 16. Runtime Metrics

Collected every 15 seconds (configurable) and sent with trace batches.

| Metric | Description |
|--------|-------------|
| `eventLoop.lag.p50` | Event loop lag, 50th percentile (ms) |
| `eventLoop.lag.p99` | Event loop lag, 99th percentile (ms) |
| `eventLoop.lag.max` | Event loop lag, maximum observed (ms) |
| `eventLoop.utilization` | Event loop utilization (0-1, from `perf_hooks` ELU) |
| `gc.duration.minor` | GC pause time, minor collections (ms) |
| `gc.duration.major` | GC pause time, major collections (ms) |
| `gc.duration.incremental` | GC pause time, incremental marking (ms) |
| `memory.heapUsed` | V8 heap used (bytes) |
| `memory.heapTotal` | V8 heap total (bytes) |
| `memory.rss` | Resident set size (bytes) |
| `memory.external` | External memory (bytes) |
| `memory.arrayBuffers` | ArrayBuffer memory (bytes) |
| `activeHandles` | Open handles (file descriptors, sockets) |
| `activeRequests` | Pending async requests |

Disable runtime metrics:

```ts
Senzor.init({ apiKey: '...', runtimeMetrics: false });
```

Adjust collection interval:

```ts
Senzor.init({ apiKey: '...', runtimeMetricsInterval: 30000 }); // 30 seconds
```

Runtime metrics are automatically disabled in AWS Lambda environments.

---

## 17. Distributed Tracing & Context Propagation

### Outgoing Headers

The SDK injects these headers on all outgoing HTTP calls:

```
traceparent: 00-{traceId}-{spanId}-01
x-senzor-trace-id: {traceId}
x-senzor-parent-span-id: {spanId}
```

### Incoming Headers

Incoming requests with `traceparent` or `x-senzor-trace-id` headers are linked as child traces, enabling cross-service distributed trace visualization.

### Context Propagation

The SDK uses `AsyncLocalStorage` to maintain trace context across async boundaries. All child spans, logs, and errors within a request are automatically correlated to the correct trace without any manual threading.

---

## 18. Configuration Reference

```ts
Senzor.init({
  apiKey: 'sz_apm_xxx',                    // Required
  endpoint: 'https://api.senzor.dev',      // Ingest endpoint
  batchSize: 100,                           // Flush threshold
  flushInterval: 10000,                     // Flush interval (ms)
  flushTimeoutMs: 5000,                     // Per-request timeout (ms)
  maxQueueSize: 10000,                      // Max queued items before drop
  maxSpansPerTrace: 500,                    // Max spans per trace
  maxAttributeLength: 2048,                 // Max string length
  maxAttributes: 64,                        // Max attributes per object
  captureHeaders: false,                    // Capture sanitized headers
  captureDbStatement: true,                 // Capture sanitized SQL
  instrumentations: true,                   // true | false | string[]
  frameworkSpans: true,                     // Framework middleware/handler spans
  captureMiddlewareSpans: true,             // Middleware execution spans
  captureRouterSpans: true,                 // Router dispatch spans
  captureLifecycleHookSpans: true,          // Lifecycle hook spans
  autoLogs: true,                           // Console log capture
  runtimeMetrics: true,                     // Runtime metrics collection
  runtimeMetricsInterval: 15000,            // Collection interval (ms)
  debug: false,                             // SDK diagnostics
});
```

| Option | Production Guidance |
|--------|-------------------|
| `apiKey` | Always use environment variables or secret manager. Never hardcode. |
| `batchSize` | Start at `100`. Increase for high-throughput services. |
| `flushInterval` | `10000` ms for servers. `0` for Lambda (flush on demand). |
| `maxQueueSize` | Keep bounded. Increase only after checking memory pressure. |
| `maxSpansPerTrace` | Keep `500` unless traces fan out heavily (e.g., batch operations). |
| `captureHeaders` | Keep `false` unless needed for debugging. |
| `debug` | Never enable in production unless actively troubleshooting. |

### Selective Instrumentation

```ts
// Enable only specific instrumentations
Senzor.init({
  apiKey: '...',
  instrumentations: ['http', 'fetch', 'pg', 'redis', 'openai'],
});

// Disable all auto-instrumentation (manual APIs only)
Senzor.init({
  apiKey: '...',
  instrumentations: false,
});
```

---

## 19. Environment Variables

The preload entrypoint (`@senzops/apm-node/register`) reads:

| Variable | Maps To | Default |
|----------|---------|---------|
| `SENZOR_API_KEY` | `apiKey` | — |
| `SENZOR_APM_API_KEY` | `apiKey` (alt) | — |
| `SENZOR_SERVICE_API_KEY` | `apiKey` (alt) | — |
| `SENZOR_ENDPOINT` | `endpoint` | `https://api.senzor.dev` |
| `SENZOR_APM_ENDPOINT` | `endpoint` (alt) | — |
| `SENZOR_DEBUG` | `debug` | `false` |
| `SENZOR_AUTO_LOGS` | `autoLogs` | `true` |
| `SENZOR_BATCH_SIZE` | `batchSize` | `100` (or `10` in Lambda) |
| `SENZOR_FLUSH_INTERVAL` | `flushInterval` | `10000` (or `0` in Lambda) |
| `SENZOR_FLUSH_TIMEOUT_MS` | `flushTimeoutMs` | `5000` |
| `SENZOR_MAX_QUEUE_SIZE` | `maxQueueSize` | `10000` |
| `SENZOR_MAX_SPANS_PER_TRACE` | `maxSpansPerTrace` | `500` |
| `SENZOR_CAPTURE_HEADERS` | `captureHeaders` | `false` |
| `SENZOR_CAPTURE_DB_STATEMENT` | `captureDbStatement` | `true` |
| `SENZOR_FRAMEWORK_SPANS` | `frameworkSpans` | `true` |
| `SENZOR_CAPTURE_MIDDLEWARE_SPANS` | `captureMiddlewareSpans` | `true` |
| `SENZOR_CAPTURE_ROUTER_SPANS` | `captureRouterSpans` | `true` |
| `SENZOR_CAPTURE_LIFECYCLE_HOOK_SPANS` | `captureLifecycleHookSpans` | `true` |
| `SENZOR_RUNTIME_METRICS` | `runtimeMetrics` | `true` (auto `false` in Lambda) |
| `SENZOR_RUNTIME_METRICS_INTERVAL` | `runtimeMetricsInterval` | `15000` |

Environment variable values always take precedence over programmatic configuration.

---

## 20. Security, Privacy & Cardinality

### Automatic Redaction

These keys are automatically redacted from attributes, headers, logs, and error context:

`authorization`, `cookie`, `set-cookie`, `password`, `passwd`, `pwd`, `secret`, `token`, `api-key`, `x-api-key`, `access-token`, `refresh-token`, `client-secret`, `private-key`

### Cardinality Controls

- URL routes are normalized: `/users/123` becomes `/users/:id`
- UUIDs and MongoDB ObjectIDs are replaced with `:id` in route names
- SQL statements are normalized to remove literal values
- Attribute count and string length are bounded
- Span count per trace is bounded
- Queue size is bounded with oldest-first eviction

### Recommendations

- Keep `captureHeaders` disabled unless required for debugging
- Never capture request/response bodies
- Use route templates (e.g., `/users/:id`) rather than actual paths in span names
- Store IDs in metadata, not in operation names
- Use `instrumentations: [...]` to disable instrumentations you don't need

---

## 21. Transport Behavior

The SDK batches telemetry and sends it asynchronously using two independent queues:

- **APM Queue**: traces, errors, logs, runtime metrics -> `/api/ingest/apm`
- **Task Queue**: task runs, task errors, task logs -> `/api/ingest/task`

Behavior:

- Queues are bounded by `maxQueueSize` (oldest items evicted first)
- Flush triggers on `batchSize` threshold or `flushInterval` timer
- Each ingest request has a `flushTimeoutMs` timeout
- Failed batches are requeued within queue limits (retry on next flush)
- SDK ingest requests are marked as internal (not traced recursively)
- A best-effort flush runs on `process.beforeExit`
- In Lambda, flush is forced before handler return + Extensions API SHUTDOWN hook

### Serverless Flush

Always call `await Senzor.flush()` before the function exits in serverless environments (unless using `wrapLambda` or `Senzor.worker()`, which handle this automatically).

---

## 22. Ingestion Payload Format

### APM Ingest (`POST /api/ingest/apm`)

```json
{
  "traces": [{
    "traceId": "f3b2c2c9c70443f5a4b7f0ff6d5b9a17",
    "parentTraceId": "8cb1f2e2f43e4b2b8b3411c7df81e7e0",
    "parentSpanId": "6c62c908a21d4f49",
    "rootSpanId": "91f6c551d5a2403f",
    "method": "GET",
    "route": "/orders/:orderId",
    "path": "/orders/ord_123",
    "status": 200,
    "duration": 53.29,
    "ip": "203.0.113.10",
    "userAgent": "Mozilla/5.0",
    "timestamp": "2026-05-26T15:30:00.000Z",
    "spans": [{
      "spanId": "9d8a4d5f17e24d2a",
      "parentSpanId": "91f6c551d5a2403f",
      "name": "Postgres SELECT",
      "type": "db",
      "startTime": 5.41,
      "duration": 12.45,
      "status": 0,
      "meta": {
        "db.system.name": "postgresql",
        "db.operation.name": "SELECT",
        "db.query.text": "SELECT id FROM users WHERE id = $?"
      }
    }]
  }],
  "errors": [{
    "errorClass": "Error",
    "message": "Connection refused",
    "stackTrace": "Error: Connection refused\n    at ...",
    "traceId": "f3b2c2c9c70443f5a4b7f0ff6d5b9a17",
    "context": { "operation": "db_connect" },
    "timestamp": "2026-05-26T15:30:00.000Z"
  }],
  "logs": [{
    "message": "order processed",
    "level": "info",
    "traceId": "f3b2c2c9c70443f5a4b7f0ff6d5b9a17",
    "attributes": { "orderId": "ord_123" },
    "timestamp": "2026-05-26T15:30:00.000Z"
  }],
  "runtimeMetrics": [{
    "timestamp": "2026-05-26T15:30:00.000Z",
    "eventLoop": { "lagP50": 1.2, "lagP99": 4.8, "lagMax": 12.1, "utilization": 0.34 },
    "gc": { "minor": 2.1, "major": 0, "incremental": 0.8 },
    "memory": { "heapUsed": 45000000, "heapTotal": 67000000, "rss": 89000000 }
  }]
}
```

### Task Ingest (`POST /api/ingest/task`)

```json
{
  "runs": [{
    "runId": "3917bd35-b1d6-4e23-a1d2-d969e1a7d6a1",
    "taskName": "billing:send_invoice_email",
    "taskType": "queue",
    "status": "success",
    "duration": 188.3,
    "queueDelay": 92,
    "attempts": 1,
    "triggerTraceId": "f3b2c2c9c70443f5a4b7f0ff6d5b9a17",
    "metadata": { "jobId": "142", "queueName": "billing" },
    "resourceMetrics": {
      "memoryDeltaBytes": 1048576,
      "cpuUserUs": 12000,
      "cpuSystemUs": 3000
    },
    "isDeadLetter": false,
    "spans": [],
    "timestamp": "2026-05-26T15:30:00.000Z"
  }],
  "errors": [],
  "logs": []
}
```

---

## 23. Deployment Patterns

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ dist/

ENV SENZOR_API_KEY=sz_apm_xxx
CMD ["node", "-r", "@senzops/apm-node/register", "dist/server.js"]
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: api
          image: my-api:latest
          env:
            - name: SENZOR_API_KEY
              valueFrom:
                secretKeyRef:
                  name: senzor-secrets
                  key: api-key
            - name: NODE_OPTIONS
              value: "-r @senzops/apm-node/register"
```

### PM2

```json
{
  "apps": [{
    "name": "orders-api",
    "script": "dist/server.js",
    "node_args": "-r @senzops/apm-node/register",
    "env": {
      "SENZOR_API_KEY": "sz_apm_xxx",
      "NODE_ENV": "production"
    }
  }]
}
```

### AWS Lambda

See [Section 4: AWS Lambda Integration](#4-aws-lambda-integration).

### Cloudflare Workers

See [Section 5: Cloudflare Workers Integration](#5-cloudflare-workers-integration).

### Vercel (Serverless Functions)

```ts
// api/route.ts
import Senzor from '@senzops/apm-node';

Senzor.init({ apiKey: process.env.SENZOR_API_KEY! });

export const GET = Senzor.wrapNextRoute(async (req) => {
  const result = await fetchData();
  return Response.json(result);
});
```

---

## 24. Troubleshooting

### Missing Spans

1. **Check startup order.** Preload mode must load before application modules:
   ```sh
   node -r @senzops/apm-node/register server.js
   ```
2. **Programmatic mode:** Initialize `Senzor.init()` before importing `pg`, `mongodb`, `redis`, etc.
3. **Check if the library is supported** in the [instrumentation table](#6-auto-instrumentation-reference).

### No Data in Senzor

1. Verify `SENZOR_API_KEY` is set and valid.
2. Verify `endpoint` points to the correct Senzor environment.
3. Verify the runtime can reach the ingest endpoint (check firewall, VPC, DNS).
4. Enable `debug: true` to see flush attempts.
5. In serverless environments, ensure `Senzor.flush()` is called (or use `wrapLambda`/`worker()`).

### Duplicate Traces

The SDK deduplicates active traces. If duplicates still appear:
- Check whether both preload mode AND manual `track()` calls are active for the same request.
- Ensure `Senzor.requestHandler()` is only attached once.

### High Memory Usage

```ts
Senzor.init({
  apiKey: '...',
  maxQueueSize: 5000,        // Reduce queue bounds
  maxSpansPerTrace: 250,     // Reduce span retention
  maxAttributes: 32,         // Reduce attribute count
  maxAttributeLength: 1024,  // Reduce string lengths
});
```

### High-Cardinality Routes

Use framework wrappers that provide route templates:

```ts
app.use(Senzor.requestHandler()); // Captures /users/:id instead of /users/123
```

For manual traces, use normalized routes:

```ts
Senzor.track({ method: 'GET', route: '/users/:id', path: '/users/123', ... });
```

### Lambda Cold Start Issues

- Ensure `Senzor.init()` or preload runs outside the handler (module scope).
- Check that `NODE_OPTIONS` is set correctly for Lambda Layer deployments.
- Use `Senzor.wrapLambda()` for proper cold start tagging.

---

## 25. Public API Reference

```ts
// Initialization
Senzor.init(options: SenzorOptions)              // Initialize SDK with API key
Senzor.preload(options?: Partial<SenzorOptions>)  // Pre-install hooks (used by register.ts)

// Telemetry
Senzor.flush(): Promise<void>                     // Force flush all queued telemetry
Senzor.track(data: object)                        // Send a manual trace
Senzor.startSpan(name: string, type?: SpanType)   // Start a manual child span
Senzor.captureException(error: unknown, ctx?: object)  // Capture an error

// Task Monitoring
Senzor.wrapTask(name, type, options, fn)          // Wrap function as monitored task
Senzor.startTask(name, type, options, fn)         // Start task monitoring context

// Framework Wrappers
Senzor.requestHandler()                            // Express request middleware
Senzor.errorHandler()                              // Express error middleware
Senzor.fastifyPlugin                               // Fastify plugin
Senzor.wrapNextRoute(handler)                      // Next.js App Router wrapper
Senzor.wrapNextPages(handler)                      // Next.js Pages Router wrapper
Senzor.wrapH3(handler)                             // H3/Nuxt/Nitro event handler wrapper
Senzor.nitroPlugin                                 // Nitro plugin for Cloudflare Workers
Senzor.worker(handler)                             // Cloudflare Workers fetch handler wrapper
Senzor.wrapLambda(handler)                         // AWS Lambda handler wrapper
```

---

## 26. Build & Publish

```sh
npm run build
```

Output:

| File | Format | Description |
|------|--------|-------------|
| `dist/index.js` | CommonJS | Main entry |
| `dist/index.mjs` | ESM | Main entry |
| `dist/index.global.js` | IIFE | Browser/CDN bundle |
| `dist/register.js` | CommonJS | Preload entry |
| `dist/register.mjs` | ESM | Preload entry |
| `dist/index.d.ts` | TypeScript | Type declarations |
| `dist/register.d.ts` | TypeScript | Type declarations |

Verify before publishing:

```sh
npx tsc --noEmit && npm run build
```
