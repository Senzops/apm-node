import Module from 'module';

type HookFn = (exports: unknown) => unknown | void;
type HookMap = Map<string, HookFn[]>;

const safeRequire: NodeRequire = Module.createRequire(
  typeof __filename !== 'undefined'
    ? __filename
    : process.cwd() + '/'
);

(globalThis as any).__senzorSafeRequire = safeRequire;

const SENZOR_PATCHED = Symbol.for('senzor.require.patched');
const SENZOR_HOOKS = Symbol.for('senzor.require.hooks');

function getHookRegistry(): HookMap {
  const mod = Module as unknown as Record<symbol, HookMap>;

  if (!mod[SENZOR_HOOKS]) {
    Object.defineProperty(mod, SENZOR_HOOKS, {
      value: new Map(),
      enumerable: false
    });
  }

  return mod[SENZOR_HOOKS];
}

function runHooks(moduleName: string, exports: unknown) {
  const registry = (Module as unknown as Record<symbol, HookMap>)[SENZOR_HOOKS];
  if (!registry) return exports;

  const hooks = registry.get(moduleName);
  if (!hooks?.length) return exports;

  let currentExports = exports;

  for (const hook of hooks) {
    try {
      const nextExports = hook(currentExports);
      if (nextExports !== undefined) {
        currentExports = nextExports;
      }
    } catch (err) {
      console.error(`[Senzor] instrumentation failed for ${moduleName}`, err);
    }
  }

  return currentExports;
}

function patchLoaderOnce() {
  const mod = Module as unknown as any;

  if (mod[SENZOR_PATCHED]) return;

  // Module._load is CJS-specific; in pure ESM runtimes it may not exist
  if (typeof mod._load !== 'function') return;

  const previousLoad = mod._load;

  mod._load = function patchedLoad(
    request: string,
    parent: unknown,
    isMain: boolean
  ) {
    const exports = previousLoad.apply(this, arguments);
    return runHooks(request, exports);
  };

  Object.defineProperty(mod, SENZOR_PATCHED, {
    value: true,
    enumerable: false
  });
}

function patchCached(moduleName: string, hook: HookFn) {
  if (!safeRequire) return;
  try {
    const resolved = safeRequire.resolve(moduleName);
    const cached = safeRequire.cache?.[resolved];

    if (cached?.exports) {
      const replacement = hook(cached.exports);
      if (replacement !== undefined) {
        cached.exports = replacement;
      }
    }
  } catch { }
}

export const hookRequire = (moduleName: string, onRequire: HookFn) => {
  if (!safeRequire) return;

  const registry = getHookRegistry();

  if (!registry.has(moduleName)) {
    registry.set(moduleName, []);
  }

  registry.get(moduleName)!.push(onRequire);

  patchLoaderOnce();
  patchCached(moduleName, onRequire);
};
