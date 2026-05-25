import { client } from './core/client';
import { getEnv } from './core/runtime';

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

const options = {
  apiKey: apiKey || '',
  endpoint,
  debug: truthy(getEnv('SENZOR_DEBUG')),
  autoLogs: getEnv('SENZOR_AUTO_LOGS') === 'false' ? false : undefined,
  batchSize: numberFromEnv(getEnv('SENZOR_BATCH_SIZE')),
  flushInterval: numberFromEnv(getEnv('SENZOR_FLUSH_INTERVAL')),
  flushTimeoutMs: numberFromEnv(getEnv('SENZOR_FLUSH_TIMEOUT_MS')),
  maxQueueSize: numberFromEnv(getEnv('SENZOR_MAX_QUEUE_SIZE')),
  maxSpansPerTrace: numberFromEnv(getEnv('SENZOR_MAX_SPANS_PER_TRACE')),
  captureHeaders: truthy(getEnv('SENZOR_CAPTURE_HEADERS')),
  captureDbStatement:
    getEnv('SENZOR_CAPTURE_DB_STATEMENT') === 'false'
      ? false
      : undefined,
  frameworkSpans:
    getEnv('SENZOR_FRAMEWORK_SPANS') === 'false'
      ? false
      : undefined,
  captureMiddlewareSpans:
    getEnv('SENZOR_CAPTURE_MIDDLEWARE_SPANS') === 'false'
      ? false
      : undefined,
  captureRouterSpans:
    getEnv('SENZOR_CAPTURE_ROUTER_SPANS') === 'false'
      ? false
      : undefined,
  captureLifecycleHookSpans:
    getEnv('SENZOR_CAPTURE_LIFECYCLE_HOOK_SPANS') === 'false'
      ? false
      : undefined
};

if (apiKey) {
  client.init(options);
} else {
  client.preload(options);
}
