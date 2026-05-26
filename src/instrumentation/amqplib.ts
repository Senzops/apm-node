import { Context } from '../core/context';
import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';
import { generateTraceparent, parseTraceparent } from '../utils/traceContext';

// ---------------------------------------------------------------------------
// RabbitMQ (amqplib) Instrumentation
//
// Instruments the amqplib library:
//   - Channel.publish()     — outbound publish spans
//   - Channel.sendToQueue() — outbound send spans (shorthand for publish)
//   - Channel.consume()     — wraps consumer callback with receive spans
//
// Context propagation via message headers (msg.properties.headers).
//
// ConfirmChannel inherits from Channel, so patches propagate automatically.
//
// Follows OTel messaging semantic conventions:
//   messaging.system = rabbitmq
//   messaging.destination.name = exchange or queue
//   messaging.operation.name = publish | receive
//   messaging.rabbitmq.routing_key
//   messaging.rabbitmq.delivery_tag
// ---------------------------------------------------------------------------

const TRACEPARENT_KEY = 'traceparent';
const SENZOR_TRACE_KEY = 'x-senzor-trace-id';
const SENZOR_SPAN_KEY = 'x-senzor-parent-span-id';

/** Inject trace context into AMQP message headers. */
const injectHeaders = (
  options: any,
  traceId: string,
  spanId: string
): any => {
  const opts = options ? { ...options } : {};
  const headers = opts.headers ? { ...opts.headers } : {};
  headers[TRACEPARENT_KEY] = generateTraceparent(traceId, spanId);
  headers[SENZOR_TRACE_KEY] = traceId;
  headers[SENZOR_SPAN_KEY] = spanId;
  opts.headers = headers;
  return opts;
};

/** Extract trace context from incoming AMQP message properties. */
const extractHeaders = (
  msg: any
): { traceId?: string; parentSpanId?: string } => {
  const headers = msg?.properties?.headers;
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
// Channel patching
// ---------------------------------------------------------------------------

const patchChannel = (channelProto: any, options?: SenzorOptions) => {
  if (!channelProto) return;

  // --- publish(exchange, routingKey, content, options?) ---
  patchMethod(
    channelProto,
    'publish',
    'senzor.amqplib.channel.publish',
    (original) =>
      function patchedPublish(
        this: any,
        exchange: string,
        routingKey: string,
        content: Buffer,
        publishOptions?: any
      ) {
        const trace = Context.current();
        if (!trace) return original.call(this, exchange, routingKey, content, publishOptions);

        const destination = exchange || routingKey || 'default';

        const span = startCapturedSpan(
          `RabbitMQ publish ${destination}`,
          'messaging',
          {
            'messaging.system': 'rabbitmq',
            'messaging.destination.name': destination,
            'messaging.operation.name': 'publish',
            'messaging.rabbitmq.exchange': exchange || '(default)',
            'messaging.rabbitmq.routing_key': routingKey,
            'messaging.message.body_size': content?.length || 0,
          },
          options
        );

        if (!span) return original.call(this, exchange, routingKey, content, publishOptions);

        // Inject trace context into headers
        const enrichedOptions = injectHeaders(publishOptions, trace.id, span.spanId);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.call(this, exchange, routingKey, content, enrichedOptions);

            // publish returns boolean (backpressure signal), not a promise
            span.end(0, {
              'messaging.rabbitmq.backpressure': result === false,
            });

            return result;
          } catch (error: any) {
            span.end(500, {
              'error.message': error?.message,
              'error.type': error?.name || 'AmqpError',
            });
            throw error;
          }
        });
      }
  );

  // --- sendToQueue(queue, content, options?) ---
  patchMethod(
    channelProto,
    'sendToQueue',
    'senzor.amqplib.channel.sendToQueue',
    (original) =>
      function patchedSendToQueue(
        this: any,
        queue: string,
        content: Buffer,
        sendOptions?: any
      ) {
        const trace = Context.current();
        if (!trace) return original.call(this, queue, content, sendOptions);

        const span = startCapturedSpan(
          `RabbitMQ send ${queue}`,
          'messaging',
          {
            'messaging.system': 'rabbitmq',
            'messaging.destination.name': queue,
            'messaging.operation.name': 'publish',
            'messaging.rabbitmq.routing_key': queue,
            'messaging.message.body_size': content?.length || 0,
          },
          options
        );

        if (!span) return original.call(this, queue, content, sendOptions);

        const enrichedOptions = injectHeaders(sendOptions, trace.id, span.spanId);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.call(this, queue, content, enrichedOptions);
            span.end(0, {
              'messaging.rabbitmq.backpressure': result === false,
            });
            return result;
          } catch (error: any) {
            span.end(500, {
              'error.message': error?.message,
              'error.type': error?.name || 'AmqpError',
            });
            throw error;
          }
        });
      }
  );

  // --- consume(queue, callback, options?) ---
  patchMethod(
    channelProto,
    'consume',
    'senzor.amqplib.channel.consume',
    (original) =>
      function patchedConsume(
        this: any,
        queue: string,
        callback: (msg: any) => void,
        consumeOptions?: any
      ) {
        if (typeof callback !== 'function') {
          return original.call(this, queue, callback, consumeOptions);
        }

        const wrappedCallback = function (msg: any) {
          // Null msg means consumer was cancelled
          if (!msg) return callback(msg);

          const parentCtx = extractHeaders(msg);
          const exchange = msg.fields?.exchange || '';
          const routingKey = msg.fields?.routingKey || queue;
          const destination = exchange || routingKey || queue;

          const span = startCapturedSpan(
            `RabbitMQ receive ${destination}`,
            'messaging',
            {
              'messaging.system': 'rabbitmq',
              'messaging.destination.name': destination,
              'messaging.operation.name': 'receive',
              'messaging.rabbitmq.exchange': exchange || '(default)',
              'messaging.rabbitmq.routing_key': routingKey,
              'messaging.rabbitmq.delivery_tag': msg.fields?.deliveryTag,
              'messaging.rabbitmq.redelivered': msg.fields?.redelivered,
              'messaging.rabbitmq.consumer_tag': msg.fields?.consumerTag,
              'messaging.message.body_size': msg.content?.length || 0,
              ...(parentCtx.traceId ? { 'messaging.parent_trace_id': parentCtx.traceId } : {}),
            },
            options
          );

          if (!span) return callback(msg);

          return runWithCapturedSpan(span, () => {
            try {
              const result = callback(msg);

              // Handle async consumers (returning promises)
              if (result && typeof (result as any).then === 'function') {
                return (result as any).then(
                  (val: any) => {
                    span.end(0);
                    return val;
                  },
                  (error: any) => {
                    span.end(500, {
                      'error.message': error?.message,
                      'error.type': error?.name || 'Error',
                    });
                    throw error;
                  }
                );
              }

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

        return original.call(this, queue, wrappedCallback, consumeOptions);
      }
  );
};

// ---------------------------------------------------------------------------
// Module patching strategies
// ---------------------------------------------------------------------------

/**
 * Strategy 1: Patch Channel prototypes from the internal module structure.
 * amqplib/lib/channel_model exports Channel and ConfirmChannel.
 */
const patchFromInternals = (amqplib: any, options?: SenzorOptions) => {
  // Try to reach Channel prototype via internal module
  try {
    const channelModel = require('amqplib/lib/channel_model');
    if (channelModel?.Channel?.prototype) {
      patchChannel(channelModel.Channel.prototype, options);
    }
    if (channelModel?.ConfirmChannel?.prototype) {
      patchChannel(channelModel.ConfirmChannel.prototype, options);
    }
  } catch { }
};

/**
 * Strategy 2: Wrap createChannel/createConfirmChannel to patch returned instances.
 * Works even if internal structure changes between versions.
 */
const patchConnectionFactory = (amqplib: any, options?: SenzorOptions) => {
  // Wrap amqplib.connect to intercept the connection object
  patchMethod(
    amqplib,
    'connect',
    'senzor.amqplib.connect',
    (original) =>
      function patchedConnect(this: any, ...args: any[]) {
        const result = original.apply(this, args);

        if (result && typeof result.then === 'function') {
          return result.then((connection: any) => {
            if (!connection) return connection;

            // Wrap createChannel
            patchMethod(
              connection,
              'createChannel',
              'senzor.amqplib.createChannel',
              (origCreate) =>
                function patchedCreateChannel(this: any, ...createArgs: any[]) {
                  const chResult = origCreate.apply(this, createArgs);
                  if (chResult && typeof chResult.then === 'function') {
                    return chResult.then((channel: any) => {
                      if (channel) patchChannel(channel, options);
                      return channel;
                    });
                  }
                  if (chResult) patchChannel(chResult, options);
                  return chResult;
                }
            );

            // Wrap createConfirmChannel
            patchMethod(
              connection,
              'createConfirmChannel',
              'senzor.amqplib.createConfirmChannel',
              (origCreate) =>
                function patchedCreateConfirmChannel(this: any, ...createArgs: any[]) {
                  const chResult = origCreate.apply(this, createArgs);
                  if (chResult && typeof chResult.then === 'function') {
                    return chResult.then((channel: any) => {
                      if (channel) patchChannel(channel, options);
                      return channel;
                    });
                  }
                  if (chResult) patchChannel(chResult, options);
                  return chResult;
                }
            );

            return connection;
          });
        }

        return result;
      }
  );
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentAmqplib = (options?: SenzorOptions) => {
  hookRequire('amqplib', (exports: any) => {
    patchFromInternals(exports, options);
    patchConnectionFactory(exports, options);
  });

  // Also hook the callback API variant
  hookRequire('amqplib/callback_api', (exports: any) => {
    patchConnectionFactory(exports, options);
  });
};
