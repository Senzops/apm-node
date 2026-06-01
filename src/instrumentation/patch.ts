const PATCHES = Symbol.for('senzor.patch.keys');
const ORIGINAL = Symbol.for('senzor.patch.original');

type WrappedFunction = Function & {
  [PATCHES]?: Set<string>;
  [ORIGINAL]?: Function;
};

export const patchMethod = (
  target: any,
  methodName: string,
  patchKey: string,
  wrapper: (original: Function) => Function
): boolean => {
  if (!target) return false;

  const current = target[methodName] as WrappedFunction | undefined;
  if (typeof current !== 'function') return false;

  const existingPatches = current[PATCHES];
  if (existingPatches?.has(patchKey)) return false;

  const original = current[ORIGINAL] || current;
  const rawWrapped = wrapper(current);

  const safeWrapped = rawWrapped as WrappedFunction;

  const patches = new Set(existingPatches || []);
  patches.add(patchKey);

  try {
    Object.defineProperty(safeWrapped, PATCHES, {
      value: patches,
      enumerable: false
    });
    Object.defineProperty(safeWrapped, ORIGINAL, {
      value: original,
      enumerable: false
    });
    Object.defineProperty(safeWrapped, 'length', {
      value: current.length,
      configurable: true
    });
    if (current.name) {
      try {
        Object.defineProperty(safeWrapped, 'name', {
          value: current.name,
          configurable: true
        });
      } catch {}
    }
  } catch {
    return false;
  }

  try {
    target[methodName] = safeWrapped;
    return true;
  } catch {
    return false;
  }
};

export const isPatched = (
  target: any,
  methodName: string,
  patchKey: string
): boolean => {
  const current = target?.[methodName] as WrappedFunction | undefined;
  return Boolean(current?.[PATCHES]?.has(patchKey));
};
