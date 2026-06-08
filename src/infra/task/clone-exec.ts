import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { loadProjectConfig } from '../config/index.js';
import { isTaskAbortError, TASK_EXECUTION_ABORTED_MESSAGE } from './clone-errors.js';

const log = createLogger('clone');
const CLONE_FAILED_MESSAGE = 'Git clone failed';
const REMOTE_BRANCH_FETCH_FAILED_MESSAGE = 'Git remote branch fetch failed';
const ISOLATED_GIT_ENV = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.logAllRefUpdates',
  GIT_CONFIG_VALUE_0: 'false',
} as const;

export function resolveCloneSubmoduleOptions(projectDir: string): { args: string[]; label: string; targets: string } {
  const config = loadProjectConfig(projectDir);
  const resolvedSubmodules = config.submodules ?? (config.withSubmodules === true ? 'all' : undefined);

  if (resolvedSubmodules === 'all') {
    return {
      args: ['--recurse-submodules'],
      label: 'with submodule',
      targets: 'all',
    };
  }

  if (Array.isArray(resolvedSubmodules) && resolvedSubmodules.length > 0) {
    return {
      args: resolvedSubmodules.map((submodulePath) => `--recurse-submodules=${submodulePath}`),
      label: 'with submodule',
      targets: resolvedSubmodules.join(', '),
    };
  }

  return {
    args: [],
    label: 'without submodule',
    targets: 'none',
  };
}

function isLinkedWorktree(projectDir: string): boolean {
  try {
    return fs.statSync(path.join(projectDir, '.git')).isFile();
  } catch {
    return false;
  }
}

function getExecErrorStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) {
    return '';
  }

  const stderr = (error as { stderr?: unknown }).stderr;
  if (Buffer.isBuffer(stderr)) {
    return stderr.toString();
  }
  if (typeof stderr === 'string') {
    return stderr;
  }
  return '';
}

function isShallowReferenceError(message: string): boolean {
  return message.includes('reference repository is shallow');
}

function cloneFailedError(): Error {
  return new Error(CLONE_FAILED_MESSAGE);
}

function isolatedGitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...ISOLATED_GIT_ENV };
}

function runIsolatedGitCommandSync(gitCwd: string, args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd: gitCwd,
    stdio: 'pipe',
    env: isolatedGitEnv(),
  });
}

function runIsolatedGitCommandAbortable(
  gitCwd: string,
  args: string[],
  abortSignal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return runGitCommandAbortable(gitCwd, args, abortSignal, isolatedGitEnv());
}

function cleanupPartialClone(clonePath: string): void {
  try {
    fs.rmSync(clonePath, { recursive: true, force: true });
  } catch {
    log.debug('Failed to cleanup partial clone before retry');
  }
}

export function fetchRemoteBranchIntoIsolatedClone(projectDir: string, clonePath: string, branch: string): void {
  try {
    runIsolatedGitCommandSync(clonePath, [
      'fetch',
      '--no-write-fetch-head',
      projectDir,
      `refs/remotes/origin/${branch}:refs/heads/${branch}`,
    ]);
  } catch {
    throw new Error(REMOTE_BRANCH_FETCH_FAILED_MESSAGE);
  }
}

export async function fetchRemoteBranchIntoIsolatedCloneAbortable(
  projectDir: string,
  clonePath: string,
  branch: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  try {
    await runIsolatedGitCommandAbortable(clonePath, [
      'fetch',
      '--no-write-fetch-head',
      projectDir,
      `refs/remotes/origin/${branch}:refs/heads/${branch}`,
    ], abortSignal);
  } catch (err) {
    if (isTaskAbortError(err)) {
      throw err;
    }
    throw new Error(REMOTE_BRANCH_FETCH_FAILED_MESSAGE);
  }
}

export function fetchBaseBranchIntoIsolatedClone(projectDir: string, clonePath: string, branch: string): void {
  try {
    runIsolatedGitCommandSync(clonePath, [
      'fetch',
      '--no-write-fetch-head',
      projectDir,
      `refs/remotes/origin/${branch}:refs/takt/base/${branch}`,
    ]);
  } catch {
    throw new Error(REMOTE_BRANCH_FETCH_FAILED_MESSAGE);
  }
}

export async function fetchBaseBranchIntoIsolatedCloneAbortable(
  projectDir: string,
  clonePath: string,
  branch: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  try {
    await runIsolatedGitCommandAbortable(clonePath, [
      'fetch',
      '--no-write-fetch-head',
      projectDir,
      `refs/remotes/origin/${branch}:refs/takt/base/${branch}`,
    ], abortSignal);
  } catch (err) {
    if (isTaskAbortError(err)) {
      throw err;
    }
    throw new Error(REMOTE_BRANCH_FETCH_FAILED_MESSAGE);
  }
}

export function cloneAndIsolate(projectDir: string, clonePath: string, branch?: string): void {
  const cloneSubmoduleOptions = resolveCloneSubmoduleOptions(projectDir);
  const useReferenceClone = !isLinkedWorktree(projectDir);

  fs.mkdirSync(path.dirname(clonePath), { recursive: true });

  const branchArgs = branch ? ['--branch', branch] : [];
  const commonArgs: string[] = [
    ...cloneSubmoduleOptions.args,
    ...branchArgs,
    projectDir,
    clonePath,
  ];

  const fallbackCloneArgs = ['clone', ...commonArgs];
  const referenceCloneArgs = useReferenceClone
    ? ['clone', '--reference', projectDir, '--dissociate', ...commonArgs]
    : fallbackCloneArgs;

  try {
    runIsolatedGitCommandSync(projectDir, referenceCloneArgs);
  } catch (err) {
    const stderr = getExecErrorStderr(err);
    if (isShallowReferenceError(stderr)) {
      log.info('Reference repository is shallow, retrying clone without --reference');
      cleanupPartialClone(clonePath);
      try {
        runIsolatedGitCommandSync(projectDir, fallbackCloneArgs);
      } catch {
        throw cloneFailedError();
      }
    } else {
      throw cloneFailedError();
    }
  }

  execFileSync('git', ['remote', 'remove', 'origin'], {
    cwd: clonePath,
    stdio: 'pipe',
  });

  for (const key of ['user.name', 'user.email']) {
    try {
      const value = execFileSync('git', ['config', '--local', key], {
        cwd: projectDir,
        stdio: 'pipe',
      }).toString().trim();
      if (value) {
        execFileSync('git', ['config', key, value], {
          cwd: clonePath,
          stdio: 'pipe',
        });
      }
    } catch (err) {
      log.debug('Local git config not found', { key, error: String(err) });
    }
  }
}

function terminateProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): boolean {
  if (child.pid != null) {
    try {
      return process.kill(-child.pid, signal);
    } catch {
      // Fall through to direct child signal.
    }
  }

  return child.kill(signal);
}

export function runGitCommandAbortable(
  gitCwd: string,
  args: string[],
  abortSignal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error(TASK_EXECUTION_ABORTED_MESSAGE));
      return;
    }

    const child = spawn('git', args, {
      cwd: gitCwd,
      stdio: 'pipe',
      detached: true,
      env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanup = (): void => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
    };

    const resolveOnce = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({ stdout, stderr });
    };

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = (): void => {
      terminateProcessGroup(child, 'SIGINT');
      const killTimer = setTimeout(() => {
        if (!settled) {
          terminateProcessGroup(child, 'SIGKILL');
        }
      }, 500);
      killTimer.unref?.();
      rejectOnce(new Error(TASK_EXECUTION_ABORTED_MESSAGE));
    };

    abortSignal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (error) => {
      rejectOnce(error);
    });
    child.on('close', (code) => {
      if (abortSignal?.aborted) {
        rejectOnce(new Error(TASK_EXECUTION_ABORTED_MESSAGE));
        return;
      }
      if (code === 0) {
        resolveOnce();
        return;
      }
      const message = stderr.trim() || `git ${args[0]} exited with code ${code}`;
      rejectOnce(new Error(message));
    });
  });
}

function runGitCloneAbortable(
  gitCwd: string,
  args: string[],
  abortSignal?: AbortSignal,
): Promise<void> {
  return runIsolatedGitCommandAbortable(gitCwd, args, abortSignal).then(() => undefined);
}

export async function cloneAndIsolateAbortable(
  projectDir: string,
  clonePath: string,
  branch?: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const cloneSubmoduleOptions = resolveCloneSubmoduleOptions(projectDir);
  const useReferenceClone = !isLinkedWorktree(projectDir);

  fs.mkdirSync(path.dirname(clonePath), { recursive: true });

  const branchArgs = branch ? ['--branch', branch] : [];
  const commonArgs: string[] = [
    ...cloneSubmoduleOptions.args,
    ...branchArgs,
    projectDir,
    clonePath,
  ];

  const fallbackCloneArgs = ['clone', ...commonArgs];
  const referenceCloneArgs = useReferenceClone
    ? ['clone', '--reference', projectDir, '--dissociate', ...commonArgs]
    : fallbackCloneArgs;

  try {
    await runGitCloneAbortable(projectDir, referenceCloneArgs, abortSignal);
  } catch (err) {
    if (isTaskAbortError(err)) {
      throw err;
    }

    const stderr = getErrorMessage(err);
    if (isShallowReferenceError(stderr)) {
      log.info('Reference repository is shallow, retrying clone without --reference');
      cleanupPartialClone(clonePath);
      try {
        await runGitCloneAbortable(projectDir, fallbackCloneArgs, abortSignal);
      } catch (fallbackErr) {
        if (isTaskAbortError(fallbackErr)) {
          throw fallbackErr;
        }
        throw cloneFailedError();
      }
    } else {
      throw cloneFailedError();
    }
  }

  execFileSync('git', ['remote', 'remove', 'origin'], {
    cwd: clonePath,
    stdio: 'pipe',
  });

  for (const key of ['user.name', 'user.email']) {
    try {
      const value = execFileSync('git', ['config', '--local', key], {
        cwd: projectDir,
        stdio: 'pipe',
      }).toString().trim();
      if (value) {
        execFileSync('git', ['config', key, value], {
          cwd: clonePath,
          stdio: 'pipe',
        });
      }
    } catch (err) {
      log.debug('Local git config not found', { key, error: String(err) });
    }
  }
}
