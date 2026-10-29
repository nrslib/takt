import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PrCiFailure } from '../../../core/workflow/system/pr-ci.js';
import type { RunPaths } from '../../../core/workflow/run/run-paths.js';
import { isRealPathInside } from '../../../shared/utils/pathBoundary.js';
import { ensureWorktreeTaktRunsIgnored } from '../../task/projectLocalTaktSync.js';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeOnce(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') throw error;
    if (!(await lstat(path)).isFile()) throw new Error('Saved CI evidence is not a regular file');
    if (await readFile(path, 'utf8') !== content) throw new Error('Saved CI evidence differs from the current run');
  }
}

async function saveIndex(
  failure: PrCiFailure,
  directory: string,
  fixRounds: number,
  rerunCount: number,
  recoveryError: unknown,
  signal?: AbortSignal,
): Promise<{ failure: PrCiFailure; manifestPath: string; logCount: number }> {
  const saved = new Map<string, string>();
  const unavailable = [...failure.unavailable];
  const addUnavailable = (item: PrCiFailure['unavailable'][number]) => {
    if (unavailable.some((existing) => existing.name === item.name && existing.url === item.url
      && existing.reason === item.reason)) return;
    unavailable.push(item);
  };
  const checks = [];
  for (const check of failure.checks) {
    const jobs = [];
    if (check.jobs.length === 0) {
      addUnavailable({ name: check.name, url: check.run.url, reason: 'Failed check has no job evidence' });
    }
    for (const job of check.jobs) {
      signal?.throwIfAborted();
      if (!job.log?.trim()) {
        if (!unavailable.some((item) => item.name === check.name && item.url === job.url)) {
          addUnavailable({ name: check.name, url: job.url, reason: 'Failed job log is missing' });
        }
        jobs.push({ id: job.id, name: job.name, url: job.url, logPath: null });
        continue;
      }
      const key = JSON.stringify([new URL(check.run.url).origin, new URL(check.run.url).pathname.split('/').slice(0, 3),
        check.run.id, check.run.attempt, job.id]);
      let logPath = saved.get(key);
      if (!logPath) {
        logPath = join(directory, `job-${job.id}-${digest(key)}.log`);
        await writeOnce(logPath, job.log);
        saved.set(key, logPath);
      } else if (await readFile(logPath, 'utf8') !== job.log) {
        throw new Error(`Conflicting CI logs for the same job: ${job.id}`);
      }
      jobs.push({ id: job.id, name: job.name, url: job.url, logPath });
    }
    checks.push({ name: check.name, run: check.run, jobs });
  }
  const complete = failure.complete && unavailable.length === 0 && checks.length > 0;
  const indexedFailure = { ...failure, complete, unavailable };
  const manifest = JSON.stringify({
    number: failure.number, headSha: failure.headSha, complete, fixRounds, rerunCount,
    recoveryError, checks, unavailable,
  }, null, 2);
  const manifestPath = join(directory, `manifest-${digest(manifest)}.json`);
  signal?.throwIfAborted();
  await writeOnce(manifestPath, manifest);
  signal?.throwIfAborted();
  return { failure: indexedFailure, manifestPath, logCount: saved.size };
}

export async function saveCiFailureEvidence(
  failure: PrCiFailure,
  runPaths: RunPaths,
  workspaceCwd: string,
  fixRounds: number,
  rerunCount: number,
  recoveryError: unknown,
  signal?: AbortSignal,
): Promise<{ failure: PrCiFailure; promptEvidence: string }> {
  const canonicalDirectory = join(runPaths.runRootAbs, 'ci-evidence');
  const viewRelativeDirectory = join('.takt', 'runs', runPaths.slug, 'ci-evidence');
  const viewDirectory = join(workspaceCwd, viewRelativeDirectory);
  signal?.throwIfAborted();
  await mkdir(canonicalDirectory, { recursive: true, mode: 0o700 });
  if (!isRealPathInside(runPaths.runRootAbs, canonicalDirectory)) {
    throw new Error('CI evidence directory leaves its run');
  }
  const canonical = await saveIndex(failure, canonicalDirectory, fixRounds, rerunCount, recoveryError, signal);

  ensureWorktreeTaktRunsIgnored(workspaceCwd);
  signal?.throwIfAborted();
  await mkdir(viewDirectory, { recursive: true, mode: 0o700 });
  if (!isRealPathInside(workspaceCwd, viewDirectory)) {
    throw new Error('CI evidence view leaves its workspace');
  }
  if (existsSync(join(workspaceCwd, '.git'))) {
    try {
      execFileSync('git', ['check-ignore', '-q', '--', join(viewRelativeDirectory, 'manifest.json')], {
        cwd: workspaceCwd, stdio: 'ignore',
      });
    } catch {
      throw new Error('CI evidence view is not ignored by Git');
    }
  }
  const view = resolve(canonicalDirectory) === resolve(viewDirectory)
    ? canonical
    : await saveIndex(canonical.failure, viewDirectory, fixRounds, rerunCount, recoveryError, signal);
  return { failure: view.failure,
    promptEvidence: `PR #${failure.number}; HEAD ${failure.headSha}; complete=${view.failure.complete}; checks=${view.failure.checks.length}; unique job logs=${view.logCount}; unavailable=${view.failure.unavailable.length}; fixRounds=${fixRounds}; rerunCount=${rerunCount}.\nEvidence index: ${view.manifestPath}`,
  };
}
