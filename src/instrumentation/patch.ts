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
  const wrapped = wrapper(current) as WrappedFunction;
  const patches = new Set(existingPatches || []);
  patches.add(patchKey);

  try {
    Object.defineProperty(wrapped, PATCHES, {
      value: patches,
      enumerable: false
    });
    Object.defineProperty(wrapped, ORIGINAL, {
      value: original,
      enumerable: false
    });
  } catch {
    return false;
  }

  try {
    target[methodName] = wrapped;
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
