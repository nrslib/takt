import { describe, expect, it } from 'vitest';
import { DynamicParallelSelectionStore } from '../core/workflow/dynamic-parallel/selection-store.js';

function selection(identity: string, selectedPoolId: string) {
  return {
    identity,
    step_name: 'reviewers',
    round: 1,
    selected_pool_ids: [selectedPoolId],
    effective_selection_ids: ['architecture', selectedPoolId],
  };
}

describe('DynamicParallelSelectionStore', () => {
  it('should retain parent and fresh child selections across sequential commits', async () => {
    const store = new DynamicParallelSelectionStore(new Map());

    await store.commit('parent:reviewers', selection('parent:reviewers', 'frontend'), async () => {});
    await store.commit('parent:delegate:child:reviewers', selection('parent:delegate:child:reviewers', 'backend'), async () => {});

    expect(store.serialized()).toMatchObject({
      'parent:reviewers': selection('parent:reviewers', 'frontend'),
      'parent:delegate:child:reviewers': selection('parent:delegate:child:reviewers', 'backend'),
    });
  });

  it('should merge concurrent commits from independent workflow call identities', async () => {
    const store = new DynamicParallelSelectionStore(new Map());
    const persisted: string[][] = [];

    await Promise.all([
      store.commit('parent:call-1', selection('parent:call-1', 'frontend'), async (selections) => {
        persisted.push([...selections.keys()]);
      }),
      store.commit('parent:call-2', selection('parent:call-2', 'backend'), async (selections) => {
        persisted.push([...selections.keys()]);
      }),
    ]);

    expect(store.serialized()).toMatchObject({
      'parent:call-1': selection('parent:call-1', 'frontend'),
      'parent:call-2': selection('parent:call-2', 'backend'),
    });
    expect(persisted).toEqual([['parent:call-1'], ['parent:call-1', 'parent:call-2']]);
  });

  it('should leave the committed selection unchanged when persistence fails', async () => {
    const store = new DynamicParallelSelectionStore(new Map([['parent:call-1', selection('parent:call-1', 'frontend')]]));

    await expect(store.commit('parent:call-2', selection('parent:call-2', 'backend'), async () => {
      throw new Error('metadata write failed');
    })).rejects.toThrow('metadata write failed');

    expect(store.serialized()).toEqual({ 'parent:call-1': selection('parent:call-1', 'frontend') });
  });

  it('should return a defensive snapshot only after persistence succeeds', async () => {
    const store = new DynamicParallelSelectionStore(new Map());

    const committed = await store.commit(
      'parent:call-1',
      selection('parent:call-1', 'frontend'),
      async () => {},
    );
    committed.get('parent:call-1')!.selected_pool_ids.push('backend');

    expect(store.serialized()).toEqual({
      'parent:call-1': selection('parent:call-1', 'frontend'),
    });
  });
});
