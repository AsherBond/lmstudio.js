import { applyPatches, produceWithPatches, type Patch } from "immer";

/**
 * A write tag is a tag that can be optionally passed to a setter to identify the update.
 */
export type WriteTag = number | string;

/**
 * A setter is a function that can be used to update a value. Different flavors of setters are
 * available in properties:
 * - `withImmer`: to update the value using Immer
 * - `withUpdater`: to update the value using a function
 * - `withPatches`: to update the value using a set of patches
 */
export interface Setter<TData> {
  (value: TData, tag?: WriteTag): void;
  withImmer(producer: (draft: TData) => void, tag?: WriteTag): void;
  withUpdater(updater: (oldValue: TData) => TData, tag?: WriteTag): void;
  withPatches(patches: Array<Patch>, tag?: WriteTag): void;
}

/**
 * Creates a setter function that can be used to update a value.
 */
export function makeSetter<TData>(
  update: (updater: (oldData: TData) => TData, tag?: WriteTag) => void,
): Setter<TData> {
  const setter = (value: TData, tag?: WriteTag) => {
    update(() => value, tag);
  };
  setter.withImmer = (producer: (draft: TData) => void, tag?: WriteTag) => {
    update(oldData => {
      const newData = { ...oldData };
      producer(newData);
      return newData;
    }, tag);
  };
  setter.withUpdater = (updater: (oldData: TData) => TData, tag?: WriteTag) => {
    update(updater, tag);
  };
  setter.withPatches = (patches: Array<Patch>, tag?: WriteTag) => {
    update(oldData => {
      return applyPatches(oldData as any, patches);
    }, tag);
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
  update: (
    updater: (oldData: TData) => readonly [newData: TData, patches: Array<Patch>],
    tag?: WriteTag,
  ) => void,
): Setter<TData> {
  const setter = (value: TData, tag?: WriteTag) => {
    update(() => [value, makeRootReplacingPatches(value)], tag);
  };
  setter.withImmer = (producer: (draft: TData) => void, tag?: WriteTag) => {
    update(oldData => {
      const [newData, patches] = produceWithPatches(oldData, producer);
      return [newData, patches];
    }, tag);
  };
  setter.withUpdater = (updater: (oldData: TData) => TData, tag?: WriteTag) => {
    update(oldData => {
      const newData = updater(oldData);
      return [newData, makeRootReplacingPatches(newData)];
    }, tag);
  };
  setter.withPatches = (patches: Array<Patch>, tag?: WriteTag) => {
    update(oldData => {
      return [applyPatches(oldData as any, patches), patches];
    }, tag);
  };
  return setter;
}
