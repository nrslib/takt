import { execFileSync } from 'node:child_process';
import { createLogger } from '../../shared/utils/index.js';
import { resolveConfigValue } from '../config/index.js';
import { detectDefaultBranch } from './branchList.js';
import { runGitCommandAbortable } from './clone-exec.js';

const log = createLogger('clone');

export function localBranchExists(projectDir: string, branch: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: projectDir,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

export function remoteBranchExists(projectDir: string, branch: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
      cwd: projectDir,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

export function branchExists(projectDir: string, branch: string): boolean {
  return localBranchExists(projectDir, branch) || remoteBranchExists(projectDir, branch);
}

export async function localBranchExistsAbortable(
  projectDir: string,
  branch: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  try {
    await runGitCommandAbortable(projectDir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], abortSignal);
    return true;
  } catch {
    return false;
  }
}

export async function remoteBranchExistsAbortable(
  projectDir: string,
  branch: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  try {
    await runGitCommandAbortable(projectDir, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], abortSignal);
    return true;
  } catch {
    return false;
  }
}

export async function branchExistsAbortable(
  projectDir: string,
  branch: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  return (
    await localBranchExistsAbortable(projectDir, branch, abortSignal)
    || await remoteBranchExistsAbortable(projectDir, branch, abortSignal)
  );
}

function resolveConfiguredBaseBranch(projectDir: string, explicitBaseBranch?: string): string | undefined {
  if (explicitBaseBranch !== undefined) {
    const normalized = explicitBaseBranch.trim();
    if (normalized.length === 0) {
      throw new Error('Base branch override must not be empty.');
    }
    return normalized;
  }
  return resolveConfigValue(projectDir, 'baseBranch');
}

function assertValidBranchRef(projectDir: string, ref: string): void {
  try {
    execFileSync('git', ['check-ref-format', '--branch', ref], {
      cwd: projectDir,
      stdio: 'pipe',
    });
  } catch {
    throw new Error(`Invalid base branch: ${ref}`);
  }
}

export function resolveBaseBranch(
  projectDir: string,
  explicitBaseBranch?: string,
): { branch: string; fetchedCommit?: string } {
  const configBaseBranch = resolveConfiguredBaseBranch(projectDir, explicitBaseBranch);
  const autoFetch = resolveConfigValue(projectDir, 'autoFetch');

  const baseBranch = configBaseBranch ?? detectDefaultBranch(projectDir);

  if (explicitBaseBranch !== undefined) {
    assertValidBranchRef(projectDir, baseBranch);
  }

  if (explicitBaseBranch !== undefined && !branchExists(projectDir, baseBranch)) {
    throw new Error(`Base branch does not exist: ${baseBranch}`);
  }

  if (!autoFetch) {
    return { branch: baseBranch };
  }

  try {
    execFileSync('git', ['fetch', 'origin'], {
      cwd: projectDir,
      stdio: 'pipe',
    });

    const fetchedCommit = execFileSync(
      'git', ['rev-parse', `origin/${baseBranch}`],
      { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();

    log.info('Fetched remote and resolved base branch', { baseBranch, fetchedCommit });
    return { branch: baseBranch, fetchedCommit };
  } catch (err) {
    log.info('Failed to fetch from remote, continuing with local state', { baseBranch, error: String(err) });
    return { branch: baseBranch };
  }
}

export async function resolveBaseBranchAbortable(
  projectDir: string,
  explicitBaseBranch?: string,
  abortSignal?: AbortSignal,
): Promise<{ branch: string; fetchedCommit?: string }> {
  const configBaseBranch = resolveConfiguredBaseBranch(projectDir, explicitBaseBranch);
  const autoFetch = resolveConfigValue(projectDir, 'autoFetch');

  const baseBranch = configBaseBranch ?? detectDefaultBranch(projectDir);

  if (explicitBaseBranch !== undefined) {
    assertValidBranchRef(projectDir, baseBranch);
  }

  if (explicitBaseBranch !== undefined && !await branchExistsAbortable(projectDir, baseBranch, abortSignal)) {
    throw new Error(`Base branch does not exist: ${baseBranch}`);
  }

  if (!autoFetch) {
    return { branch: baseBranch };
  }

  try {
    await runGitCommandAbortable(projectDir, ['fetch', 'origin'], abortSignal);
    const { stdout } = await runGitCommandAbortable(projectDir, ['rev-parse', `origin/${baseBranch}`], abortSignal);
    const fetchedCommit = stdout.trim();

    log.info('Fetched remote and resolved base branch', { baseBranch, fetchedCommit });
    return { branch: baseBranch, fetchedCommit };
  } catch (err) {
    log.info('Failed to fetch from remote, continuing with local state', { baseBranch, error: String(err) });
    return { branch: baseBranch };
  }
}
