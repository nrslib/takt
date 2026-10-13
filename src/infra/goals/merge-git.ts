import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toLocalBranchRef } from '../../shared/utils/gitBranchValidation.js';
import { createLogger } from '../../shared/utils/debug.js';
import { goalGitText, isGoalCommitIncluded, resolveGoalBranchSha, runGoalGit } from './git-command.js';

const log = createLogger('goal-merge');

export type GoalMergeResult =
  | { status: 'merged'; sha: string }
  | { status: 'checked_out'; worktrees: string[] }
  | { status: 'conflict'; conflicts: string[] };

export function checkedOutGoalWorktrees(porcelain: string, branch: string): string[] {
  const ref = toLocalBranchRef(branch);
  return porcelain.split('\0\0').flatMap((record) => {
    const fields = record.split('\0');
    const path = fields.find((field) => field.startsWith('worktree '));
    return path !== undefined && fields.includes(`branch ${ref}`) ? [path.slice('worktree '.length)] : [];
  });
}

export async function targetWorktrees(cwd: string, branch: string, signal: AbortSignal | undefined): Promise<string[]> {
  const result = await runGoalGit(cwd, ['worktree', 'list', '--porcelain', '-z'], 8 * 1024 * 1024, signal);
  if (result.truncated) throw new Error('Cannot verify every worktree: Git output exceeds the limit');
  return checkedOutGoalWorktrees(result.output.toString('utf8'), branch);
}

export async function mergeGoalBranch(
  cwd: string, sourceSha: string, targetBranch: string, signal: AbortSignal | undefined,
): Promise<GoalMergeResult> {
  const targetSha = await resolveGoalBranchSha(cwd, targetBranch, signal);
  const worktrees = await targetWorktrees(cwd, targetBranch, signal);
  if (worktrees.length > 0) return { status: 'checked_out', worktrees };
  if (await isGoalCommitIncluded(cwd, sourceSha, targetSha, signal)) return { status: 'merged', sha: targetSha };
  const temporary = await mkdtemp(join(tmpdir(), 'takt-goal-merge-'));
  const clone = join(temporary, 'repository');
  try {
    await goalGitText(cwd, ['clone', '--shared', '--no-checkout', '--', cwd, clone], signal);
    for (const key of ['user.name', 'user.email']) {
      const value = await runGoalGit(cwd, ['config', '--get', key], 4096, signal, [0, 1]);
      if (value.truncated) throw new Error(`Git ${key} exceeds the limit`);
      if (value.code === 0) await goalGitText(clone, ['config', '--local', key, value.output.toString('utf8').trim()], signal);
    }
    await goalGitText(clone, ['fetch', '--no-tags', '--no-write-fetch-head', '--', cwd, targetSha, sourceSha], signal);
    await goalGitText(clone, ['checkout', '--detach', targetSha], signal);
    const merge = await runGoalGit(clone, ['merge', '--no-ff', '--no-edit', sourceSha], 4096, signal, [0, 1]);
    if (merge.code !== 0) {
      const unresolved = await runGoalGit(clone, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=U', '-z'], 8 * 1024 * 1024, signal);
      if (unresolved.truncated) throw new Error('Conflict file list exceeds the complete-output limit');
      const conflicts = unresolved.output.toString('utf8').split('\0').filter(Boolean);
      if (conflicts.length === 0) throw new Error(`Git merge failed without conflict files: ${merge.output.toString('utf8')}`);
      await goalGitText(clone, ['merge', '--abort'], signal);
      return { status: 'conflict', conflicts };
    }
    const sha = await goalGitText(clone, ['rev-parse', 'HEAD'], signal);
    await goalGitText(cwd, ['fetch', '--no-tags', '--no-write-fetch-head', '--', clone, sha], signal);
    const currentWorktrees = await targetWorktrees(cwd, targetBranch, signal);
    if (currentWorktrees.length > 0) return { status: 'checked_out', worktrees: currentWorktrees };
    await goalGitText(cwd, ['update-ref', toLocalBranchRef(targetBranch), sha, targetSha], signal);
    return { status: 'merged', sha };
  } finally {
    try {
      await rm(temporary, { recursive: true, force: true });
    } catch (error) {
      // cleanup の失敗で、保存・返却する Git の結果を失わないようにする。
      log.warn('Failed to remove temporary goal merge directory', { path: temporary, error: String(error) });
    }
  }
}
