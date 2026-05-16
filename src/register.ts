import { client } from './core/client';

const truthy = (value: string | undefined): boolean =>
  value === '1' || value === 'true' || value === 'yes';

const numberFromEnv = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const apiKey =
  process.env.SENZOR_API_KEY ||
  process.env.SENZOR_APM_API_KEY ||
  process.env.SENZOR_SERVICE_API_KEY;

const endpoint =
  process.env.SENZOR_ENDPOINT ||
  process.env.SENZOR_APM_ENDPOINT;

const options = {
  apiKey: apiKey || '',
  endpoint,
  debug: truthy(process.env.SENZOR_DEBUG),
  autoLogs: process.env.SENZOR_AUTO_LOGS === 'false' ? false : undefined,
  batchSize: numberFromEnv(process.env.SENZOR_BATCH_SIZE),
  flushInterval: numberFromEnv(process.env.SENZOR_FLUSH_INTERVAL),
  flushTimeoutMs: numberFromEnv(process.env.SENZOR_FLUSH_TIMEOUT_MS),
  maxQueueSize: numberFromEnv(process.env.SENZOR_MAX_QUEUE_SIZE),
  maxSpansPerTrace: numberFromEnv(process.env.SENZOR_MAX_SPANS_PER_TRACE),
  captureHeaders: truthy(process.env.SENZOR_CAPTURE_HEADERS),
  captureDbStatement:
    process.env.SENZOR_CAPTURE_DB_STATEMENT === 'false'
      ? false
      : undefined
};

if (apiKey) {
  client.init(options);
} else {
  client.preload(options);
}
