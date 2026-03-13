import Module from 'module';

export const hookRequire = (moduleName: string, onRequire: (exports: any) => void) => {
  // 1. If it was already loaded (e.g., imported at the top of the file before init)
  try {
    const resolvedPath = require.resolve(moduleName);
    const cached = require.cache[resolvedPath];
    if (cached && cached.exports) {
      onRequire(cached.exports);
    }
  } catch (e) {
    // Silently ignore if module is not installed
  }

  // 2. Intercept future requires
  const originalLoad = (Module as any)._load;
  (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
    const exports = originalLoad.apply(this, arguments);
    if (request === moduleName && exports) {
      onRequire(exports);
    }
    return exports;
  };
};