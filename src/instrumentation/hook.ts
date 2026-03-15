import Module from 'module';

const SENZOR_PATCHED = Symbol.for('senzor.require.patched');
const SENZOR_HOOKS = Symbol.for('senzor.require.hooks');

type HookFn = (exports: any) => void;

type HookMap = Map<string, HookFn[]>;

function getHookRegistry(): HookMap {

  const mod = Module as any;

  if (!mod[SENZOR_HOOKS]) {

    Object.defineProperty(mod, SENZOR_HOOKS, {
      value: new Map(),
      enumerable: false,
      configurable: false
    });

  }

  return mod[SENZOR_HOOKS];

}

function safelyExecuteHooks(
  moduleName: string,
  exports: any
) {

  try {

    const hooks: HookMap =
      (Module as any)[SENZOR_HOOKS];

    const moduleHooks =
      hooks?.get(moduleName);

    if (!moduleHooks?.length) {
      return;
    }

    for (const hook of moduleHooks) {

      try {
        hook(exports);
      }
      catch (err) {

        console.error(
          `[Senzor] instrumentation failed for ${moduleName}:`,
          err
        );

      }

    }

  }
  catch {
    // never break require
  }

}

function patchLoaderOnce() {

  const mod = Module as any;

  if (mod[SENZOR_PATCHED]) {
    return;
  }

  const originalLoad = mod._load;

  mod._load = function (
    request: string,
    parent: any,
    isMain: boolean
  ) {

    const exports =
      originalLoad.apply(this, arguments);

    safelyExecuteHooks(
      request,
      exports
    );

    return exports;

  };

  Object.defineProperty(
    mod,
    SENZOR_PATCHED,
    {
      value: true,
      enumerable: false
    }
  );

}

function patchCachedModule(
  moduleName: string,
  hook: HookFn
) {

  try {

    const resolved =
      require.resolve(moduleName);

    const cached =
      require.cache?.[resolved];

    if (cached?.exports) {

      try {
        hook(cached.exports);
      }
      catch (err) {

        console.error(
          `[Senzor] cached instrumentation failed for ${moduleName}:`,
          err
        );

      }

    }

  }
  catch {
    // module not installed or ESM
  }

}

function tryRequirePatch(
  moduleName: string,
  hook: HookFn
) {

  try {

    const mod =
      require(moduleName);

    if (mod) {
      hook(mod);
    }

  }
  catch {
    // ignore (ESM or not installed)
  }

}

export const hookRequire = (
  moduleName: string,
  onRequire: HookFn
) => {

  const hooks =
    getHookRegistry();

  if (!hooks.has(moduleName)) {
    hooks.set(moduleName, []);
  }

  hooks
    .get(moduleName)!
    .push(onRequire);

  patchLoaderOnce();

  // already loaded modules
  patchCachedModule(
    moduleName,
    onRequire
  );

  // CJS fallback
  tryRequirePatch(
    moduleName,
    onRequire
  );

};