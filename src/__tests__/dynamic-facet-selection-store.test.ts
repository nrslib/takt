import { describe, expect, it } from 'vitest';
import { DynamicFacetSelectionStore } from '../core/workflow/dynamic-facets/dynamicFacetSelectionStore.js';
import type { DynamicFacetSelectionSnapshot } from '../core/models/workflow-types.js';

function snapshot(identity: string, selectedIds: string[], round: number): DynamicFacetSelectionSnapshot {
  return {
    identity,
    step_name: 'fix',
    round,
    selected_ids: [...selectedIds],
    effective_policy_refs: [...selectedIds],
    effective_knowledge_refs: [...selectedIds],
    rationale: `round ${round}`,
  };
}

describe('DynamicFacetSelectionStore (C-ROUND-REPLACE, C-ROUND-RESUME, C-STATE-RUNTIME)', () => {
  it('should replace the previous round selection when the same identity commits a new round (C-ROUND-REPLACE)', async () => {
    const store = new DynamicFacetSelectionStore(new Map());

    await store.commit('wf:fix', snapshot('wf:fix', ['frontend'], 1), async () => {});
    expect(store.snapshot().get('wf:fix')?.selected_ids).toEqual(['frontend']);

    // New round: selection is replaced, not accumulated.
    await store.commit('wf:fix', snapshot('wf:fix', ['transaction'], 2), async () => {});
    const replaced = store.snapshot().get('wf:fix');
    expect(replaced?.round).toBe(2);
    expect(replaced?.selected_ids).toEqual(['transaction']);
    // The previous round's frontend selection must not be present.
    expect(replaced?.selected_ids).not.toContain('frontend');
  });

  it('should retain parent and fresh child selections across sequential commits (C-STATE-RUNTIME)', async () => {
    const store = new DynamicFacetSelectionStore(new Map());

    await store.commit('parent:fix', snapshot('parent:fix', ['frontend'], 1), async () => {});
    await store.commit('parent:delegate:child:fix', snapshot('parent:delegate:child:fix', ['backend'], 1), async () => {});

    expect(store.serialized()).toMatchObject({
      'parent:fix': snapshot('parent:fix', ['frontend'], 1),
      'parent:delegate:child:fix': snapshot('parent:delegate:child:fix', ['backend'], 1),
    });
  });

  it('should return a defensive snapshot only after persistence succeeds (C-STATE-RUNTIME)', async () => {
    const store = new DynamicFacetSelectionStore(new Map());

    const committed = await store.commit(
      'parent:fix',
      snapshot('parent:fix', ['frontend'], 1),
      async () => {},
    );
    // Mutate the returned snapshot; the store must be unaffected.
    committed.get('parent:fix')!.selected_ids.push('backend');

    expect(store.serialized()).toEqual({
      'parent:fix': snapshot('parent:fix', ['frontend'], 1),
    });
  });

  it('should leave the committed selection unchanged when persistence fails (C-STATE-RUNTIME)', async () => {
    const store = new DynamicFacetSelectionStore(new Map([
      ['parent:fix', snapshot('parent:fix', ['frontend'], 1)],
    ]));

    await expect(store.commit('parent:call-2', snapshot('parent:call-2', ['backend'], 1), async () => {
      throw new Error('metadata write failed');
    })).rejects.toThrow('metadata write failed');

    expect(store.serialized()).toEqual({
      'parent:fix': snapshot('parent:fix', ['frontend'], 1),
    });
  });

  it('should merge concurrent commits from independent workflow call identities (C-STATE-RUNTIME)', async () => {
    const store = new DynamicFacetSelectionStore(new Map());
    const persisted: string[][] = [];

    await Promise.all([
      store.commit('parent:call-1', snapshot('parent:call-1', ['frontend'], 1), async (selections) => {
        persisted.push([...selections.keys()]);
      }),
      store.commit('parent:call-2', snapshot('parent:call-2', ['backend'], 1), async (selections) => {
        persisted.push([...selections.keys()]);
      }),
    ]);

    expect(store.serialized()).toMatchObject({
      'parent:call-1': snapshot('parent:call-1', ['frontend'], 1),
      'parent:call-2': snapshot('parent:call-2', ['backend'], 1),
    });
    expect(persisted).toEqual([['parent:call-1'], ['parent:call-1', 'parent:call-2']]);
  });
});