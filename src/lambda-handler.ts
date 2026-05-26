// ---------------------------------------------------------------------------
// Senzor Lambda Auto-Handler Wrapper
//
// This module is the entry point for zero-code-change Lambda Extension Layer
// deployments. It is referenced as the Lambda function's handler:
//
//   Handler: @senzops/apm-node/dist/lambda-handler.handler
//
// It reads the user's original handler from an environment variable,
// dynamically loads it, wraps it with Senzor instrumentation, and
// re-exports the wrapped function.
//
// Required environment variables:
//   SENZOR_API_KEY           — Senzor API key
//   SENZOR_LAMBDA_HANDLER    — Original handler in module.function format
//                              (e.g., "index.handler", "src/app.myHandler")
//
// Optional environment variables:
//   All standard SENZOR_* env vars (see register.ts)
//
// How it works:
//   1. Initializes Senzor SDK via the same logic as register.ts
//   2. Parses SENZOR_LAMBDA_HANDLER into module path + export name
//   3. Resolves the module from LAMBDA_TASK_ROOT (the function's code dir)
//   4. Extracts the named export (supports nested paths like "a.b.c")
//   5. Wraps with wrapLambda() for full APM coverage
//   6. Exports as "handler" for Lambda to invoke
//
// This gives users the same experience as New Relic / Datadog Lambda Layers:
// just add the layer, set 2 env vars, zero code changes.
// ---------------------------------------------------------------------------

import { client } from './core/client';
import { getEnv } from './core/runtime';
import { wrapLambda } from './wrappers/lambda';
import * as path from 'path';

// ---------------------------------------------------------------------------
// 1. Initialize Senzor SDK (same logic as register.ts)
// ---------------------------------------------------------------------------

const truthy = (value: string | undefined): boolean =>
  value === '1' || value === 'true' || value === 'yes';

const numberFromEnv = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const apiKey =
  getEnv('SENZOR_API_KEY') ||
  getEnv('SENZOR_APM_API_KEY') ||
  getEnv('SENZOR_SERVICE_API_KEY');

const endpoint =
  getEnv('SENZOR_ENDPOINT') ||
  getEnv('SENZOR_APM_ENDPOINT');

const isLambda = !!getEnv('AWS_LAMBDA_FUNCTION_NAME');

const options = {
  apiKey: apiKey || '',
  endpoint,
  debug: truthy(getEnv('SENZOR_DEBUG')),
  autoLogs: getEnv('SENZOR_AUTO_LOGS') === 'false' ? false : undefined,
  batchSize: numberFromEnv(getEnv('SENZOR_BATCH_SIZE')) ?? (isLambda ? 10 : undefined),
  flushInterval: numberFromEnv(getEnv('SENZOR_FLUSH_INTERVAL')) ?? (isLambda ? 0 : undefined),
  flushTimeoutMs: numberFromEnv(getEnv('SENZOR_FLUSH_TIMEOUT_MS')),
  maxQueueSize: numberFromEnv(getEnv('SENZOR_MAX_QUEUE_SIZE')),
  maxSpansPerTrace: numberFromEnv(getEnv('SENZOR_MAX_SPANS_PER_TRACE')),
  captureHeaders: truthy(getEnv('SENZOR_CAPTURE_HEADERS')),
  captureDbStatement:
    getEnv('SENZOR_CAPTURE_DB_STATEMENT') === 'false' ? false : undefined,
  frameworkSpans:
    getEnv('SENZOR_FRAMEWORK_SPANS') === 'false' ? false : undefined,
  captureMiddlewareSpans:
    getEnv('SENZOR_CAPTURE_MIDDLEWARE_SPANS') === 'false' ? false : undefined,
  captureRouterSpans:
    getEnv('SENZOR_CAPTURE_ROUTER_SPANS') === 'false' ? false : undefined,
  captureLifecycleHookSpans:
    getEnv('SENZOR_CAPTURE_LIFECYCLE_HOOK_SPANS') === 'false' ? false : undefined,
  runtimeMetrics:
    getEnv('SENZOR_RUNTIME_METRICS') === 'false' || isLambda ? false : undefined,
  runtimeMetricsInterval: numberFromEnv(getEnv('SENZOR_RUNTIME_METRICS_INTERVAL')),
};

if (apiKey) {
  client.init(options);
} else {
  client.preload(options);
}

// ---------------------------------------------------------------------------
// 2. Resolve and wrap the user's original handler
// ---------------------------------------------------------------------------

/**
 * Parse a Lambda handler string into module path and function path.
 *
 * Examples:
 *   "index.handler"           → { modulePath: "index",     fnPath: ["handler"] }
 *   "src/app.myHandler"       → { modulePath: "src/app",   fnPath: ["myHandler"] }
 *   "dist/handlers.api.get"   → { modulePath: "dist/handlers", fnPath: ["api", "get"] }
 *
 * Lambda convention: everything before the LAST dot that isn't part of a
 * directory path is the module, everything after is the function path.
 * Since module paths can contain dots in directory names, we split on the
 * last dot after the last path separator.
 */
const parseHandlerString = (handlerStr: string): { modulePath: string; fnPath: string[] } => {
  const lastSlash = Math.max(handlerStr.lastIndexOf('/'), handlerStr.lastIndexOf('\\'));
  const afterSlash = lastSlash >= 0 ? handlerStr.substring(lastSlash + 1) : handlerStr;
  const beforeSlash = lastSlash >= 0 ? handlerStr.substring(0, lastSlash + 1) : '';

  const firstDot = afterSlash.indexOf('.');
  if (firstDot < 0) {
    // No dot — treat the whole thing as the module, export "handler"
    return { modulePath: handlerStr, fnPath: ['handler'] };
  }

  const moduleName = afterSlash.substring(0, firstDot);
  const fnParts = afterSlash.substring(firstDot + 1).split('.');

  return {
    modulePath: beforeSlash + moduleName,
    fnPath: fnParts,
  };
};

/**
 * Resolve a handler export from a module given a function path.
 * Supports nested exports: ["api", "get"] resolves module.api.get
 */
const resolveExport = (moduleExports: any, fnPath: string[]): Function | null => {
  let current = moduleExports;

  for (const part of fnPath) {
    if (current == null || typeof current !== 'object') return null;
    current = current[part];
  }

  // Also check .default for ESM interop
  if (current == null && moduleExports?.default) {
    current = moduleExports.default;
    for (const part of fnPath) {
      if (current == null || typeof current !== 'object') return null;
      current = current[part];
    }
  }

  return typeof current === 'function' ? current : null;
};

/**
 * Load the user's original handler module. Tries multiple resolution strategies:
 *   1. Absolute path from LAMBDA_TASK_ROOT
 *   2. require() with the module path as-is (for node_modules)
 *   3. With common extensions (.js, .mjs, .cjs)
 */
const loadHandlerModule = (modulePath: string): any => {
  const taskRoot = process.env.LAMBDA_TASK_ROOT || process.cwd();
  const absolutePath = path.resolve(taskRoot, modulePath);

  // Strategy 1: Direct absolute path
  try {
    return require(absolutePath);
  } catch { }

  // Strategy 2: With extensions
  const extensions = ['.js', '.cjs', '.mjs'];
  for (const ext of extensions) {
    try {
      return require(absolutePath + ext);
    } catch { }
  }

  // Strategy 3: Module as-is (may be in node_modules or an absolute path)
  try {
    return require(modulePath);
  } catch { }

  return null;
};

// ---------------------------------------------------------------------------
// 3. Build and export the wrapped handler
// ---------------------------------------------------------------------------

const handlerEnv = getEnv('SENZOR_LAMBDA_HANDLER');

let wrappedHandler: Function;

if (!handlerEnv) {
  // No handler configured — export a diagnostic handler that returns an error
  wrappedHandler = async () => {
    const message =
      'Senzor Lambda Layer: SENZOR_LAMBDA_HANDLER environment variable is not set. ' +
      'Set it to your original handler (e.g., "index.handler") and set the Lambda ' +
      'function handler to "@senzops/apm-node/dist/lambda-handler.handler".';

    console.error(`[Senzor] ${message}`);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: message }),
    };
  };
} else {
  const { modulePath, fnPath } = parseHandlerString(handlerEnv);
  const handlerModule = loadHandlerModule(modulePath);

  if (!handlerModule) {
    const errorMsg = `Senzor Lambda Layer: Could not load handler module "${modulePath}" ` +
      `(from SENZOR_LAMBDA_HANDLER="${handlerEnv}"). Verify the module path exists ` +
      `relative to your Lambda function code.`;

    console.error(`[Senzor] ${errorMsg}`);

    wrappedHandler = async () => ({
      statusCode: 500,
      body: JSON.stringify({ error: errorMsg }),
    });
  } else {
    const originalHandler = resolveExport(handlerModule, fnPath);

    if (!originalHandler) {
      const errorMsg = `Senzor Lambda Layer: Module "${modulePath}" loaded successfully ` +
        `but export "${fnPath.join('.')}" is not a function. ` +
        `Available exports: ${Object.keys(handlerModule).join(', ')}`;

      console.error(`[Senzor] ${errorMsg}`);

      wrappedHandler = async () => ({
        statusCode: 500,
        body: JSON.stringify({ error: errorMsg }),
      });
    } else {
      // Success — wrap the handler with full Senzor APM instrumentation
      wrappedHandler = wrapLambda(originalHandler as any);

      if (truthy(getEnv('SENZOR_DEBUG'))) {
        console.log(
          `[Senzor] Lambda handler wrapped: ${handlerEnv} → ` +
          `module="${modulePath}", export="${fnPath.join('.')}"`,
        );
      }
    }
  }
}

/**
 * The wrapped Lambda handler. Configure your Lambda function to use:
 *
 *   Handler: @senzops/apm-node/dist/lambda-handler.handler
 *
 * And set environment variables:
 *
 *   SENZOR_API_KEY=sz_apm_xxx
 *   SENZOR_LAMBDA_HANDLER=index.handler
 */
export const handler = wrappedHandler;
