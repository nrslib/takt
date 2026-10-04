import type { DynamicFacetSelectionSnapshot } from '../../models/workflow-types.js';

export function cloneDynamicFacetSelectionSnapshot(snapshot: DynamicFacetSelectionSnapshot): DynamicFacetSelectionSnapshot {
  return {
    ...snapshot,
    selected_ids: [...snapshot.selected_ids],
    selected_policy_refs: [...snapshot.selected_policy_refs],
    selected_knowledge_refs: [...snapshot.selected_knowledge_refs],
  };
}

export function cloneDynamicFacetSelections(
  selections: ReadonlyMap<string, DynamicFacetSelectionSnapshot>,
): Map<string, DynamicFacetSelectionSnapshot> {
  return new Map([...selections].map(([identity, snapshot]) => [
    identity,
    cloneDynamicFacetSelectionSnapshot(snapshot),
  ]));
}

export class DynamicFacetSelectionStore {
  private selections: Map<string, DynamicFacetSelectionSnapshot>;
  private pending = Promise.resolve();

  constructor(initial: ReadonlyMap<string, DynamicFacetSelectionSnapshot>) {
    this.selections = cloneDynamicFacetSelections(initial);
  }

  snapshot(): Map<string, DynamicFacetSelectionSnapshot> {
    return cloneDynamicFacetSelections(this.selections);
  }

  async commit(
    identity: string,
    selection: DynamicFacetSelectionSnapshot,
  ): Promise<Map<string, DynamicFacetSelectionSnapshot>> {
    const operation = this.pending.then(async () => {
      const candidate = this.snapshot();
      candidate.set(identity, cloneDynamicFacetSelectionSnapshot(selection));
      this.selections = candidate;
      return this.snapshot();
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return await operation;
  }
}
