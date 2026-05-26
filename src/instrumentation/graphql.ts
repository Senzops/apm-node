import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// GraphQL Instrumentation
//
// Instruments the `graphql` package at the execution layer, covering:
//   - graphql()        — top-level convenience function
//   - execute()        — execution engine
//   - parse()          — query parsing
//   - validate()       — schema validation
//
// Follows OTel semantic conventions: graphql.operation.name,
// graphql.operation.type, graphql.document, graphql.source
// ---------------------------------------------------------------------------

/** Maximum length of captured GraphQL document to avoid oversized spans. */
const MAX_DOCUMENT_LENGTH = 4096;

/** Safely truncate a GraphQL source document. */
const truncateDocument = (source: string): string => {
  if (!source || typeof source !== 'string') return '';
  if (source.length <= MAX_DOCUMENT_LENGTH) return source;
  return source.slice(0, MAX_DOCUMENT_LENGTH) + '...[truncated]';
};

/**
 * Extract operation metadata (name, type) from a parsed DocumentNode.
 *
 * Handles queries with multiple operation definitions by finding the one
 * matching `operationName`, or falling back to the first definition.
 */
const extractOperationInfo = (
  document: any,
  operationName?: string | null
): { operationType: string; name: string } => {
  const defaultResult = { operationType: 'query', name: operationName || 'anonymous' };

  if (!document || !document.definitions || !Array.isArray(document.definitions)) {
    return defaultResult;
  }

  // Filter to operation definitions
  const operationDefs = document.definitions.filter(
    (def: any) => def.kind === 'OperationDefinition'
  );

  if (operationDefs.length === 0) return defaultResult;

  // Find the matching operation
  let target = operationDefs[0];
  if (operationName) {
    const named = operationDefs.find(
      (def: any) => def.name?.value === operationName
    );
    if (named) target = named;
  }

  return {
    operationType: target.operation || 'query',
    name: target.name?.value || operationName || 'anonymous',
  };
};

/**
 * Extract the source text from a DocumentNode or Source object.
 */
const getSourceText = (document: any): string => {
  if (!document) return '';
  if (typeof document === 'string') return document;
  if (document.loc?.source?.body) return document.loc.source.body;
  if (document.source?.body) return document.source.body;
  return '';
};

/**
 * Check if GraphQL result contains errors.
 */
const hasErrors = (result: any): boolean => {
  return result && Array.isArray(result.errors) && result.errors.length > 0;
};

/**
 * Extract error summary from GraphQL errors array.
 */
const extractErrorSummary = (errors: any[]): string => {
  if (!errors || errors.length === 0) return '';
  const messages = errors
    .slice(0, 5) // Limit to first 5 errors
    .map((e: any) => e.message || String(e))
    .join('; ');
  return messages.length > 1024 ? messages.slice(0, 1024) + '...' : messages;
};

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

const patchGraphQL = (graphql: any, options?: SenzorOptions) => {
  if (!graphql) return;

  // Patch the top-level graphql() convenience function
  patchMethod(
    graphql,
    'graphql',
    'senzor.graphql.graphql',
    (original) =>
      function patchedGraphqlFn(this: any, ...args: any[]) {
        // graphql(schema, source, rootValue, contextValue, variableValues, operationName)
        // or graphql({ schema, source, rootValue, ... })
        let source: string | undefined;
        let operationName: string | undefined;
        let document: any;

        if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
          // Object form
          source = args[0].source;
          operationName = args[0].operationName;
        } else {
          source = args[1];
          operationName = args[5];
        }

        const span = startCapturedSpan(
          `GraphQL ${operationName || 'query'}`,
          'custom',
          {
            'graphql.operation.name': operationName || 'anonymous',
            'graphql.source': source ? truncateDocument(source) : undefined,
          },
          options
        );

        if (!span) return original.apply(this, args);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.apply(this, args);

            if (result && typeof result.then === 'function') {
              return result.then(
                (res: any) => {
                  if (hasErrors(res)) {
                    span.end(500, {
                      'graphql.error_count': res.errors.length,
                      'error.message': extractErrorSummary(res.errors),
                    });
                  } else {
                    span.end(0);
                  }
                  return res;
                },
                (error: any) => {
                  span.end(500, {
                    'error.message': error?.message,
                    'error.type': error?.name || 'GraphQLError',
                  });
                  throw error;
                }
              );
            }

            if (hasErrors(result)) {
              span.end(500, {
                'graphql.error_count': result.errors.length,
                'error.message': extractErrorSummary(result.errors),
              });
            } else {
              span.end(0);
            }
            return result;
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

  // Patch execute()
  patchMethod(
    graphql,
    'execute',
    'senzor.graphql.execute',
    (original) =>
      function patchedExecute(this: any, ...args: any[]) {
        // execute(schema, document, rootValue, contextValue, variableValues, operationName)
        // or execute({ schema, document, ... })
        let document: any;
        let operationName: string | undefined;

        if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
          document = args[0].document;
          operationName = args[0].operationName;
        } else {
          document = args[1];
          operationName = args[5];
        }

        const opInfo = extractOperationInfo(document, operationName);
        const sourceText = getSourceText(document);

        const span = startCapturedSpan(
          `GraphQL execute ${opInfo.operationType} ${opInfo.name}`,
          'custom',
          {
            'graphql.operation.name': opInfo.name,
            'graphql.operation.type': opInfo.operationType,
            'graphql.document': truncateDocument(sourceText),
          },
          options
        );

        if (!span) return original.apply(this, args);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.apply(this, args);

            if (result && typeof result.then === 'function') {
              return result.then(
                (res: any) => {
                  if (hasErrors(res)) {
                    span.end(500, {
                      'graphql.error_count': res.errors.length,
                      'error.message': extractErrorSummary(res.errors),
                    });
                  } else {
                    span.end(0);
                  }
                  return res;
                },
                (error: any) => {
                  span.end(500, {
                    'error.message': error?.message,
                    'error.type': error?.name || 'GraphQLError',
                  });
                  throw error;
                }
              );
            }

            if (hasErrors(result)) {
              span.end(500, {
                'graphql.error_count': result.errors.length,
                'error.message': extractErrorSummary(result.errors),
              });
            } else {
              span.end(0);
            }
            return result;
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

  // Patch parse()
  patchMethod(
    graphql,
    'parse',
    'senzor.graphql.parse',
    (original) =>
      function patchedParse(this: any, source: any, ...args: any[]) {
        const sourceText = typeof source === 'string'
          ? source
          : source?.body || '';

        const span = startCapturedSpan(
          'GraphQL parse',
          'custom',
          {
            'graphql.operation': 'parse',
            'graphql.source': truncateDocument(sourceText),
          },
          options
        );

        if (!span) return original.call(this, source, ...args);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.call(this, source, ...args);
            span.end(0);
            return result;
          } catch (error: any) {
            span.end(500, {
              'error.message': error?.message,
              'error.type': error?.name || 'GraphQLError',
              'graphql.error_count': 1,
            });
            throw error;
          }
        });
      }
  );

  // Patch validate()
  patchMethod(
    graphql,
    'validate',
    'senzor.graphql.validate',
    (original) =>
      function patchedValidate(this: any, schema: any, documentAST: any, ...args: any[]) {
        const span = startCapturedSpan(
          'GraphQL validate',
          'custom',
          {
            'graphql.operation': 'validate',
          },
          options
        );

        if (!span) return original.call(this, schema, documentAST, ...args);

        return runWithCapturedSpan(span, () => {
          try {
            const errors = original.call(this, schema, documentAST, ...args);

            if (Array.isArray(errors) && errors.length > 0) {
              span.end(500, {
                'graphql.error_count': errors.length,
                'error.message': extractErrorSummary(errors),
              });
            } else {
              span.end(0);
            }

            return errors;
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentGraphQL = (options?: SenzorOptions) => {
  hookRequire('graphql', (exports: any) => patchGraphQL(exports, options));

  // Also try graphql/execution for cases where execute is imported directly
  hookRequire('graphql/execution', (exports: any) => {
    if (exports?.execute) {
      patchMethod(
        exports,
        'execute',
        'senzor.graphql.execution.execute',
        (original) => {
          // Reuse the same logic
          return function patchedDirectExecute(this: any, ...args: any[]) {
            let document: any;
            let operationName: string | undefined;

            if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
              document = args[0].document;
              operationName = args[0].operationName;
            } else {
              document = args[1];
              operationName = args[5];
            }

            const opInfo = extractOperationInfo(document, operationName);
            const sourceText = getSourceText(document);

            const span = startCapturedSpan(
              `GraphQL execute ${opInfo.operationType} ${opInfo.name}`,
              'custom',
              {
                'graphql.operation.name': opInfo.name,
                'graphql.operation.type': opInfo.operationType,
                'graphql.document': truncateDocument(sourceText),
              },
              options
            );

            if (!span) return original.apply(this, args);

            return runWithCapturedSpan(span, () => {
              try {
                const result = original.apply(this, args);
                if (result && typeof result.then === 'function') {
                  return result.then(
                    (res: any) => {
                      if (hasErrors(res)) {
                        span.end(500, {
                          'graphql.error_count': res.errors.length,
                          'error.message': extractErrorSummary(res.errors),
                        });
                      } else {
                        span.end(0);
                      }
                      return res;
                    },
                    (error: any) => {
                      span.end(500, { 'error.message': error?.message });
                      throw error;
                    }
                  );
                }
                if (hasErrors(result)) {
                  span.end(500, { 'graphql.error_count': result.errors.length });
                } else {
                  span.end(0);
                }
                return result;
              } catch (error: any) {
                span.end(500, { 'error.message': error?.message });
                throw error;
              }
            });
          };
        }
      );
    }
  });
};
