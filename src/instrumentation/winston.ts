import { Context } from '../core/context';
import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';

// ---------------------------------------------------------------------------
// Winston Log Correlation
//
// Injects traceId and spanId from the active Senzor context into every
// winston log entry. Enables log-to-trace correlation in the dashboard.
//
// Strategy: Patch Logger.prototype.write() to inject trace fields into
// the info object before it flows to transports. This covers all log
// methods (info, error, warn, debug, etc.) since they all call write().
//
// Injected fields:
//   - traceId: string
//   - spanId: string
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

// ---------------------------------------------------------------------------
// Logger.prototype.write patching
// ---------------------------------------------------------------------------

const patchWinstonLogger = (winston: any, _options?: SenzorOptions) => {
  // winston exports createLogger, Logger, etc.
  // Logger is at winston.Logger or winston.transports (for older versions)

  // Try to get Logger from several locations
  let LoggerClass = winston?.Logger;

  // In winston 3.x, Logger is also accessible via the createLogger factory
  if (!LoggerClass) {
    try {
      const loggerModule = require('winston/lib/winston/logger');
      LoggerClass = loggerModule?.Logger || loggerModule;
    } catch { }
  }

  if (!LoggerClass?.prototype) return;

  // Patch write() — the core method all log calls funnel through
  patchMethod(
    LoggerClass.prototype,
    'write',
    'senzor.winston.logger.write',
    (original) =>
      function patchedWrite(this: any, info: any) {
        if (info && typeof info === 'object') {
          const traceFields = getTraceFields();
          if (traceFields) {
            // Inject trace fields into the info object
            // Use non-enumerable setter to avoid conflicts with symbols
            info.traceId = traceFields.traceId;
            if (traceFields.spanId) info.spanId = traceFields.spanId;
            info['senzor.context'] = traceFields['senzor.context'];
          }
        }
        return original.call(this, info);
      }
  );

  // Also patch log() as a safety net for custom transports that call log directly
  patchMethod(
    LoggerClass.prototype,
    'log',
    'senzor.winston.logger.log',
    (original) =>
      function patchedLog(this: any, ...args: any[]) {
        // log() normalizes args into an info object, then calls write()
        // Since write() is already patched, we just need to ensure the
        // info object exists for direct log() calls with string args
        //
        // log(level, message) or log({ level, message }) or log(info)
        const traceFields = getTraceFields();

        if (traceFields && args.length > 0) {
          // If first arg is an info-like object, inject directly
          if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
            args[0] = { ...args[0], ...traceFields };
          }
          // For other signatures, write() patch handles it
        }

        return original.apply(this, args);
      }
  );
};

// ---------------------------------------------------------------------------
// createLogger wrapping
// ---------------------------------------------------------------------------

const patchCreateLogger = (winston: any, _options?: SenzorOptions) => {
  if (typeof winston?.createLogger !== 'function') return;

  patchMethod(
    winston,
    'createLogger',
    'senzor.winston.createLogger',
    (original) =>
      function patchedCreateLogger(this: any, opts: any) {
        const logger = original.call(this, opts);

        // Ensure the logger instance has patched write/log
        // (in case the prototype wasn't patched yet)
        if (logger && !logger.__senzorPatched) {
          const proto = Object.getPrototypeOf(logger);
          if (proto && !proto.__senzorPatched) {
            patchWinstonLogger({ Logger: { prototype: proto } }, _options);
            proto.__senzorPatched = true;
          }
          logger.__senzorPatched = true;
        }

        return logger;
      }
  );
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentWinston = (options?: SenzorOptions) => {
  hookRequire('winston', (exports: any) => {
    patchWinstonLogger(exports, options);
    patchCreateLogger(exports, options);
  });
};
