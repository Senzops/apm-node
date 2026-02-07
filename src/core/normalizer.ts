/**
 * Heuristic URL Normalizer
 * Converts raw paths with IDs into generic patterns to prevent high cardinality.
 * Example: /users/123/orders/abc-def -> /users/:id/orders/:uuid
 */
export const normalizePath = (path: string): string => {
  if (!path || path === '/') return '/';

  return path
    // Replace UUIDs (long alphanumeric strings)
    .replace(
      /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
      ':uuid'
    )
    // Replace MongoDB ObjectIds (24 hex chars)
    .replace(/[0-9a-fA-F]{24}/g, ':objectId')
    // Replace pure numeric IDs (e.g., /123)
    .replace(/\/(\d+)(?=\/|$)/g, '/:id')
    // Remove query strings
    .split('?')[0];
};

/**
 * Tries to extract route from Framework internals, falls back to heuristic
 */
export const getRoute = (req: any, fallbackPath: string): string => {
  // Express / Connect
  if (req.route && req.route.path) {
    return (req.baseUrl || '') + req.route.path;
  }

  // H3 / Nitro (Nuxt)
  if (req.context && req.context.matchedRoute) {
    return req.context.matchedRoute.path;
  }

  // Fastify
  if (req.routerPath) {
    return req.routerPath;
  }

  // Fallback: Heuristic Normalization
  return normalizePath(fallbackPath);
};