import { LazySignal, type SubscribeUpstream } from "./LazySignal";
import { type SignalLike } from "./Signal";
import { Subscribable } from "./Subscribable";

/**
 * Optimistic Writable Lazy Signal
 *
 * - Signal: It is a signal, i.e. an observable that remembers its current value
 * - Lazy: It is lazy, i.e. it does not subscribe to the upstream until a subscriber is attached
 * - Writable: It is writable, i.e. it has a setter to update its value
 * - Optimistic: It is optimistic, i.e. it updates its value optimistically and then waits for the
 *   upstream to confirm the update
 */
export class OWLSignal<TData> extends Subscribable<TData> implements SignalLike<TData> {
  public static create<TData>(
    initialValue: TData,
    upstreamPatchesSubscriber: SubscribeUpstream<TData>,
    equalsPredicate: (a: TData, b: TData) => boolean = (a, b) => a === b,
  ) {
    return new OWLSignal(initialValue, upstreamPatchesSubscriber, equalsPredicate);
  }
  private readonly innerSignal: LazySignal<TData>;
  private readonly queuedUpdates: Array<(oldValue: TData) => TData> = [];

  private constructor(
    initialValue: TData,
    upstreamPatchesSubscriber: SubscribeUpstream<TData>,
    equalsPredicate: (a: TData, b: TData) => boolean,
  ) {
    super();
    this.innerSignal = LazySignal.create(initialValue, upstreamPatchesSubscriber, equalsPredicate);
  }

  private update(updater: (oldValue: TData) => TData);
}
