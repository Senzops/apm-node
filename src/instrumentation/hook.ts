import Module from 'module';

const SENZOR_PATCHED =
  Symbol.for('senzor.require.patched');

const SENZOR_HOOKS =
  Symbol.for('senzor.require.hooks');

type HookFn =
  (exports: unknown) => void;

type HookMap =
  Map<string, HookFn[]>;

function getHookRegistry(): HookMap {

  const mod =
    Module as unknown as Record<
      symbol,
      HookMap
    >;

  if (!mod[SENZOR_HOOKS]) {

    Object.defineProperty(
      mod,
      SENZOR_HOOKS,
      {
        value: new Map(),
        enumerable: false
      }
    );

  }

  return mod[SENZOR_HOOKS];

}

function runHooks(
  moduleName: string,
  exports: unknown
) {

  const registry =
    (Module as unknown as Record<
      symbol,
      HookMap
    >)[SENZOR_HOOKS];

  if (!registry) return;

  const hooks =
    registry.get(moduleName);

  if (!hooks?.length) return;

  for (const hook of hooks) {

    try {
      hook(exports);
    }
    catch (err) {

      console.error(
        `[Senzor] instrumentation failed for ${moduleName}`,
        err
      );

    }

  }

}

function patchLoaderOnce() {

  const mod =
    Module as unknown as any;

  if (mod[SENZOR_PATCHED]) {
    return;
  }

  const previousLoad =
    mod._load;

  mod._load =
    function patchedLoad(
      request: string,
      parent: unknown,
      isMain: boolean
    ) {

      const exports =
        previousLoad.apply(
          this,
          arguments
        );

      runHooks(
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

function patchCached(
  moduleName: string,
  hook: HookFn
) {

  try {

    const resolved =
      require.resolve(
        moduleName
      );

    const cached =
      require.cache?.[
      resolved
      ];

    if (cached?.exports) {

      hook(
        cached.exports
      );

    }

  }
  catch { }

}

function tryRequire(
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
  catch { }

}

function retryPatch(
  moduleName: string,
  hook: HookFn
) {

  let attempts = 0;

  const max = 5;

  const timer =
    setInterval(() => {

      attempts++;

      try {

        const mod =
          require(moduleName);

        if (mod) {

          hook(mod);

          clearInterval(timer);

        }

      }
      catch { }

      if (attempts >= max) {
        clearInterval(timer);
      }

    }, 200);

}

export const hookRequire =
  (
    moduleName: string,
    onRequire: HookFn
  ) => {

    const registry =
      getHookRegistry();

    if (!registry.has(moduleName)) {

      registry.set(
        moduleName,
        []
      );

    }

    registry
      .get(moduleName)!
      .push(onRequire);

    patchLoaderOnce();

    patchCached(
      moduleName,
      onRequire
    );

    tryRequire(
      moduleName,
      onRequire
    );

    retryPatch(
      moduleName,
      onRequire
    );

  };