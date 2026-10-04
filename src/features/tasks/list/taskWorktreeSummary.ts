import { execFileSync } from 'node:child_process';
import { toLocalBranchRef } from '../../../shared/utils/gitBranchValidation.js';

export interface TaskWorktreeSummary {
  readonly files: readonly string[];
  readonly text: string;
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ['show-ref', '--verify', '--quiet', ref]);
    return true;
  } catch (err) {
    const status = typeof err === 'object' && err !== null && 'status' in err
      ? err.status
      : undefined;
    if (status === 1) {
      return false;
    }
    throw err;
  }
}

function resolveStatusPath(pathText: string): string {
  const renameSeparator = ' -> ';
  const renameIndex = pathText.lastIndexOf(renameSeparator);
  return renameIndex === -1 ? pathText : pathText.slice(renameIndex + renameSeparator.length);
}

function collectStatusFiles(status: string): string[] {
  return status
    .split(/\r?\n/)
    .filter((line) => line.length >= 4)
    .map((line) => resolveStatusPath(line.slice(3).trim()))
    .filter((filePath) => filePath.length > 0);
}

function addSection(sections: string[], title: string, content: string): void {
  const normalizedContent = content.trim();
  if (normalizedContent.length === 0) {
    return;
  }
  sections.push(`## ${title}`, '```', normalizedContent, '```');
}

export function collectTaskWorktreeSummary(
  worktreePath: string,
  baseBranch: string,
  branch: string,
): TaskWorktreeSummary {
  const status = runGit(worktreePath, ['status', '--short']);
  const baseRef = toLocalBranchRef(baseBranch);
  const branchRef = toLocalBranchRef(branch);
  const committedDiff = gitRefExists(worktreePath, baseRef) && gitRefExists(worktreePath, branchRef)
    ? runGit(worktreePath, ['diff', '--stat', `${baseRef}...${branchRef}`])
    : '';
  const stagedDiff = runGit(worktreePath, ['diff', '--cached', '--stat']);
  const unstagedDiff = runGit(worktreePath, ['diff', '--stat']);
  const files = [...new Set(collectStatusFiles(status))];
  const sections: string[] = [];

  addSection(sections, 'コミット済み変更', committedDiff);
  addSection(sections, 'ステージ済み変更', stagedDiff);
  addSection(sections, '未ステージ変更', unstagedDiff);
  addSection(sections, '作業ツリーの状態', status);

  return {
    files,
    text: sections.join('\n'),
  };
}
