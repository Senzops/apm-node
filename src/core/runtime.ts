const _isNode = typeof process !== 'undefined' &&
  typeof process.versions !== 'undefined' &&
  typeof process.versions.node !== 'undefined';

export const isNode = (): boolean => _isNode;

export const isEdgeRuntime = (): boolean =>
  typeof navigator !== 'undefined' &&
  typeof navigator.userAgent === 'string' &&
  navigator.userAgent.includes('Cloudflare');

export const getEnv = (key: string): string | undefined => {
  if (_isNode) return process.env[key];
  return undefined;
};
