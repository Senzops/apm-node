const getRandomUUID = (): string => {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  try {
    if (typeof require !== 'undefined') {
      const { randomUUID } = require('node:crypto');
      if (randomUUID) return randomUUID();
    }
  } catch {}

  // Fallback: RFC4122 v4 UUID via Math.random (last resort)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
};

export const generateTraceId = (): string =>
  getRandomUUID().replace(/-/g, '');

export const generateSpanId = (): string =>
  getRandomUUID().replace(/-/g, '').slice(0, 16);
