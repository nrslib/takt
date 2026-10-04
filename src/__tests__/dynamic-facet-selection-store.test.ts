import { describe, expect, it } from 'vitest';
import { DynamicFacetSelectionStore } from '../core/workflow/dynamic-facets/dynamicFacetSelectionStore.js';
import type { DynamicFacetSelectionSnapshot } from '../core/models/workflow-types.js';

function snapshot(identity: string, selectedIds: string[], round: number): DynamicFacetSelectionSnapshot {
  return {
    identity,
    step_name: 'fix',
    round,
    selected_ids: [...selectedIds],
    selected_policy_refs: [...selectedIds],
    selected_knowledge_refs: [...selectedIds],
    rationale: `round ${round}`,
  };
}

describe('DynamicFacetSelectionStore', () => {
  it('should replace the previous round selection for the same identity', async () => {
    const store = new DynamicFacetSelectionStore(new Map());

    await store.commit('wf:fix', snapshot('wf:fix', ['frontend'], 1));
    await store.commit('wf:fix', snapshot('wf:fix', ['transaction'], 2));

    expect(store.snapshot()).toEqual(new Map([
      ['wf:fix', snapshot('wf:fix', ['transaction'], 2)],
    ]));
  });

  it('should retain parent and child selections in run-local state', async () => {
    const store = new DynamicFacetSelectionStore(new Map());

    await store.commit('parent:fix', snapshot('parent:fix', ['frontend'], 1));
    await store.commit('parent:delegate:child:fix', snapshot('parent:delegate:child:fix', ['backend'], 1));

    expect(store.snapshot()).toEqual(new Map([
      ['parent:fix', snapshot('parent:fix', ['frontend'], 1)],
      ['parent:delegate:child:fix', snapshot('parent:delegate:child:fix', ['backend'], 1)],
    ]));
  });

  it('should merge concurrent commits from independent workflow call identities', async () => {
    const store = new DynamicFacetSelectionStore(new Map());

    await Promise.all([
      store.commit('parent:call-1', snapshot('parent:call-1', ['frontend'], 1)),
      store.commit('parent:call-2', snapshot('parent:call-2', ['backend'], 1)),
    ]);

    expect(store.snapshot()).toEqual(new Map([
      ['parent:call-1', snapshot('parent:call-1', ['frontend'], 1)],
      ['parent:call-2', snapshot('parent:call-2', ['backend'], 1)],
    ]));
  });

  it('should return defensive snapshots for run-local selection state', async () => {
    const store = new DynamicFacetSelectionStore(new Map());
    await store.commit('parent:fix', snapshot('parent:fix', ['frontend'], 1));

    const exported = store.snapshot();
    exported.get('parent:fix')!.selected_ids.push('backend');

    expect(store.snapshot()).toEqual(new Map([
      ['parent:fix', snapshot('parent:fix', ['frontend'], 1)],
    ]));
  });
});
