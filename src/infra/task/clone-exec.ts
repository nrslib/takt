import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createLogger } from '../../shared/utils/index.js';
import { loadProjectConfig } from '../config/index.js';

const log = createLogger('clone');

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

function resolveMainRepo(projectDir: string): string {
  const gitPath = path.join(projectDir, '.git');

  try {
    const stats = fs.statSync(gitPath);
    if (stats.isFile()) {
      const content = fs.readFileSync(gitPath, 'utf-8');
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match && match[1]) {
        const worktreePath = match[1].trim();
        const gitDir = path.resolve(worktreePath, '..', '..');
        const mainRepoPath = path.dirname(gitDir);
        log.info('Detected worktree, using main repo', { worktree: projectDir, mainRepo: mainRepoPath });
        return mainRepoPath;
      }
    }
  } catch (err) {
    log.debug('Failed to resolve main repo, using projectDir as-is', { error: String(err) });
  }

  return projectDir;
}

export function cloneAndIsolate(projectDir: string, clonePath: string, branch?: string): void {
  const referenceRepo = resolveMainRepo(projectDir);
  const cloneSubmoduleOptions = resolveCloneSubmoduleOptions(projectDir);

  fs.mkdirSync(path.dirname(clonePath), { recursive: true });

  const branchArgs = branch ? ['--branch', branch] : [];
  const commonArgs: string[] = [
    ...cloneSubmoduleOptions.args,
    ...branchArgs,
    projectDir,
    clonePath,
  ];

  const referenceCloneArgs = ['clone', '--reference', referenceRepo, '--dissociate', ...commonArgs];
  const fallbackCloneArgs = ['clone', ...commonArgs];

  try {
    execFileSync('git', referenceCloneArgs, {
      cwd: projectDir,
      stdio: 'pipe',
    });
  } catch (err) {
    const stderr = ((err as { stderr?: Buffer }).stderr ?? Buffer.alloc(0)).toString();
    if (stderr.includes('reference repository is shallow')) {
      log.info('Reference repository is shallow, retrying clone without --reference', { referenceRepo });
      try { fs.rmSync(clonePath, { recursive: true, force: true }); } catch (e) { log.debug('Failed to cleanup partial clone before retry', { clonePath, error: String(e) }); }
      execFileSync('git', fallbackCloneArgs, {
        cwd: projectDir,
        stdio: 'pipe',
      });
    } else {
      throw err;
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
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error('Task execution aborted'));
      return;
    }

    const child = spawn('git', args, {
      cwd: gitCwd,
      stdio: 'pipe',
      detached: true,
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
      rejectOnce(new Error('Task execution aborted'));
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
        rejectOnce(new Error('Task execution aborted'));
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
  return runGitCommandAbortable(gitCwd, args, abortSignal).then(() => undefined);
}

export async function cloneAndIsolateAbortable(
  projectDir: string,
  clonePath: string,
  branch?: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const referenceRepo = resolveMainRepo(projectDir);
  const cloneSubmoduleOptions = resolveCloneSubmoduleOptions(projectDir);

  fs.mkdirSync(path.dirname(clonePath), { recursive: true });

  const branchArgs = branch ? ['--branch', branch] : [];
  const commonArgs: string[] = [
    ...cloneSubmoduleOptions.args,
    ...branchArgs,
    projectDir,
    clonePath,
  ];

  const referenceCloneArgs = ['clone', '--reference', referenceRepo, '--dissociate', ...commonArgs];
  const fallbackCloneArgs = ['clone', ...commonArgs];

  try {
    await runGitCloneAbortable(projectDir, referenceCloneArgs, abortSignal);
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err);
    if (stderr.includes('reference repository is shallow')) {
      log.info('Reference repository is shallow, retrying clone without --reference', { referenceRepo });
      try {
        fs.rmSync(clonePath, { recursive: true, force: true });
      } catch (cleanupErr) {
        log.debug('Failed to cleanup partial clone before retry', { clonePath, error: String(cleanupErr) });
      }
      await runGitCloneAbortable(projectDir, fallbackCloneArgs, abortSignal);
    } else {
      throw err;
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
