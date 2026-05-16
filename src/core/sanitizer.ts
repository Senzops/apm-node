import { SenzorOptions } from './types';

const DEFAULT_MAX_ATTRIBUTES = 64;
const DEFAULT_MAX_ATTRIBUTE_LENGTH = 2048;
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;

const SENSITIVE_KEY_PATTERN =
  /(^|[-_.])(authorization|cookie|set-cookie|password|passwd|pwd|secret|token|api[-_.]?key|x-api-key|access[-_.]?token|refresh[-_.]?token|client[-_.]?secret|private[-_.]?key)([-_.]|$)/i;

export interface SanitizerOptions {
  maxAttributes?: number;
  maxAttributeLength?: number;
}

const getLimits = (options?: SanitizerOptions | SenzorOptions) => ({
  maxAttributes: options?.maxAttributes ?? DEFAULT_MAX_ATTRIBUTES,
  maxAttributeLength:
    options?.maxAttributeLength ?? DEFAULT_MAX_ATTRIBUTE_LENGTH
});

export const truncate = (
  value: string,
  maxLength = DEFAULT_MAX_ATTRIBUTE_LENGTH
): string => {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 15))}...[truncated]`;
};

export const isSensitiveKey = (key: string): boolean =>
  SENSITIVE_KEY_PATTERN.test(key);

const sanitizePrimitive = (
  value: unknown,
  maxLength: number
): string | number | boolean | null | undefined => {
  if (value === null || value === undefined) return value;

  if (
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'string') {
    return truncate(value, maxLength);
  }

  return undefined;
};

const sanitizeValue = (
  key: string,
  value: unknown,
  options: Required<SanitizerOptions>,
  depth: number
): unknown => {
  if (isSensitiveKey(key)) return '[REDACTED]';

  const primitive =
    sanitizePrimitive(value, options.maxAttributeLength);

  if (primitive !== undefined || value === undefined) {
    return primitive;
  }

  if (value instanceof Error) {
    return {
      name: truncate(value.name, options.maxAttributeLength),
      message: truncate(value.message, options.maxAttributeLength),
      stack: value.stack
        ? truncate(value.stack, options.maxAttributeLength)
        : undefined
    };
  }

  if (depth >= MAX_DEPTH) {
    return '[MaxDepth]';
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) =>
        sanitizeValue(key, item, options, depth + 1)
      );
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    let count = 0;

    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (count >= options.maxAttributes) {
        output.__truncated = true;
        break;
      }

      output[childKey] = sanitizeValue(
        childKey,
        childValue,
        options,
        depth + 1
      );
      count++;
    }

    return output;
  }

  return truncate(String(value), options.maxAttributeLength);
};

export const sanitizeAttributes = (
  attributes: Record<string, unknown> = {},
  options?: SanitizerOptions | SenzorOptions
): Record<string, unknown> => {
  const limits = getLimits(options);
  const normalizedOptions: Required<SanitizerOptions> = {
    maxAttributes: limits.maxAttributes,
    maxAttributeLength: limits.maxAttributeLength
  };

  const output: Record<string, unknown> = {};
  let count = 0;

  for (const [key, value] of Object.entries(attributes)) {
    if (count >= normalizedOptions.maxAttributes) {
      output.__truncated = true;
      break;
    }

    output[key] = sanitizeValue(
      key,
      value,
      normalizedOptions,
      0
    );
    count++;
  }

  return output;
};

export const sanitizeHeaders = (
  headers: unknown,
  options?: SanitizerOptions | SenzorOptions
): Record<string, unknown> => {
  if (!headers || typeof headers !== 'object') return {};

  const plainHeaders: Record<string, unknown> = {};

  if (typeof (headers as any).forEach === 'function') {
    (headers as any).forEach((value: unknown, key: string) => {
      plainHeaders[key.toLowerCase()] = value;
    });
  } else {
    for (const [key, value] of Object.entries(
      headers as Record<string, unknown>
    )) {
      plainHeaders[key.toLowerCase()] = Array.isArray(value)
        ? value.join(', ')
        : value;
    }
  }

  return sanitizeAttributes(plainHeaders, options);
};

export const normalizeSql = (
  sql: unknown,
  options?: SenzorOptions
): string | undefined => {
  if (typeof sql !== 'string') return undefined;

  const collapsed = sql.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;

  const withoutLiterals = collapsed
    .replace(/'(?:''|[^'])*'/g, '?')
    .replace(/"(?:\\"|[^"])*"/g, '?')
    .replace(/\b\d+(\.\d+)?\b/g, '?');

  return truncate(
    options?.captureDbStatement === false
      ? withoutLiterals.split(' ').slice(0, 6).join(' ')
      : withoutLiterals,
    options?.maxAttributeLength ?? DEFAULT_MAX_ATTRIBUTE_LENGTH
  );
};

export const getSqlOperation = (sql: unknown): string | undefined => {
  if (typeof sql !== 'string') return undefined;
  const match = sql.trim().match(/^([a-z]+)/i);
  return match?.[1]?.toUpperCase();
};
