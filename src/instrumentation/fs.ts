import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// File System (fs) Instrumentation
//
// Instruments Node.js core `fs` module to capture file I/O operations.
// File system calls are a common source of latency in Node.js applications
// (template rendering, config loading, log writing, file uploads, etc.).
//
// Only instruments ASYNC methods (callback + promises) — never sync methods,
// as those block the event loop and adding span overhead would be wasteful.
//
// Patches:
//   - Callback-based: fs.readFile, fs.writeFile, fs.stat, fs.access,
//     fs.readdir, fs.mkdir, fs.rmdir, fs.unlink, fs.rename, fs.copyFile,
//     fs.appendFile, fs.chmod, fs.chown, fs.link, fs.symlink, fs.realpath,
//     fs.mkdtemp, fs.open, fs.close
//   - Promise-based: fs.promises.* (same set)
//
// Captured attributes:
//   - fs.operation: readFile, writeFile, stat, etc.
//   - fs.path: file path (sanitized — no secrets in paths)
//   - fs.flags: open flags (r, w, a, etc.)
// ---------------------------------------------------------------------------

/** Operations to instrument. Grouped by argument patterns. */
const PATH_OPERATIONS = [
  'readFile', 'writeFile', 'appendFile', 'stat', 'lstat',
  'access', 'readdir', 'mkdir', 'rmdir', 'unlink',
  'chmod', 'chown', 'realpath', 'mkdtemp', 'truncate',
  'readlink', 'exists',
] as const;

const TWO_PATH_OPERATIONS = [
  'rename', 'copyFile', 'link', 'symlink',
] as const;

/** Sanitize a file path — strip home directory prefix for privacy. */
const sanitizePath = (filePath: any): string | undefined => {
  if (typeof filePath !== 'string' && !(filePath instanceof Buffer) && !(filePath instanceof URL)) {
    return undefined;
  }
  const pathStr = String(filePath);
  // Truncate very long paths
  if (pathStr.length > 200) return pathStr.slice(0, 200) + '...';
  return pathStr;
};

// ---------------------------------------------------------------------------
// Callback-based fs method patching
// ---------------------------------------------------------------------------

const patchFsCallbackMethod = (
  fsModule: any,
  methodName: string,
  pathArgCount: number,
  options?: SenzorOptions
) => {
  if (typeof fsModule[methodName] !== 'function') return;

  patchMethod(
    fsModule,
    methodName,
    `senzor.fs.${methodName}`,
    (original) =>
      function patchedFsMethod(this: any, ...args: any[]) {
        const operation = methodName.toUpperCase();
        const filePath = sanitizePath(args[0]);

        const spanMeta: Record<string, any> = {
          'fs.operation': methodName,
          'fs.path': filePath,
          library: 'fs',
        };

        if (pathArgCount === 2 && args[1]) {
          spanMeta['fs.destination'] = sanitizePath(args[1]);
        }

        const span = startCapturedSpan(
          `FS ${operation}`,
          'custom',
          spanMeta,
          options
        );

        if (!span) return original.apply(this, args);

        // Find and wrap the callback (last function argument)
        const callbackIndex = args.findIndex(
          (arg, idx) => idx >= pathArgCount && typeof arg === 'function'
        );

        if (callbackIndex >= 0) {
          const originalCb = args[callbackIndex];
          args[callbackIndex] = function (err: any, ...results: any[]) {
            if (err) {
              span.end(500, {
                'error.message': err.message,
                'error.type': err.name || 'Error',
                'error.code': err.code,
              });
            } else {
              span.end(0);
            }
            return originalCb.call(this, err, ...results);
          };
        }

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.apply(this, args);

            // If no callback found, end span after sync return
            if (callbackIndex < 0) {
              span.end(0);
            }

            return result;
          } catch (error: any) {
            span.end(500, {
              'error.message': error?.message,
              'error.code': error?.code,
            });
            throw error;
          }
        });
      }
  );
};

// ---------------------------------------------------------------------------
// Promise-based fs.promises method patching
// ---------------------------------------------------------------------------

const patchFsPromiseMethod = (
  fsPromises: any,
  methodName: string,
  pathArgCount: number,
  options?: SenzorOptions
) => {
  if (typeof fsPromises[methodName] !== 'function') return;

  patchMethod(
    fsPromises,
    methodName,
    `senzor.fs.promises.${methodName}`,
    (original) =>
      function patchedFsPromiseMethod(this: any, ...args: any[]) {
        const operation = methodName.toUpperCase();
        const filePath = sanitizePath(args[0]);

        const spanMeta: Record<string, any> = {
          'fs.operation': methodName,
          'fs.path': filePath,
          'fs.api': 'promises',
          library: 'fs',
        };

        if (pathArgCount === 2 && args[1]) {
          spanMeta['fs.destination'] = sanitizePath(args[1]);
        }

        const span = startCapturedSpan(
          `FS ${operation}`,
          'custom',
          spanMeta,
          options
        );

        if (!span) return original.apply(this, args);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.apply(this, args);

            if (result && typeof result.then === 'function') {
              return result.then(
                (value: any) => { span.end(0); return value; },
                (error: any) => {
                  span.end(500, {
                    'error.message': error?.message,
                    'error.code': error?.code,
                  });
                  throw error;
                }
              );
            }

            span.end(0);
            return result;
          } catch (error: any) {
            span.end(500, { 'error.message': error?.message });
            throw error;
          }
        });
      }
  );
};

// ---------------------------------------------------------------------------
// Core fs module patching
// ---------------------------------------------------------------------------

const patchFs = (fsModule: any, options?: SenzorOptions) => {
  if (!fsModule) return;

  // Patch callback-based methods (single path argument)
  for (const method of PATH_OPERATIONS) {
    patchFsCallbackMethod(fsModule, method, 1, options);
  }

  // Patch callback-based methods (two path arguments)
  for (const method of TWO_PATH_OPERATIONS) {
    patchFsCallbackMethod(fsModule, method, 2, options);
  }

  // Patch open/close separately (they have different signatures)
  patchFsCallbackMethod(fsModule, 'open', 1, options);
  patchFsCallbackMethod(fsModule, 'close', 1, options);

  // Patch fs.promises
  const promises = fsModule.promises;
  if (promises) {
    for (const method of PATH_OPERATIONS) {
      if (method === 'exists') continue; // fs.promises.exists doesn't exist
      patchFsPromiseMethod(promises, method, 1, options);
    }

    for (const method of TWO_PATH_OPERATIONS) {
      patchFsPromiseMethod(promises, method, 2, options);
    }

    patchFsPromiseMethod(promises, 'open', 1, options);
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentFs = (options?: SenzorOptions) => {
  // fs is a Node.js built-in — require it directly
  try {
    const fs = require('fs');
    patchFs(fs, options);
  } catch { }

  // Also hook for any dynamic requires
  hookRequire('fs', (exports: any) => {
    patchFs(exports, options);
  });

  hookRequire('node:fs', (exports: any) => {
    patchFs(exports, options);
  });
};
