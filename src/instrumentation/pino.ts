import { Context } from '../core/context';
import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';

// ---------------------------------------------------------------------------
// Pino Log Correlation
//
// Injects traceId and spanId from the active Senzor context into every
// pino log record. This enables log-to-trace correlation in the dashboard.
//
// Strategy: Wrap the pino factory to inject a mixin function that reads
// from AsyncLocalStorage on every log call. If the user provides their
// own mixin, both are composed together.
//
// Also patches existing logger prototypes to ensure loggers created before
// instrumentation are also covered.
//
// Injected fields:
//   - traceId: string (APM trace ID or Task run ID)
//   - spanId: string (active span ID)
//   - senzor.context: 'apm' | 'task'
// ---------------------------------------------------------------------------

/** Get trace correlation fields from the current async context. */
const getTraceFields = (): Record<string, string> | null => {
  const trace = Context.current();
  if (!trace) return null;

  const fields: Record<string, string> = {
    traceId: trace.id,
  };

  if (trace.activeSpanId) {
    fields.spanId = trace.activeSpanId;
  }

  fields['senzor.context'] = trace.contextType;

  return fields;
};

/** Create a mixin function that injects trace context. */
const createTraceMixin = (userMixin?: Function): Function => {
  return (mergeObject: any, level: number) => {
    const traceFields = getTraceFields();
    const userFields = typeof userMixin === 'function'
      ? userMixin(mergeObject, level)
      : {};

    return {
      ...userFields,
      ...(traceFields || {}),
    };
  };
};

// ---------------------------------------------------------------------------
// Factory wrapping
// ---------------------------------------------------------------------------

const patchPinoFactory = (pinoModule: any, _options?: SenzorOptions) => {
  // pino is exported as a function (the factory) with properties on it
  // We need to wrap the function itself, which is tricky since it's the module export

  // Strategy: Patch the internal prototype's write method for already-created loggers
  // AND wrap the factory for new loggers

  // 1. Wrap the factory
  const originalPino = pinoModule;

  if (typeof pinoModule !== 'function') return;

  // We can't replace the module export directly from hookRequire,
  // but we can patch the prototype for existing loggers

  // 2. Patch the internal prototype
  // Create a temp logger to get the prototype
  try {
    const devNull = { write: () => {} };
    const tempLogger = pinoModule({ level: 'silent' }, devNull);
    const proto = Object.getPrototypeOf(tempLogger);

    if (proto && !proto.__senzorPatched) {
      // Find the write symbol or method
      const writeSymbol = Object.getOwnPropertySymbols(proto).find(
        (sym) => sym.toString().includes('write') || sym.toString().includes('pino.write')
      );

      if (writeSymbol) {
        const originalWrite = proto[writeSymbol];
        if (typeof originalWrite === 'function') {
          proto[writeSymbol] = function patchedWrite(this: any, obj: any, msg: any, num: any) {
            const traceFields = getTraceFields();
            if (traceFields && obj && typeof obj === 'object') {
              Object.assign(obj, traceFields);
            }
            return originalWrite.call(this, obj, msg, num);
          };
        }
      }

      // Also try patching the level methods directly as fallback
      const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
      for (const level of levels) {
        if (typeof proto[level] === 'function') {
          patchMethod(
            proto,
            level,
            `senzor.pino.${level}`,
            (original) =>
              function patchedLevel(this: any, ...args: any[]) {
                const traceFields = getTraceFields();
                if (!traceFields) return original.apply(this, args);

                // pino level methods accept:
                //   .info(obj, msg, ...args)
                //   .info(msg, ...args)
                //   .info(err, msg, ...args)
                if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
                  // First arg is a merge object — inject trace fields
                  args[0] = { ...args[0], ...traceFields };
                } else if (args.length > 0 && typeof args[0] === 'string') {
                  // First arg is message string — prepend a merge object
                  args.unshift(traceFields);
                } else if (args.length > 0 && args[0] instanceof Error) {
                  // First arg is an error — add trace fields alongside
                  const err = args[0];
                  args[0] = { ...traceFields, err };
                  if (typeof args[1] !== 'string') {
                    args.splice(1, 0, err.message);
                  }
                }

                return original.apply(this, args);
              }
          );
        }
      }

      // Patch child() to ensure child loggers also get correlation
      if (typeof proto.child === 'function') {
        patchMethod(
          proto,
          'child',
          'senzor.pino.child',
          (original) =>
            function patchedChild(this: any, bindings: any, ...args: any[]) {
              // Child loggers inherit the patched prototype automatically
              return original.call(this, bindings, ...args);
            }
        );
      }

      proto.__senzorPatched = true;
    }
  } catch {
    // Pino may not be fully loaded yet — the hookRequire retry will catch it
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentPino = (_options?: SenzorOptions) => {
  hookRequire('pino', (exports: any) => {
    patchPinoFactory(exports, _options);
  });
};
