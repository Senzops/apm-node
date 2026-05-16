import { randomUUID } from 'crypto';

export const generateTraceId = (): string =>
  randomUUID().replace(/-/g, '');

export const generateSpanId = (): string =>
  randomUUID().replace(/-/g, '').slice(0, 16);
