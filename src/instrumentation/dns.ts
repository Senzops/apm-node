import { SenzorOptions } from '../core/types';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// DNS Instrumentation
//
// Instruments Node.js core `dns` module:
//   - dns.lookup()        — resolves a hostname to an address (uses OS resolver)
//   - dns.resolve()       — resolves using DNS protocol (network call)
//   - dns.resolve4()      — A records
//   - dns.resolve6()      — AAAA records
//   - dns.resolveMx()     — MX records
//   - dns.resolveTxt()    — TXT records
//   - dns.resolveSrv()    — SRV records
//   - dns.resolveCname()  — CNAME records
//   - dns.resolveNs()     — NS records
//   - dns.reverse()       — reverse DNS lookup
//
// Follows OTel semantic conventions: dns.hostname, network.peer.address
// ---------------------------------------------------------------------------

/**
 * Patch a single DNS method that accepts (hostname, [options], callback).
 */
const patchDnsMethod = (
  dnsModule: any,
  methodName: string,
  options?: SenzorOptions
) => {
  patchMethod(
    dnsModule,
    methodName,
    `senzor.dns.${methodName}`,
    (original) =>
      function patchedDnsMethod(this: any, ...args: any[]) {
        // Extract hostname (always the first argument)
        const hostname = typeof args[0] === 'string' ? args[0] : 'unknown';

        const span = startCapturedSpan(
          `DNS ${methodName}`,
          'custom',
          {
            'dns.hostname': hostname,
            'dns.operation': methodName,
          },
          options
        );

        if (!span) return original.apply(this, args);

        // Find and wrap the callback (always the last argument)
        const callbackIdx = args.findIndex(
          (arg: any, idx: number) => typeof arg === 'function' && idx === args.length - 1
        );

        if (callbackIdx >= 0) {
          const originalCallback = args[callbackIdx];
          args[callbackIdx] = function wrappedDnsCallback(
            err: NodeJS.ErrnoException | null,
            ...results: any[]
          ) {
            if (err) {
              span.end(500, {
                'error.message': err.message,
                'error.type': err.code || err.name || 'DnsError',
                'dns.error_code': err.code,
              });
            } else {
              // For lookup, first result is address, second is family
              const meta: Record<string, any> = {};
              if (methodName === 'lookup' && results[0]) {
                meta['network.peer.address'] = results[0];
                meta['dns.address_family'] = results[1] === 6 ? 'IPv6' : 'IPv4';
              } else if (methodName === 'resolve4' || methodName === 'resolve6') {
                meta['dns.result_count'] = Array.isArray(results[0]) ? results[0].length : 0;
              } else if (methodName === 'resolve') {
                meta['dns.result_count'] = Array.isArray(results[0]) ? results[0].length : 0;
              }
              span.end(0, meta);
            }
            return originalCallback.call(this, err, ...results);
          };
        }

        return runWithCapturedSpan(span, () => {
          try {
            return original.apply(this, args);
          } catch (error: any) {
            span.end(500, {
              'error.message': error?.message,
              'error.type': error?.name || 'Error',
            });
            throw error;
          }
        });
      }
  );
};

/**
 * Patch dns.promises methods (returns promises instead of using callbacks).
 */
const patchDnsPromisesMethod = (
  promises: any,
  methodName: string,
  options?: SenzorOptions
) => {
  patchMethod(
    promises,
    methodName,
    `senzor.dns.promises.${methodName}`,
    (original) =>
      function patchedDnsPromiseMethod(this: any, ...args: any[]) {
        const hostname = typeof args[0] === 'string' ? args[0] : 'unknown';

        const span = startCapturedSpan(
          `DNS ${methodName}`,
          'custom',
          {
            'dns.hostname': hostname,
            'dns.operation': methodName,
          },
          options
        );

        if (!span) return original.apply(this, args);

        return runWithCapturedSpan(span, async () => {
          try {
            const result = await original.apply(this, args);

            const meta: Record<string, any> = {};
            if (methodName === 'lookup' && result) {
              meta['network.peer.address'] = result.address;
              meta['dns.address_family'] = result.family === 6 ? 'IPv6' : 'IPv4';
            } else if (Array.isArray(result)) {
              meta['dns.result_count'] = result.length;
            }

            span.end(0, meta);
            return result;
          } catch (error: any) {
            span.end(500, {
              'error.message': error?.message,
              'error.type': error?.code || error?.name || 'DnsError',
              'dns.error_code': error?.code,
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

export const instrumentDns = (options?: SenzorOptions) => {
  let dns: any;
  try {
    dns = require('dns');
  } catch {
    return;
  }

  if (!dns) return;

  // Callback-based methods
  const callbackMethods = [
    'lookup',
    'resolve',
    'resolve4',
    'resolve6',
    'resolveMx',
    'resolveTxt',
    'resolveSrv',
    'resolveCname',
    'resolveNs',
    'resolvePtr',
    'resolveSoa',
    'resolveNaptr',
    'resolveCaa',
    'reverse',
  ];

  for (const method of callbackMethods) {
    if (typeof dns[method] === 'function') {
      patchDnsMethod(dns, method, options);
    }
  }

  // Promise-based methods (dns.promises / dns/promises)
  const promises = dns.promises;
  if (promises) {
    const promiseMethods = [
      'lookup',
      'resolve',
      'resolve4',
      'resolve6',
      'resolveMx',
      'resolveTxt',
      'resolveSrv',
      'resolveCname',
      'resolveNs',
      'resolvePtr',
      'resolveSoa',
      'resolveNaptr',
      'resolveCaa',
      'reverse',
    ];

    for (const method of promiseMethods) {
      if (typeof promises[method] === 'function') {
        patchDnsPromisesMethod(promises, method, options);
      }
    }
  }
};
