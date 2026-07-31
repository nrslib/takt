import type { DynamicParallelSelectionSnapshot } from '../../models/types.js';
import {
  cloneDynamicParallelSelectionSnapshot,
  cloneDynamicParallelSelections,
  serializeDynamicParallelSelections,
} from './snapshot.js';

export class DynamicParallelSelectionStore {
  private selections: Map<string, DynamicParallelSelectionSnapshot>;
  private pending = Promise.resolve();

  constructor(initial: ReadonlyMap<string, DynamicParallelSelectionSnapshot>) {
    this.selections = cloneDynamicParallelSelections(initial);
  }

  snapshot(): Map<string, DynamicParallelSelectionSnapshot> {
    return cloneDynamicParallelSelections(this.selections);
  }

  serialized(): Record<string, DynamicParallelSelectionSnapshot> | undefined {
    return this.selections.size === 0 ? undefined : serializeDynamicParallelSelections(this.selections);
  }

  async commit(
    identity: string,
    selection: DynamicParallelSelectionSnapshot,
    persist: (selections: ReadonlyMap<string, DynamicParallelSelectionSnapshot>) => Promise<void>,
  ): Promise<Map<string, DynamicParallelSelectionSnapshot>> {
    const operation = this.pending.then(async () => {
      const candidate = this.snapshot();
      candidate.set(identity, cloneDynamicParallelSelectionSnapshot(selection));
      await persist(cloneDynamicParallelSelections(candidate));
      this.selections = candidate;
      return this.snapshot();
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return await operation;
  }
}
