import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPullRequestForTask } from '../src/pr-action.js';

describe('current coverage', () => {
  it('rejects a mismatched branch', async () => {
    const calls = [];
    const result = await createPullRequestForTask(
      { name: 'task', branch: 'task/expected', worktreePath: '/worktree' },
      {
        getCurrentBranch: () => 'task/other',
        confirm: async () => calls.push('confirm'),
        commit: async () => calls.push('commit'),
        push: async () => calls.push('push'),
        createPullRequest: async () => calls.push('pr'),
      },
    );
    assert.equal(result, false);
    assert.deepEqual(calls, []);
  });
});
