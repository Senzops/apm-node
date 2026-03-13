import Module from 'module';

/**
 * Intercepts Node's module loading to patch libraries "in the middle".
 * This guarantees that even `import { schedule } from 'node-cron'` 
 * receives the patched function.
 */
export const hookRequire = (moduleName: string, onRequire: (exports: any) => void) => {
  const originalLoad = (Module as any)._load;
  
  // 1. Intercept future requires
  (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
    const exports = originalLoad.apply(this, arguments);
    
    // If the requested module matches and hasn't been patched yet
    if (request === moduleName && exports && !exports.__senzorPatched) {
      onRequire(exports);
      exports.__senzorPatched = true; // Prevent infinite loops or double-patching
    }
    
    return exports;
  };

  // 2. Catch it if it was already loaded into the cache before initialization
  try {
    const resolvedPath = require.resolve(moduleName);
    if (require.cache[resolvedPath]) {
      const exports = require.cache[resolvedPath]?.exports;
      if (exports && !exports.__senzorPatched) {
        onRequire(exports);
        exports.__senzorPatched = true;
      }
    }
  } catch (e) {
    // Module not installed, fail silently
  }
};