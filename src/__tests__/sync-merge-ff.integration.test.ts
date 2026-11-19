import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeBaseBranch } from '../infra/workflow/system/system-effect-git-helpers.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('sync merge under a restrictive merge.ff setting', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('merges a diverged base branch even when merge.ff is only', () => {
    dir = mkdtempSync(join(tmpdir(), 'takt-sync-merge-ff-'));
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    git(dir, ['config', 'merge.ff', 'only']);
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'A']);
    git(dir, ['checkout', '-b', 'task']);
    writeFileSync(join(dir, 'c.txt'), 'c\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'C']);
    const taskSha = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['checkout', 'main']);
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'B']);
    const baseSha = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['update-ref', 'refs/remotes/origin/main', baseSha]);
    git(dir, ['checkout', 'task']);

    expect(() => mergeBaseBranch(dir!, 'main')).not.toThrow();

    const parents = git(dir, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ');
    expect(parents).toHaveLength(3);
    expect(parents.slice(1).sort()).toEqual([baseSha, taskSha].sort());
  });
});
