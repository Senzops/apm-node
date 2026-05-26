import { Context } from '../core/context';
import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';
import { generateTraceparent, parseTraceparent } from '../utils/traceContext';

// ---------------------------------------------------------------------------
// Kafka (kafkajs) Instrumentation
//
// Instruments the kafkajs library:
//   - Producer: send(), sendBatch() — outbound publish spans
//   - Consumer: run() — wraps eachMessage/eachBatch callbacks with spans
//   - Context propagation via message headers (traceparent, x-senzor-*)
//
// Follows OTel messaging semantic conventions:
//   messaging.system = kafka
//   messaging.destination.name = topic
//   messaging.operation.name = publish | receive
//   messaging.kafka.consumer.group
//   messaging.kafka.message.offset
//   messaging.batch.message_count
// ---------------------------------------------------------------------------

const TRACEPARENT_KEY = 'traceparent';
const SENZOR_TRACE_KEY = 'x-senzor-trace-id';
const SENZOR_SPAN_KEY = 'x-senzor-parent-span-id';

/** Inject trace context into Kafka message headers. */
const injectHeaders = (
  headers: Record<string, any> | undefined,
  traceId: string,
  spanId: string
): Record<string, any> => {
  const h = headers ? { ...headers } : {};
  h[TRACEPARENT_KEY] = Buffer.from(generateTraceparent(traceId, spanId));
  h[SENZOR_TRACE_KEY] = Buffer.from(traceId);
  h[SENZOR_SPAN_KEY] = Buffer.from(spanId);
  return h;
};

/** Extract trace context from incoming Kafka message headers. */
const extractHeaders = (
  headers: Record<string, any> | undefined
): { traceId?: string; parentSpanId?: string } => {
  if (!headers) return {};

  try {
    const tp = headers[TRACEPARENT_KEY];
    if (tp) {
      const tpStr = Buffer.isBuffer(tp) ? tp.toString() : String(tp);
      const parsed = parseTraceparent(tpStr);
      if (parsed) return parsed;
    }

    const traceId = headers[SENZOR_TRACE_KEY];
    const spanId = headers[SENZOR_SPAN_KEY];
    return {
      traceId: traceId ? (Buffer.isBuffer(traceId) ? traceId.toString() : String(traceId)) : undefined,
      parentSpanId: spanId ? (Buffer.isBuffer(spanId) ? spanId.toString() : String(spanId)) : undefined,
    };
  } catch {
    return {};
  }
};

// ---------------------------------------------------------------------------
// Producer patching
// ---------------------------------------------------------------------------

const patchProducer = (producer: any, options?: SenzorOptions) => {
  // send({ topic, messages, ... })
  patchMethod(
    producer,
    'send',
    'senzor.kafka.producer.send',
    (original) =>
      function patchedSend(this: any, payload: any) {
        const trace = Context.current();
        if (!trace) return original.call(this, payload);

        const topic = payload?.topic || 'unknown';
        const messageCount = payload?.messages?.length || 0;

        const span = startCapturedSpan(
          `Kafka publish ${topic}`,
          'messaging',
          {
            'messaging.system': 'kafka',
            'messaging.destination.name': topic,
            'messaging.operation.name': 'publish',
            'messaging.batch.message_count': messageCount,
          },
          options
        );

        if (!span) return original.call(this, payload);

        // Inject trace context into each message's headers
        if (payload?.messages && Array.isArray(payload.messages)) {
          payload = {
            ...payload,
            messages: payload.messages.map((msg: any) => ({
              ...msg,
              headers: injectHeaders(msg.headers, trace.id, span.spanId),
            })),
          };
        }

        return runWithCapturedSpan(span, () => {
          const result = original.call(this, payload);

          if (result && typeof result.then === 'function') {
            return result.then(
              (res: any) => {
                span.end(0, {
                  'messaging.kafka.partitions': Array.isArray(res)
                    ? res.map((r: any) => r.partition).join(',')
                    : undefined,
                });
                return res;
              },
              (error: any) => {
                span.end(500, {
                  'error.message': error?.message,
                  'error.type': error?.name || 'KafkaError',
                });
                throw error;
              }
            );
          }

          span.end(0);
          return result;
        });
      }
  );

  // sendBatch({ topicMessages: [{ topic, messages }], ... })
  patchMethod(
    producer,
    'sendBatch',
    'senzor.kafka.producer.sendBatch',
    (original) =>
      function patchedSendBatch(this: any, payload: any) {
        const trace = Context.current();
        if (!trace) return original.call(this, payload);

        const topicMessages = payload?.topicMessages || [];
        const topics = topicMessages.map((tm: any) => tm.topic).join(',');
        const totalMessages = topicMessages.reduce(
          (sum: number, tm: any) => sum + (tm.messages?.length || 0),
          0
        );

        const span = startCapturedSpan(
          `Kafka publishBatch ${topics}`,
          'messaging',
          {
            'messaging.system': 'kafka',
            'messaging.destination.name': topics,
            'messaging.operation.name': 'publish',
            'messaging.batch.message_count': totalMessages,
            'messaging.kafka.batch_topic_count': topicMessages.length,
          },
          options
        );

        if (!span) return original.call(this, payload);

        // Inject trace context into all messages
        if (topicMessages.length > 0) {
          payload = {
            ...payload,
            topicMessages: topicMessages.map((tm: any) => ({
              ...tm,
              messages: (tm.messages || []).map((msg: any) => ({
                ...msg,
                headers: injectHeaders(msg.headers, trace.id, span.spanId),
              })),
            })),
          };
        }

        return runWithCapturedSpan(span, () => {
          const result = original.call(this, payload);

          if (result && typeof result.then === 'function') {
            return result.then(
              (res: any) => {
                span.end(0);
                return res;
              },
              (error: any) => {
                span.end(500, {
                  'error.message': error?.message,
                  'error.type': error?.name || 'KafkaError',
                });
                throw error;
              }
            );
          }

          span.end(0);
          return result;
        });
      }
  );
};

// ---------------------------------------------------------------------------
// Consumer patching
// ---------------------------------------------------------------------------

const patchConsumer = (consumer: any, options?: SenzorOptions) => {
  patchMethod(
    consumer,
    'run',
    'senzor.kafka.consumer.run',
    (original) =>
      function patchedRun(this: any, config: any) {
        if (!config) return original.call(this, config);

        const wrappedConfig = { ...config };

        // Wrap eachMessage
        if (typeof config.eachMessage === 'function') {
          const originalHandler = config.eachMessage;
          wrappedConfig.eachMessage = async (payload: any) => {
            const { topic, partition, message } = payload;
            const parentCtx = extractHeaders(message?.headers);

            const span = startCapturedSpan(
              `Kafka receive ${topic}`,
              'messaging',
              {
                'messaging.system': 'kafka',
                'messaging.destination.name': topic,
                'messaging.operation.name': 'receive',
                'messaging.kafka.partition': partition,
                'messaging.kafka.message.offset': message?.offset,
                'messaging.kafka.message.key': message?.key?.toString(),
                ...(parentCtx.traceId ? { 'messaging.parent_trace_id': parentCtx.traceId } : {}),
              },
              options
            );

            if (!span) return originalHandler(payload);

            return runWithCapturedSpan(span, async () => {
              try {
                const result = await originalHandler(payload);
                span.end(0);
                return result;
              } catch (error: any) {
                span.end(500, {
                  'error.message': error?.message,
                  'error.type': error?.name || 'Error',
                });
                throw error;
              }
            });
          };
        }

        // Wrap eachBatch
        if (typeof config.eachBatch === 'function') {
          const originalBatchHandler = config.eachBatch;
          wrappedConfig.eachBatch = async (payload: any) => {
            const { batch } = payload;
            const topic = batch?.topic || 'unknown';
            const messageCount = batch?.messages?.length || 0;

            const span = startCapturedSpan(
              `Kafka receiveBatch ${topic}`,
              'messaging',
              {
                'messaging.system': 'kafka',
                'messaging.destination.name': topic,
                'messaging.operation.name': 'receive',
                'messaging.kafka.partition': batch?.partition,
                'messaging.batch.message_count': messageCount,
                'messaging.kafka.first_offset': batch?.messages?.[0]?.offset,
                'messaging.kafka.last_offset': batch?.messages?.[messageCount - 1]?.offset,
              },
              options
            );

            if (!span) return originalBatchHandler(payload);

            return runWithCapturedSpan(span, async () => {
              try {
                const result = await originalBatchHandler(payload);
                span.end(0);
                return result;
              } catch (error: any) {
                span.end(500, {
                  'error.message': error?.message,
                  'error.type': error?.name || 'Error',
                });
                throw error;
              }
            });
          };
        }

        return original.call(this, wrappedConfig);
      }
  );
};

// ---------------------------------------------------------------------------
// Kafka class patching (wraps factory methods)
// ---------------------------------------------------------------------------

const patchKafkaClass = (kafkaModule: any, options?: SenzorOptions) => {
  const KafkaClass = kafkaModule?.Kafka;
  if (!KafkaClass?.prototype) return;

  // Wrap producer() factory
  patchMethod(
    KafkaClass.prototype,
    'producer',
    'senzor.kafka.producer',
    (original) =>
      function patchedProducerFactory(this: any, ...args: any[]) {
        const producer = original.apply(this, args);
        if (producer) patchProducer(producer, options);
        return producer;
      }
  );

  // Wrap consumer() factory
  patchMethod(
    KafkaClass.prototype,
    'consumer',
    'senzor.kafka.consumer',
    (original) =>
      function patchedConsumerFactory(this: any, ...args: any[]) {
        const consumer = original.apply(this, args);
        if (consumer) patchConsumer(consumer, options);
        return consumer;
      }
  );
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentKafka = (options?: SenzorOptions) => {
  hookRequire('kafkajs', (exports: any) => {
    patchKafkaClass(exports, options);

    // Also handle default export
    if (exports?.default?.Kafka) {
      patchKafkaClass(exports.default, options);
    }
  });
};
