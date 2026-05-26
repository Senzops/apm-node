import { defineConfig } from 'tsup';

const NODE_BUILTINS = [
  'http', 'https', 'url', 'net', 'dns', 'module', 'crypto', 'async_hooks', 'perf_hooks',
  'node:http', 'node:https', 'node:url', 'node:net', 'node:dns', 'node:module',
  'node:crypto', 'node:async_hooks', 'node:perf_hooks'
];

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/register.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    minify: true,
    sourcemap: true,
    splitting: false,
    external: NODE_BUILTINS,
    noExternal: [],
  },
  {
    entry: ['src/index.ts'],
    format: ['iife'],
    clean: false,
    minify: true,
    sourcemap: true,
    splitting: false,
    external: NODE_BUILTINS,
  }
]);
