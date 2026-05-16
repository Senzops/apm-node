import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/register.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    minify: true,
    sourcemap: true,
    splitting: false,
  },
  {
    entry: ['src/index.ts'],
    format: ['iife'],
    clean: false,
    minify: true,
    sourcemap: true,
    splitting: false,
  }
]);
