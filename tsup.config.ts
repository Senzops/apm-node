import { defineConfig } from 'tsup';
import path from 'path';

const NODE_BUILTINS = [
  'http', 'https', 'url', 'net', 'dns', 'module', 'crypto', 'async_hooks', 'perf_hooks',
  'node:http', 'node:https', 'node:url', 'node:net', 'node:dns', 'node:module',
  'node:crypto', 'node:async_hooks', 'node:perf_hooks'
];

const workerContextPlugin = {
  name: 'worker-context',
  setup(build: any) {
    build.onResolve({ filter: /context$/ }, (args: any) => {
      if (args.path === './context' || args.path === '../core/context') {
        return {
          path: path.resolve(args.resolveDir, args.path.replace(/context$/, 'context.worker.ts')),
        };
      }
      return null;
    });
    build.onResolve({ filter: /instrumentation/ }, (args: any) => {
      const UTILITY_MODULES = ['dummy', 'framework', 'hook', 'http', 'patch', 'runtime', 'span'];
      const basename = args.path.split('/').pop()?.replace(/\.ts$/, '');
      if (basename && UTILITY_MODULES.includes(basename)) {
        return null;
      }
      if (args.path.startsWith('../instrumentation/') || args.path.startsWith('./instrumentation/')) {
        return {
          path: path.resolve(__dirname, 'src/instrumentation/dummy.ts'),
        };
      }
      return null;
    });
  },
};

export default defineConfig([
  // 1. Node.js Build (CommonJS + ESM)
  {
    entry: ['src/index.ts', 'src/register.ts', 'src/lambda-handler.ts'],
    format: ['cjs', 'esm'],
    outExtension({ format }) {
      return {
        js: format === 'esm' ? '.node.mjs' : '.js',
      };
    },
    dts: true,
    clean: true,
    minify: true,
    sourcemap: true,
    splitting: false,
    external: NODE_BUILTINS,
    noExternal: [],
  },
  // 2. Cloudflare Workers / Edge Build (ESM only)
  {
    entry: {
      'index': 'src/index.ts',
    },
    format: ['esm'],
    outExtension() {
      return {
        js: '.worker.mjs',
      };
    },
    dts: false,
    clean: false,
    minify: true,
    sourcemap: true,
    splitting: false,
    external: NODE_BUILTINS,
    esbuildPlugins: [workerContextPlugin],
  },
  // 3. Browser IIFE Build
  {
    entry: ['src/index.ts'],
    format: ['iife'],
    clean: false,
    minify: true,
    sourcemap: true,
    splitting: false,
    external: NODE_BUILTINS,
    esbuildPlugins: [workerContextPlugin],
  }
]);
