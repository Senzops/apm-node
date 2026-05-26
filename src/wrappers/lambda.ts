import { client } from '../core/client';
import { normalizePath } from '../core/normalizer';
import { getClientIp } from '../utils/getClientIp';
import { generateTraceId } from '../utils/ids';

// ---------------------------------------------------------------------------
// AWS Lambda Handler Wrapper
//
// Provides automatic APM instrumentation for AWS Lambda functions.
//
// Features:
//   1. Cold start detection — tags first invocation per container
//   2. Lambda context extraction — faas.*, cloud.*, aws.* attributes
//   3. Trigger-type detection — API Gateway v1/v2, ALB, SQS, SNS,
//      DynamoDB Streams, EventBridge, S3, Scheduled, generic
//   4. Forced flush before response — ensures telemetry delivery
//      since Lambda freezes the process between invocations
//   5. Lambda Extensions API registration — registers as internal
//      extension for SHUTDOWN lifecycle event as a safety-net flush
//
// Usage:
//   import Senzor from '@anthropic/senzor-node';
//   export const handler = Senzor.wrapLambda(async (event, context) => {
//     return { statusCode: 200, body: 'OK' };
//   });
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cold start detection
// ---------------------------------------------------------------------------

/** Module-level flag — true only for the very first invocation in this container. */
let isColdStart = true;

// ---------------------------------------------------------------------------
// Trigger type detection
// ---------------------------------------------------------------------------

type LambdaTrigger =
  | 'api-gateway-v1'
  | 'api-gateway-v2'
  | 'alb'
  | 'sqs'
  | 'sns'
  | 'dynamodb-streams'
  | 'eventbridge'
  | 's3'
  | 'scheduled'
  | 'generic';

const detectTrigger = (event: any): LambdaTrigger => {
  if (!event || typeof event !== 'object') return 'generic';

  // API Gateway v2 (HTTP API)
  if (event.requestContext?.http?.method) return 'api-gateway-v2';

  // API Gateway v1 (REST API)
  if (event.requestContext?.httpMethod || event.httpMethod) return 'api-gateway-v1';

  // ALB (Application Load Balancer)
  if (event.requestContext?.elb) return 'alb';

  // SQS
  if (Array.isArray(event.Records) && event.Records[0]?.eventSource === 'aws:sqs') return 'sqs';

  // SNS
  if (Array.isArray(event.Records) && event.Records[0]?.EventSource === 'aws:sns') return 'sns';

  // DynamoDB Streams
  if (Array.isArray(event.Records) && event.Records[0]?.eventSource === 'aws:dynamodb') return 'dynamodb-streams';

  // S3
  if (Array.isArray(event.Records) && event.Records[0]?.eventSource === 'aws:s3') return 's3';

  // EventBridge / CloudWatch Events
  if (event.source && event['detail-type'] && event.detail) return 'eventbridge';

  // CloudWatch Scheduled Event
  if (event.source === 'aws.events' || event['detail-type'] === 'Scheduled Event') return 'scheduled';

  return 'generic';
};

// ---------------------------------------------------------------------------
// HTTP event extraction (API Gateway v1/v2, ALB)
// ---------------------------------------------------------------------------

interface HttpEventInfo {
  method: string;
  path: string;
  headers: Record<string, string>;
  statusCode?: number;
}

const extractHttpEvent = (event: any, trigger: LambdaTrigger): HttpEventInfo | null => {
  if (trigger === 'api-gateway-v2') {
    const http = event.requestContext?.http;
    return {
      method: http?.method || 'GET',
      path: event.rawPath || event.requestContext?.http?.path || '/',
      headers: normalizeHeaders(event.headers),
    };
  }

  if (trigger === 'api-gateway-v1') {
    return {
      method: event.httpMethod || event.requestContext?.httpMethod || 'GET',
      path: event.path || event.resource || '/',
      headers: normalizeHeaders(event.headers),
    };
  }

  if (trigger === 'alb') {
    return {
      method: event.httpMethod || 'GET',
      path: event.path || '/',
      headers: normalizeHeaders(event.headers),
    };
  }

  return null;
};

const normalizeHeaders = (headers: any): Record<string, string> => {
  if (!headers || typeof headers !== 'object') return {};
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = String(value);
  }
  return normalized;
};

// ---------------------------------------------------------------------------
// Lambda context attribute extraction
// ---------------------------------------------------------------------------

const extractLambdaAttributes = (
  event: any,
  context: any,
  trigger: LambdaTrigger,
  coldStart: boolean
): Record<string, any> => {
  const attrs: Record<string, any> = {
    'faas.trigger': mapTriggerToFaasTrigger(trigger),
    'faas.coldstart': coldStart,
    'cloud.provider': 'aws',
    'cloud.platform': 'aws_lambda',
    'firebase.service': undefined, // clear any inherited
    library: 'aws-lambda',
  };

  // Lambda context fields
  if (context) {
    if (context.functionName) attrs['faas.name'] = context.functionName;
    if (context.functionVersion) attrs['faas.version'] = context.functionVersion;
    if (context.awsRequestId) attrs['faas.execution'] = context.awsRequestId;
    if (context.invokedFunctionArn) attrs['cloud.resource_id'] = context.invokedFunctionArn;
    if (context.memoryLimitInMB) attrs['faas.max_memory'] = Number(context.memoryLimitInMB);
    if (context.logGroupName) attrs['aws.log.group.names'] = context.logGroupName;
    if (context.logStreamName) attrs['aws.log.stream.names'] = context.logStreamName;
  }

  // Region from environment
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (region) attrs['cloud.region'] = region;

  // Account ID from ARN
  if (context?.invokedFunctionArn) {
    const arnParts = context.invokedFunctionArn.split(':');
    if (arnParts.length >= 5) {
      attrs['cloud.account.id'] = arnParts[4];
    }
  }

  // Trigger-specific attributes
  switch (trigger) {
    case 'sqs':
      if (Array.isArray(event.Records)) {
        attrs['messaging.system'] = 'aws_sqs';
        attrs['messaging.batch.message_count'] = event.Records.length;
        const arnSrc = event.Records[0]?.eventSourceARN;
        if (arnSrc) attrs['messaging.source.name'] = arnSrc.split(':').pop();
      }
      break;

    case 'sns':
      if (Array.isArray(event.Records)) {
        attrs['messaging.system'] = 'aws_sns';
        const topicArn = event.Records[0]?.Sns?.TopicArn;
        if (topicArn) attrs['messaging.source.name'] = topicArn.split(':').pop();
      }
      break;

    case 'dynamodb-streams':
      if (Array.isArray(event.Records)) {
        attrs['aws.dynamodb.table_names'] = [
          ...new Set(
            event.Records
              .map((r: any) => r.eventSourceARN?.split('/')[1])
              .filter(Boolean)
          ),
        ];
        attrs['messaging.batch.message_count'] = event.Records.length;
      }
      break;

    case 's3':
      if (Array.isArray(event.Records) && event.Records[0]?.s3) {
        attrs['aws.s3.bucket'] = event.Records[0].s3.bucket?.name;
        attrs['aws.s3.key'] = event.Records[0].s3.object?.key;
      }
      break;

    case 'eventbridge':
      if (event.source) attrs['aws.eventbridge.source'] = event.source;
      if (event['detail-type']) attrs['aws.eventbridge.detail_type'] = event['detail-type'];
      break;
  }

  return attrs;
};

const mapTriggerToFaasTrigger = (trigger: LambdaTrigger): string => {
  switch (trigger) {
    case 'api-gateway-v1':
    case 'api-gateway-v2':
    case 'alb':
      return 'http';
    case 'sqs':
    case 'sns':
      return 'pubsub';
    case 'dynamodb-streams':
      return 'datasource';
    case 's3':
      return 'datasource';
    case 'eventbridge':
    case 'scheduled':
      return 'timer';
    default:
      return 'other';
  }
};

// ---------------------------------------------------------------------------
// Response status extraction
// ---------------------------------------------------------------------------

const extractStatusFromResponse = (result: any, trigger: LambdaTrigger): number => {
  // HTTP triggers: response has statusCode
  if (
    (trigger === 'api-gateway-v1' || trigger === 'api-gateway-v2' || trigger === 'alb') &&
    result &&
    typeof result === 'object'
  ) {
    return typeof result.statusCode === 'number' ? result.statusCode : 200;
  }

  // Non-HTTP: success = 200
  return 200;
};

// ---------------------------------------------------------------------------
// Lambda Extensions API — internal extension registration
// ---------------------------------------------------------------------------

/**
 * Register as a Lambda internal extension to receive SHUTDOWN events.
 * This is a safety-net: if the process is about to be terminated,
 * we get a last chance to flush telemetry.
 *
 * Only runs when the Lambda Extensions API is available (runtime >= 2020-01-01).
 * Failures are silently ignored — the wrapper's own forced flush is the primary mechanism.
 */
const registerExtension = (() => {
  let registered = false;

  return (onShutdown: () => Promise<void>) => {
    if (registered) return;
    registered = true;

    const runtimeApi = process.env.AWS_LAMBDA_RUNTIME_API;
    if (!runtimeApi) return;

    const extensionName = 'senzor-apm';
    const registerUrl = `http://${runtimeApi}/2020-01-01/extension/register`;

    // Fire-and-forget registration
    (async () => {
      try {
        const registerResponse = await fetch(registerUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Lambda-Extension-Name': extensionName,
          },
          body: JSON.stringify({ events: ['SHUTDOWN'] }),
        });

        if (!registerResponse.ok) return;

        const extensionId = registerResponse.headers.get('Lambda-Extension-Identifier');
        if (!extensionId) return;

        // Event loop: wait for SHUTDOWN
        const nextUrl = `http://${runtimeApi}/2020-01-01/extension/event/next`;

        // This blocks until Lambda sends SHUTDOWN — runs on a background "thread"
        // via the microtask queue; does not block the handler.
        const waitForShutdown = async () => {
          try {
            const eventResponse = await fetch(nextUrl, {
              method: 'GET',
              headers: { 'Lambda-Extension-Identifier': extensionId },
            });

            if (eventResponse.ok) {
              const event = await eventResponse.json() as any;
              if (event.eventType === 'SHUTDOWN') {
                await onShutdown();
              }
            }
          } catch {
            // Extension event loop failure — primary flush in handler covers this
          }
        };

        // Start the event loop (non-blocking)
        waitForShutdown();
      } catch {
        // Registration failure is expected outside Lambda or in older runtimes
      }
    })();
  };
})();

// ---------------------------------------------------------------------------
// Public API: wrapLambda
// ---------------------------------------------------------------------------

type LambdaHandler<TEvent = any, TResult = any> = (
  event: TEvent,
  context: any,
) => Promise<TResult>;

/**
 * Wraps an AWS Lambda handler function with Senzor APM instrumentation.
 *
 * @example
 * ```typescript
 * import Senzor from '@senzor/apm-node';
 *
 * Senzor.init({ apiKey: process.env.SENZOR_API_KEY });
 *
 * export const handler = Senzor.wrapLambda(async (event, context) => {
 *   // Your Lambda logic here
 *   return { statusCode: 200, body: JSON.stringify({ ok: true }) };
 * });
 * ```
 */
export const wrapLambda = <TEvent = any, TResult = any>(
  handler: LambdaHandler<TEvent, TResult>,
): LambdaHandler<TEvent, TResult> => {
  // Register extension on first wrap (idempotent)
  registerExtension(() => client.flush());

  return async (event: TEvent, context: any): Promise<TResult> => {
    const coldStart = isColdStart;
    if (isColdStart) isColdStart = false;

    const trigger = detectTrigger(event);
    const lambdaAttrs = extractLambdaAttributes(event, context, trigger, coldStart);
    const httpInfo = extractHttpEvent(event, trigger);

    // For HTTP triggers, use proper HTTP trace semantics
    const method = httpInfo?.method || trigger.toUpperCase();
    const path = httpInfo?.path || `/${context?.functionName || 'lambda'}`;
    const route = httpInfo ? normalizePath(httpInfo.path) : context?.functionName || 'lambda';
    const headers = httpInfo?.headers || {};

    return client.startTrace(
      {
        method,
        path,
        route,
        ip: httpInfo ? getClientIp({ headers }) : undefined,
        userAgent: headers['user-agent'],
        headers,
        ...lambdaAttrs,
      },
      async () => {
        let status = 500;
        try {
          const result = await handler(event, context);
          status = extractStatusFromResponse(result, trigger);
          return result;
        } catch (err: any) {
          client.captureError(err, {
            'faas.name': context?.functionName,
            'faas.execution': context?.awsRequestId,
            trigger,
          });
          throw err;
        } finally {
          client.endTrace(status, {
            route,
            ...lambdaAttrs,
          });

          // Force flush before Lambda freezes the execution environment.
          // This is critical: Lambda may freeze or terminate the process
          // immediately after the handler returns.
          await client.flush();
        }
      },
    );
  };
};
