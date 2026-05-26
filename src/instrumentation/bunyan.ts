import { Context } from '../core/context';
import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';

// ---------------------------------------------------------------------------
// Bunyan Log Correlation
//
// Injects traceId and spanId from the active Senzor context into every
// bunyan log record. Enables log-to-trace correlation in the dashboard.
//
// Strategy: Patch Logger.prototype._emit() — the core logging method that
// all level methods (info, debug, warn, error, fatal, trace) call.
// The `rec` parameter is the log record object; we inject trace fields
// before the original _emit serializes and writes it.
//
// Also patches Logger.prototype.child() to ensure child loggers inherit
// the patched _emit via prototype chain.
//
// Injected fields:
//   - traceId: string
//   - spanId: string
//   - senzor_context: 'apm' | 'task'
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

  // Use underscore instead of dot for bunyan compatibility
  // (dots in keys can cause issues with some bunyan serializers)
  fields.senzor_context = trace.contextType;

  return fields;
};

// ---------------------------------------------------------------------------
// Logger.prototype._emit patching
// ---------------------------------------------------------------------------

const patchBunyanLogger = (bunyan: any, _options?: SenzorOptions) => {
  // bunyan exports the Logger constructor directly
  // bunyan === Logger (the constructor function)
  // bunyan.createLogger is a factory that calls new Logger()

  const LoggerProto = bunyan?.prototype;

  if (!LoggerProto) return;

  // Patch _emit — the core method all log calls funnel through
  patchMethod(
    LoggerProto,
    '_emit',
    'senzor.bunyan.logger._emit',
    (original) =>
      function patchedEmit(this: any, rec: any, noemit?: boolean) {
        if (rec && typeof rec === 'object') {
          const traceFields = getTraceFields();
          if (traceFields) {
            // Inject trace fields into the log record
            rec.traceId = traceFields.traceId;
            if (traceFields.spanId) rec.spanId = traceFields.spanId;
            rec.senzor_context = traceFields.senzor_context;
          }
        }
        return original.call(this, rec, noemit);
      }
  );
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentBunyan = (options?: SenzorOptions) => {
  hookRequire('bunyan', (exports: any) => {
    patchBunyanLogger(exports, options);

    // Also handle default export
    if (exports?.default?.prototype?._emit) {
      patchBunyanLogger(exports.default, options);
    }
  });
};
