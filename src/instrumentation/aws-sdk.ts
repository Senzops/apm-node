import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// AWS SDK v3 Instrumentation
//
// Instruments @aws-sdk/smithy-client (the core of AWS SDK v3) by patching
// the Client.prototype.send() method — the single dispatch point for ALL
// AWS service calls (S3, DynamoDB, SQS, SNS, Lambda, etc.).
//
// Also hooks individual service packages as a fallback, intercepting their
// Client classes directly.
//
// Captured span attributes follow OTel semantic conventions for cloud/AWS:
//   - rpc.system: 'aws-api'
//   - rpc.service: e.g. 'S3', 'DynamoDB'
//   - rpc.method: e.g. 'PutObject', 'GetItem'
//   - aws.region: configured region
//   - aws.request_id: from response metadata
//   - http.response.status_code: HTTP status of the API call
// ---------------------------------------------------------------------------

/** Known AWS service name mappings from client constructor names. */
const SERVICE_NAME_MAP: Record<string, string> = {
  S3Client: 'S3',
  DynamoDBClient: 'DynamoDB',
  SQSClient: 'SQS',
  SNSClient: 'SNS',
  LambdaClient: 'Lambda',
  SESClient: 'SES',
  SESv2Client: 'SESv2',
  CloudWatchClient: 'CloudWatch',
  CloudWatchLogsClient: 'CloudWatchLogs',
  KinesisClient: 'Kinesis',
  EventBridgeClient: 'EventBridge',
  SecretsManagerClient: 'SecretsManager',
  SSMClient: 'SSM',
  STSClient: 'STS',
  IAMClient: 'IAM',
  EC2Client: 'EC2',
  ECSClient: 'ECS',
  EKSClient: 'EKS',
  RDSClient: 'RDS',
  ElastiCacheClient: 'ElastiCache',
  RedshiftClient: 'Redshift',
  CognitoIdentityProviderClient: 'CognitoIdentityProvider',
  Route53Client: 'Route53',
  CloudFrontClient: 'CloudFront',
  APIGatewayClient: 'APIGateway',
  StepFunctionsClient: 'StepFunctions',
  CodeBuildClient: 'CodeBuild',
  CodePipelineClient: 'CodePipeline',
  ACMClient: 'ACM',
  KMSClient: 'KMS',
  BedrockRuntimeClient: 'BedrockRuntime',
};

// ---------------------------------------------------------------------------
// Bedrock Runtime — GenAI attribute extraction
// ---------------------------------------------------------------------------

/** Bedrock model ID patterns for gen_ai.system mapping. */
const BEDROCK_SYSTEM_MAP: Record<string, string> = {
  anthropic: 'anthropic',
  amazon: 'aws_bedrock',
  meta: 'meta',
  cohere: 'cohere',
  mistral: 'mistral',
  ai21: 'ai21',
  stability: 'stability',
};

const getBedrockSystem = (modelId: string | undefined): string => {
  if (!modelId) return 'aws_bedrock';
  const provider = modelId.split('.')[0]?.toLowerCase();
  return BEDROCK_SYSTEM_MAP[provider] || 'aws_bedrock';
};

/** Extract Bedrock-specific attributes from InvokeModel / InvokeModelWithResponseStream commands. */
const extractBedrockAttributes = (command: any, response: any): Record<string, any> => {
  const meta: Record<string, any> = {};
  const input = command?.input;
  if (!input) return meta;

  const modelId = input.modelId;
  if (modelId) {
    meta['gen_ai.system'] = getBedrockSystem(modelId);
    meta['gen_ai.request.model'] = modelId;
  }

  // Try to parse the response body for token usage
  // Bedrock responses are in the 'body' field as a Uint8Array or string
  try {
    let bodyStr: string | undefined;
    if (response?.body) {
      if (typeof response.body === 'string') {
        bodyStr = response.body;
      } else if (response.body instanceof Uint8Array) {
        bodyStr = new TextDecoder().decode(response.body);
      } else if (Buffer.isBuffer(response.body)) {
        bodyStr = response.body.toString('utf-8');
      }
    }

    if (bodyStr) {
      const parsed = JSON.parse(bodyStr);

      // Anthropic Messages API format
      if (parsed.usage) {
        if (parsed.usage.input_tokens !== undefined) {
          meta['gen_ai.usage.input_tokens'] = parsed.usage.input_tokens;
        }
        if (parsed.usage.output_tokens !== undefined) {
          meta['gen_ai.usage.output_tokens'] = parsed.usage.output_tokens;
        }
      }

      // Amazon Titan format
      if (parsed.inputTextTokenCount !== undefined) {
        meta['gen_ai.usage.input_tokens'] = meta['gen_ai.usage.input_tokens'] || parsed.inputTextTokenCount;
      }
      if (parsed.results?.[0]?.tokenCount !== undefined) {
        meta['gen_ai.usage.output_tokens'] = meta['gen_ai.usage.output_tokens'] || parsed.results[0].tokenCount;
      }

      // Cohere format
      if (parsed.meta?.billed_units) {
        meta['gen_ai.usage.input_tokens'] = meta['gen_ai.usage.input_tokens'] || parsed.meta.billed_units.input_tokens;
        meta['gen_ai.usage.output_tokens'] = meta['gen_ai.usage.output_tokens'] || parsed.meta.billed_units.output_tokens;
      }

      // Stop reason / finish reason
      if (parsed.stop_reason) meta['gen_ai.response.finish_reason'] = parsed.stop_reason;
      if (parsed.completionReason) meta['gen_ai.response.finish_reason'] = parsed.completionReason;
    }
  } catch {
    // Body parsing is best-effort — the span still captures the Bedrock call
  }

  return meta;
};

/** Check if a command is a Bedrock model invocation. */
const isBedrockInvocation = (operationName: string): boolean =>
  operationName === 'InvokeModel' ||
  operationName === 'InvokeModelWithResponseStream' ||
  operationName === 'Converse' ||
  operationName === 'ConverseStream';

/** Extract Bedrock Converse API attributes. */
const extractBedrockConverseAttributes = (command: any, response: any): Record<string, any> => {
  const meta: Record<string, any> = {};
  const input = command?.input;
  if (!input) return meta;

  const modelId = input.modelId;
  if (modelId) {
    meta['gen_ai.system'] = getBedrockSystem(modelId);
    meta['gen_ai.request.model'] = modelId;
  }

  // Converse API returns usage directly in the response object
  if (response?.usage) {
    if (response.usage.inputTokens !== undefined) {
      meta['gen_ai.usage.input_tokens'] = response.usage.inputTokens;
    }
    if (response.usage.outputTokens !== undefined) {
      meta['gen_ai.usage.output_tokens'] = response.usage.outputTokens;
    }
    if (response.usage.totalTokens !== undefined) {
      meta['gen_ai.usage.total_tokens'] = response.usage.totalTokens;
    }
  }

  if (response?.stopReason) {
    meta['gen_ai.response.finish_reason'] = response.stopReason;
  }

  return meta;
};

/** Extract service name from client instance or command. */
const getServiceName = (client: any): string => {
  // Try constructor name mapping
  const ctorName = client?.constructor?.name;
  if (ctorName && SERVICE_NAME_MAP[ctorName]) {
    return SERVICE_NAME_MAP[ctorName];
  }

  // Try config.serviceId (AWS SDK v3 standard)
  if (client?.config?.serviceId) {
    return client.config.serviceId;
  }

  // Try middleware stack metadata
  if (client?.middlewareStack?.identify) {
    try {
      const id = client.middlewareStack.identify();
      if (typeof id === 'string' && id.length > 0) {
        return id.split(' ')[0];
      }
    } catch { }
  }

  // Fallback: strip 'Client' suffix from constructor name
  if (ctorName && ctorName.endsWith('Client')) {
    return ctorName.slice(0, -6) || 'AWS';
  }

  return 'AWS';
};

/** Extract operation name from a command object. */
const getOperationName = (command: any): string => {
  const name = command?.constructor?.name;
  if (!name) return 'UnknownCommand';
  // Strip 'Command' suffix: PutObjectCommand → PutObject
  return name.endsWith('Command') ? name.slice(0, -7) : name;
};

/** Extract region from client config. */
const getRegion = async (client: any): Promise<string | undefined> => {
  try {
    const region = client?.config?.region;
    if (typeof region === 'function') {
      return await region();
    }
    return region || undefined;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// Core send() patching
// ---------------------------------------------------------------------------

const patchClientSend = (clientProto: any, options?: SenzorOptions) => {
  if (!clientProto) return;

  patchMethod(
    clientProto,
    'send',
    'senzor.aws-sdk.client.send',
    (original) =>
      function patchedSend(this: any, command: any, ...args: any[]) {
        const serviceName = getServiceName(this);
        const operationName = getOperationName(command);
        const spanName = `AWS ${serviceName} ${operationName}`;

        const span = startCapturedSpan(
          spanName,
          'http',
          {
            'rpc.system': 'aws-api',
            'rpc.service': serviceName,
            'rpc.method': operationName,
            'cloud.provider': 'aws',
            'aws.service': serviceName,
            'aws.operation': operationName,
          },
          options
        );

        if (!span) return original.call(this, command, ...args);

        // Resolve region asynchronously but don't block
        getRegion(this).then((region) => {
          if (region && span) {
            // Region is added on span end via meta
            (span as any).__awsRegion = region;
          }
        }).catch(() => { });

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.call(this, command, ...args);

            if (result && typeof result.then === 'function') {
              return result.then(
                (response: any) => {
                  const statusCode = response?.$metadata?.httpStatusCode;
                  const requestId = response?.$metadata?.requestId;

                  const endMeta: Record<string, any> = {
                    'aws.request_id': requestId,
                    'aws.region': (span as any).__awsRegion,
                    'http.response.status_code': statusCode,
                  };

                  // Bedrock GenAI attribute extraction
                  if (isBedrockInvocation(operationName)) {
                    const op = operationName;
                    const bedrockMeta = (op === 'Converse' || op === 'ConverseStream')
                      ? extractBedrockConverseAttributes(command, response)
                      : extractBedrockAttributes(command, response);
                    Object.assign(endMeta, bedrockMeta);
                  }

                  span.end(
                    statusCode && statusCode >= 400 ? statusCode : 0,
                    endMeta
                  );

                  return response;
                },
                (error: any) => {
                  const statusCode = error?.$metadata?.httpStatusCode || 500;
                  const requestId = error?.$metadata?.requestId;

                  span.end(statusCode, {
                    'error.message': error?.message,
                    'error.type': error?.name || error?.code || 'AwsError',
                    'aws.request_id': requestId,
                    'aws.region': (span as any).__awsRegion,
                    'http.response.status_code': statusCode,
                  });

                  throw error;
                }
              );
            }

            span.end(0);
            return result;
          } catch (error: any) {
            span.end(error?.$metadata?.httpStatusCode || 500, {
              'error.message': error?.message,
              'error.type': error?.name || 'Error',
            });
            throw error;
          }
        });
      }
  );
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Common AWS SDK v3 service packages to instrument. */
const AWS_SERVICE_PACKAGES = [
  '@aws-sdk/client-s3',
  '@aws-sdk/client-dynamodb',
  '@aws-sdk/client-sqs',
  '@aws-sdk/client-sns',
  '@aws-sdk/client-lambda',
  '@aws-sdk/client-ses',
  '@aws-sdk/client-sesv2',
  '@aws-sdk/client-cloudwatch',
  '@aws-sdk/client-cloudwatch-logs',
  '@aws-sdk/client-kinesis',
  '@aws-sdk/client-eventbridge',
  '@aws-sdk/client-secrets-manager',
  '@aws-sdk/client-ssm',
  '@aws-sdk/client-sts',
  '@aws-sdk/client-iam',
  '@aws-sdk/client-ec2',
  '@aws-sdk/client-ecs',
  '@aws-sdk/client-rds',
  '@aws-sdk/client-cognito-identity-provider',
  '@aws-sdk/client-route-53',
  '@aws-sdk/client-cloudfront',
  '@aws-sdk/client-api-gateway',
  '@aws-sdk/client-sfn',
  '@aws-sdk/client-codebuild',
  '@aws-sdk/client-kms',
  '@aws-sdk/client-bedrock-runtime',
];

export const instrumentAwsSdk = (options?: SenzorOptions) => {
  // Primary: patch the smithy Client base class — covers ALL services
  hookRequire('@smithy/smithy-client', (exports: any) => {
    const Client = exports?.Client;
    if (Client?.prototype) {
      patchClientSend(Client.prototype, options);
    }
  });

  // Also try the older @aws-sdk/smithy-client path
  hookRequire('@aws-sdk/smithy-client', (exports: any) => {
    const Client = exports?.Client;
    if (Client?.prototype) {
      patchClientSend(Client.prototype, options);
    }
  });

  // Fallback: hook individual service packages for resilience
  // Only hook a subset of the most common ones to avoid over-registration
  for (const pkg of AWS_SERVICE_PACKAGES) {
    hookRequire(pkg, (exports: any) => {
      // Each package exports a *Client class (e.g., S3Client, DynamoDBClient)
      for (const key of Object.keys(exports)) {
        if (key.endsWith('Client') && exports[key]?.prototype?.send) {
          patchClientSend(exports[key].prototype, options);
        }
      }
    });
  }
};
