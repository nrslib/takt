import { describe, expect, it } from 'vitest';
import { DynamicParallelSelectionStore } from '../core/workflow/dynamic-parallel/selection-store.js';

function selection(identity: string, selectedPoolId: string, round = 1) {
  return {
    identity,
    step_name: 'reviewers',
    round,
    selected_pool_ids: [selectedPoolId],
    effective_selection_ids: ['architecture', selectedPoolId],
  };
}

describe('DynamicParallelSelectionStore', () => {
  it('should retain parent and child selections in run-local state', async () => {
    const store = new DynamicParallelSelectionStore(new Map());

    await store.commit('parent:reviewers', selection('parent:reviewers', 'frontend'));
    await store.commit('parent:delegate:child:reviewers', selection('parent:delegate:child:reviewers', 'backend'));

    expect(store.snapshot()).toEqual(new Map([
      ['parent:reviewers', selection('parent:reviewers', 'frontend')],
      ['parent:delegate:child:reviewers', selection('parent:delegate:child:reviewers', 'backend')],
    ]));
  });

  it('should merge concurrent commits from independent workflow call identities', async () => {
    const store = new DynamicParallelSelectionStore(new Map());

    await Promise.all([
      store.commit('parent:call-1', selection('parent:call-1', 'frontend')),
      store.commit('parent:call-2', selection('parent:call-2', 'backend')),
    ]);

    expect(store.snapshot()).toEqual(new Map([
      ['parent:call-1', selection('parent:call-1', 'frontend')],
      ['parent:call-2', selection('parent:call-2', 'backend')],
    ]));
  });

  it('should replace the same identity with the latest round', async () => {
    const store = new DynamicParallelSelectionStore(new Map());

    await store.commit('parent:reviewers', selection('parent:reviewers', 'frontend', 1));
    await store.commit('parent:reviewers', selection('parent:reviewers', 'backend', 2));

    expect(store.snapshot()).toEqual(new Map([
      ['parent:reviewers', selection('parent:reviewers', 'backend', 2)],
    ]));
  });

  it('should return defensive snapshots for run-local selection state', async () => {
    const store = new DynamicParallelSelectionStore(new Map());
    await store.commit('parent:reviewers', selection('parent:reviewers', 'frontend'));

    const exported = store.snapshot();
    exported.get('parent:reviewers')!.selected_pool_ids.push('backend');

    expect(store.snapshot()).toEqual(new Map([
      ['parent:reviewers', selection('parent:reviewers', 'frontend')],
    ]));
  });
});
