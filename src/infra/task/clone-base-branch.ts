import { execFileSync } from 'node:child_process';
import { createLogger } from '../../shared/utils/index.js';
import { resolveConfigValue } from '../config/index.js';
import { detectDefaultBranch } from './branchList.js';
import { runGitCommandAbortable } from './clone-exec.js';
import {
  toLocalBranchRef,
  toRemoteTrackingBranchRef,
} from '../../shared/utils/gitBranchValidation.js';

const log = createLogger('clone');

export function localBranchExists(projectDir: string, branch: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', toLocalBranchRef(branch)], {
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
    execFileSync('git', ['show-ref', '--verify', '--quiet', toRemoteTrackingBranchRef(branch)], {
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

export interface CreateBaseBranchIfMissingConfig {
  name: string;
  create_if_missing: {
    from: string;
    push?: boolean;
  };
}

interface ResolvedBaseBranchCandidate {
  branch?: string;
  requiresValidation: boolean;
}

export async function localBranchExistsAbortable(
  projectDir: string,
  branch: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  try {
    await runGitCommandAbortable(projectDir, ['show-ref', '--verify', '--quiet', toLocalBranchRef(branch)], abortSignal);
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
    await runGitCommandAbortable(projectDir, ['show-ref', '--verify', '--quiet', toRemoteTrackingBranchRef(branch)], abortSignal);
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

function resolveConfiguredBaseBranch(projectDir: string, explicitBaseBranch?: string): ResolvedBaseBranchCandidate {
  if (explicitBaseBranch !== undefined) {
    const normalized = explicitBaseBranch.trim();
    if (normalized.length === 0) {
      throw new Error('Base branch override must not be empty.');
    }
    return { branch: normalized, requiresValidation: true };
  }
  const configBaseBranch = resolveConfigValue(projectDir, 'baseBranch');
  return {
    branch: configBaseBranch,
    requiresValidation: configBaseBranch !== undefined,
  };
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

function assertExplicitBaseBranch(projectDir: string, branch: string): void {
  assertValidBranchRef(projectDir, branch);
}

function resolveBaseBranchStartPoint(projectDir: string, branch: string): string {
  if (localBranchExists(projectDir, branch)) {
    return toLocalBranchRef(branch);
  }
  if (remoteBranchExists(projectDir, branch)) {
    return toRemoteTrackingBranchRef(branch);
  }
  throw new Error(`Base branch source does not exist: ${branch}`);
}

export function createBaseBranchIfMissing(
  projectDir: string,
  config: CreateBaseBranchIfMissingConfig,
): { branch: string; created: boolean } {
  assertExplicitBaseBranch(projectDir, config.name);
  assertExplicitBaseBranch(projectDir, config.create_if_missing.from);

  if (branchExists(projectDir, config.name)) {
    return { branch: config.name, created: false };
  }

  const startPoint = resolveBaseBranchStartPoint(projectDir, config.create_if_missing.from);

  execFileSync('git', ['branch', config.name, startPoint], {
    cwd: projectDir,
    stdio: 'pipe',
  });

  if (config.create_if_missing.push === true) {
    execFileSync('git', ['push', 'origin', config.name], {
      cwd: projectDir,
      stdio: 'pipe',
    });
  }

  return { branch: config.name, created: true };
}

export function resolveBaseBranch(
  projectDir: string,
  explicitBaseBranch?: string,
): { branch: string; fetchedCommit?: string } {
  const baseBranch = resolveBaseBranchName(projectDir, explicitBaseBranch);
  const autoFetch = resolveConfigValue(projectDir, 'autoFetch');

  if (!autoFetch) {
    return { branch: baseBranch };
  }

  try {
    execFileSync('git', ['fetch', 'origin'], {
      cwd: projectDir,
      stdio: 'pipe',
    });

    const fetchedCommit = execFileSync(
      'git', ['rev-parse', toRemoteTrackingBranchRef(baseBranch)],
      { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();

    log.info('Fetched remote and resolved base branch', { baseBranch, fetchedCommit });
    return { branch: baseBranch, fetchedCommit };
  } catch (err) {
    log.info('Failed to fetch from remote, continuing with local state', { baseBranch, error: String(err) });
    return { branch: baseBranch };
  }
}

export function resolveBaseBranchName(
  projectDir: string,
  explicitBaseBranch?: string,
): string {
  const resolved = resolveConfiguredBaseBranch(projectDir, explicitBaseBranch);
  const baseBranch = resolved.branch ?? detectDefaultBranch(projectDir);

  if (resolved.requiresValidation) {
    assertExplicitBaseBranch(projectDir, baseBranch);
  }

  if (resolved.requiresValidation && !branchExists(projectDir, baseBranch)) {
    throw new Error(`Base branch does not exist: ${baseBranch}`);
  }

  return baseBranch;
}

export async function resolveBaseBranchAbortable(
  projectDir: string,
  explicitBaseBranch?: string,
  abortSignal?: AbortSignal,
): Promise<{ branch: string; fetchedCommit?: string }> {
  const resolved = resolveConfiguredBaseBranch(projectDir, explicitBaseBranch);
  const autoFetch = resolveConfigValue(projectDir, 'autoFetch');

  const baseBranch = resolved.branch ?? detectDefaultBranch(projectDir);

  if (resolved.requiresValidation) {
    assertExplicitBaseBranch(projectDir, baseBranch);
  }

  if (resolved.requiresValidation && !await branchExistsAbortable(projectDir, baseBranch, abortSignal)) {
    throw new Error(`Base branch does not exist: ${baseBranch}`);
  }

  if (!autoFetch) {
    return { branch: baseBranch };
  }

  try {
    await runGitCommandAbortable(projectDir, ['fetch', 'origin'], abortSignal);
    const { stdout } = await runGitCommandAbortable(
      projectDir,
      ['rev-parse', toRemoteTrackingBranchRef(baseBranch)],
      abortSignal,
    );
    const fetchedCommit = stdout.trim();

    log.info('Fetched remote and resolved base branch', { baseBranch, fetchedCommit });
    return { branch: baseBranch, fetchedCommit };
  } catch (err) {
    log.info('Failed to fetch from remote, continuing with local state', { baseBranch, error: String(err) });
    return { branch: baseBranch };
  }
}
