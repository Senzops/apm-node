import Module from 'module';

const SENZOR_PATCHED = Symbol.for('senzor.require.patched');
const SENZOR_HOOKS = Symbol.for('senzor.require.hooks');

type HookFn = (exports: any) => void;

type HookMap = Map<string, HookFn[]>;

function getHookRegistry(): HookMap {

  const mod = Module as any;

  if (!mod[SENZOR_HOOKS]) {
    Object.defineProperty(
      mod,
      SENZOR_HOOKS,
      {
        value: new Map(),
        enumerable: false,
        configurable: false
      }
    );
  }

  return mod[SENZOR_HOOKS];
}

function patchLoaderOnce() {

  const mod = Module as any;

  if (mod[SENZOR_PATCHED]) {
    return;
  }

  const originalLoad = mod._load;

  mod._load = function (request: string, parent: any, isMain: boolean) {

    const exports = originalLoad.apply(this, arguments);

    try {

      const hooks: HookMap = mod[SENZOR_HOOKS];

      const moduleHooks = hooks?.get(request);

      if (moduleHooks?.length) {

        for (const hook of moduleHooks) {

          try {
            hook(exports);
          }
          catch (err) {
            console.error('[Senzor] Module hook error:', err);
          }

        }

      }

    }
    catch {
      // never break module loading
    }

    return exports;
  };

  Object.defineProperty(
    mod,
    SENZOR_PATCHED,
    {
      value: true,
      enumerable: false,
      configurable: false
    }
  );

}

function patchCachedModule(
  moduleName: string,
  hook: HookFn
) {

  try {

    const resolved = require.resolve(moduleName);

    const cached = require.cache?.[resolved];

    if (cached?.exports) {

      try {
        hook(cached.exports);
      }
      catch (err) {
        console.error(
          '[Senzor] Cached module hook error:',
          err
        );
      }

    }

  }
  catch {
    // module not installed
  }

}

export const hookRequire = (
  moduleName: string,
  onRequire: HookFn
) => {

  const hooks = getHookRegistry();

  if (!hooks.has(moduleName)) {
    hooks.set(moduleName, []);
  }

  hooks.get(moduleName)!.push(onRequire);

  patchLoaderOnce();

  patchCachedModule(
    moduleName,
    onRequire
  );

};