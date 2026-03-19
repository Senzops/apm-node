/**
 * W3C Trace Context Implementation
 * Standard: https://www.w3.org/TR/trace-context/
 * Format: 00-{traceId}-{spanId}-{traceFlags}
 */

export interface TraceContext {
  traceId: string;
  parentSpanId: string;
  sampled: boolean;
}

const TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export const parseTraceparent = (header?: string | string[]): TraceContext | null => {
  if (!header) return null;

  const traceparent = Array.isArray(header) ? header[0] : header;
  if (typeof traceparent !== 'string') return null;

  const match = traceparent.trim().toLowerCase().match(TRACEPARENT_REGEX);
  if (!match) return null;

  const traceId = match[1];
  const parentSpanId = match[2];
  const flags = match[3];

  // Invalid IDs according to W3C specification
  if (traceId === '00000000000000000000000000000000') return null;
  if (parentSpanId === '0000000000000000') return null;

  // The least significant bit of flags indicates if the trace is sampled
  const sampled = (parseInt(flags, 16) & 0x01) === 0x01;

  return { traceId, parentSpanId, sampled };
};

/**
 * Generates a valid W3C traceparent header string for OUTGOING requests.
 */
export const generateTraceparent = (traceId: string, spanId: string, sampled: boolean = true): string => {
  const flags = sampled ? '01' : '00';
  return `00-${traceId}-${spanId}-${flags}`;
};