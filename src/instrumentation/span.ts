import { Context } from '../core/context';
import { sanitizeAttributes } from '../core/sanitizer';
import { ActiveTrace, SenzorOptions, Span } from '../core/types';
import { generateSpanId } from '../utils/ids';

type SpanType = Span['type'];

export interface CapturedSpan {
  spanId: string;
  parentSpanId?: string;
  trace?: ActiveTrace;
  end: (
    status?: number,
    meta?: Record<string, unknown>
  ) => void;
}

export const startCapturedSpan = (
  name: string,
  type: SpanType,
  meta: Record<string, unknown> = {},
  options?: SenzorOptions
): CapturedSpan | null => {
  const trace = Context.current();
  if (!trace) return null;

  const spanId = generateSpanId();
  const parentSpanId = trace.activeSpanId;
  const startTime = performance.now() - trace.startTime;
  const startedAt = performance.now();
  let ended = false;

  return {
    spanId,
    parentSpanId,
    trace,
    end: (
      status?: number,
      extraMeta: Record<string, unknown> = {}
    ) => {
      if (ended) return;
      ended = true;

      const mergedMeta = sanitizeAttributes(
        {
          ...meta,
          ...extraMeta,
          parentSpanId
        },
        options
      );

      Context.addSpanToTrace(trace, {
        spanId,
        parentSpanId,
        name,
        type,
        startTime,
        duration: performance.now() - startedAt,
        status,
        meta: mergedMeta
      });
    }
  };
};

export const runWithCapturedSpan = <T>(
  span: CapturedSpan | null,
  fn: () => T
): T => {
  if (!span) return fn();
  return Context.withActiveSpan(span.spanId, fn);
};
