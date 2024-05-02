import { applyPatches, produceWithPatches, type Patch } from "immer";

/**
 * A setter is a function that can be used to update a value. Different flavors of setters are
 * available in properties:
 * - `withImmer`: to update the value using Immer
 * - `withUpdater`: to update the value using a function
 * - `withPatches`: to update the value using a set of patches
 */
export interface Setter<TData> {
  (value: TData): void;
  withImmer(producer: (draft: TData) => void): void;
  withUpdater(updater: (oldValue: TData) => TData): void;
  withPatches(patches: Array<Patch>): void;
}

/**
 * Creates a setter function that can be used to update a value.
 */
export function makeSetter<TData>(
  update: (updater: (oldData: TData) => TData) => void,
): Setter<TData> {
  const setter = (value: TData) => {
    update(() => value);
  };
  setter.withImmer = (producer: (draft: TData) => void) => {
    update(oldData => {
      const newData = { ...oldData };
      producer(newData);
      return newData;
    });
  };
  setter.withUpdater = (updater: (oldData: TData) => TData) => {
    update(updater);
  };
  setter.withPatches = (patches: Array<Patch>) => {
    update(oldData => {
      return applyPatches(oldData as any, patches);
    });
  };
  return setter;
}

function makeRootReplacingPatches<TData>(value: TData): Array<Patch> {
  return [
    {
      op: "replace",
      path: [],
      value,
    },
  ];
}

/**
 * Creates a setter function that can be used to update a value. This setter will also return the
 * patches that were applied to the value.
 */
export function makeSetterWithPatches<TData>(
  update: (updater: (oldData: TData) => readonly [newData: TData, patches: Array<Patch>]) => void,
): Setter<TData> {
  const setter = (value: TData) => {
    update(() => [value, makeRootReplacingPatches(value)]);
  };
  setter.withImmer = (producer: (draft: TData) => void) => {
    update(oldData => {
      const [newData, patches] = produceWithPatches(oldData, producer);
      return [newData, patches];
    });
  };
  setter.withUpdater = (updater: (oldData: TData) => TData) => {
    update(oldData => {
      const newData = updater(oldData);
      return [newData, makeRootReplacingPatches(newData)];
    });
  };
  setter.withPatches = (patches: Array<Patch>) => {
    update(oldData => {
      return [applyPatches(oldData as any, patches), patches];
    });
  };
  return setter;
}
