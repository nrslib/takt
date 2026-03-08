import { execFileSync } from 'node:child_process';
import { createLogger } from '../../shared/utils/index.js';
import { resolveConfigValue } from '../config/index.js';
import { detectDefaultBranch } from './branchList.js';

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
