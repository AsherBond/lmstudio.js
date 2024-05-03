import { applyPatches, produceWithPatches, type Patch } from "immer";

/**
 * A write tag is a tag that can be optionally passed to a setter to identify the update.
 */
export type WriteTag = number | string;

/**
 * Concatenate Writable Tags
 */
function cwt(...allTags: Array<undefined | Array<WriteTag>>): Array<WriteTag> {
  return allTags
    .filter(tags => tags !== undefined)
    .reduce((acc, tags) => (acc as any).concat(tags), []) as any;
}

/**
 * A setter is a function that can be used to update a value. Different flavors of setters are
 * available in properties:
 * - `withImmer`: to update the value using Immer
 * - `withUpdater`: to update the value using a function
 * - `withPatches`: to update the value using a set of patches
 */
export interface Setter<TData> {
  (value: TData, tags?: Array<WriteTag>): void;
  withImmer(producer: (draft: TData) => void, tags?: Array<WriteTag>): void;
  withUpdater(updater: (oldValue: TData) => TData, tags?: Array<WriteTag>): void;
  withPatches(patches: Array<Patch>, tags?: Array<WriteTag>): void;
}

/**
 * Creates a setter function that can be used to update a value.
 */
export function makeSetter<TData>(
  update: (updater: (oldData: TData) => TData, tags?: Array<WriteTag>) => void,
  prependTagsFn?: () => Array<WriteTag>,
): Setter<TData> {
  const setter = (value: TData, tags?: Array<WriteTag>) => {
    update(() => value, cwt(prependTagsFn?.(), tags));
  };
  setter.withImmer = (producer: (draft: TData) => void, tags?: Array<WriteTag>) => {
    update(
      oldData => {
        const newData = { ...oldData };
        producer(newData);
        return newData;
      },
      cwt(prependTagsFn?.(), tags),
    );
  };
  setter.withUpdater = (updater: (oldData: TData) => TData, tags?: Array<WriteTag>) => {
    update(updater, cwt(prependTagsFn?.(), tags));
  };
  setter.withPatches = (patches: Array<Patch>, tags?: Array<WriteTag>) => {
    update(
      oldData => {
        return applyPatches(oldData as any, patches);
      },
      cwt(prependTagsFn?.(), tags),
    );
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
    tags?: Array<WriteTag>,
  ) => void,
  prependTagsFn?: () => Array<WriteTag>,
): Setter<TData> {
  const setter = (value: TData, tags?: Array<WriteTag>) => {
    update(() => [value, makeRootReplacingPatches(value)], cwt(prependTagsFn?.(), tags));
  };
  setter.withImmer = (producer: (draft: TData) => void, tags?: Array<WriteTag>) => {
    update(
      oldData => {
        const [newData, patches] = produceWithPatches(oldData, producer);
        return [newData, patches];
      },
      cwt(prependTagsFn?.(), tags),
    );
  };
  setter.withUpdater = (updater: (oldData: TData) => TData, tags?: Array<WriteTag>) => {
    update(
      oldData => {
        const newData = updater(oldData);
        return [newData, makeRootReplacingPatches(newData)];
      },
      cwt(prependTagsFn?.(), tags),
    );
  };
  setter.withPatches = (patches: Array<Patch>, tags?: Array<WriteTag>) => {
    update(
      oldData => {
        return [applyPatches(oldData as any, patches), patches];
      },
      cwt(prependTagsFn?.(), tags),
    );
  };
  return setter;
}
