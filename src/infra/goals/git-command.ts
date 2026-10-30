import { spawnSync } from 'node:child_process';
import { spawnManagedProcess } from '../../shared/utils/spawn.js';
import { buildSafeGitEnvironment } from '../task/git-environment.js';
import { toLocalBranchRef, toRemoteTrackingBranchRef } from '../../shared/utils/gitBranchValidation.js';

export interface GoalGitOutput {
  output: Buffer;
  truncated: boolean;
  code: number;
}

function mergeTreeFailure(message: string, version: string | undefined): Error {
  const detected = version?.trim();
  return new Error(`Git >= 2.38 is required for git merge-tree --write-tree.${detected ? ` Detected Git: ${detected}.` : ''} ${message}`);
}

export async function runGoalGit(
  cwd: string, args: readonly string[], limit: number, signal: AbortSignal | undefined,
  acceptedCodes: readonly number[] = [0],
): Promise<GoalGitOutput> {
  signal?.throwIfAborted();
  const managed = spawnManagedProcess('git', [
    '-c', 'commit.gpgSign=false', '-c', 'merge.gpgSign=false', ...args,
  ], {
    cwd, env: await buildSafeGitEnvironment(cwd, { allowGitHooks: false, allowGitFilters: false }),
    stdio: ['ignore', 'pipe', 'pipe'],
  }, signal);
  const { child } = managed;
  if (child.stdout === null || child.stderr === null) {
    await managed.terminate();
    throw new Error('Unable to capture goal Git output');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  const errors: Buffer[] = [];
  let errorBytes = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    const remaining = Math.max(0, limit - bytes);
    if (chunk.length > remaining) truncated = true;
    if (remaining > 0) {
      const captured = chunk.subarray(0, remaining);
      chunks.push(Buffer.from(captured));
      bytes += captured.length;
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const captured = chunk.subarray(0, Math.max(0, 4096 - errorBytes));
    if (captured.length > 0) { errors.push(Buffer.from(captured)); errorBytes += captured.length; }
  });
  const result = await managed.wait();
  if (result.signal !== null || result.code === null || !acceptedCodes.includes(result.code)) {
    const message = `Goal Git ${args[0]} failed (${result.signal ?? result.code}): ${Buffer.concat(errors).toString('utf8').trim()}`;
    if (result.signal === null && result.code !== null && args[0] === 'merge-tree' && args[1] === '--write-tree') {
      // Version diagnostics must not replace the original merge failure.
      const version = await goalGitText(cwd, ['--version'], signal).catch(() => undefined);
      throw mergeTreeFailure(message, version);
    }
    throw new Error(message);
  }
  return { output: Buffer.concat(chunks), truncated, code: result.code };
}

export async function goalGitText(cwd: string, args: readonly string[], signal: AbortSignal | undefined): Promise<string> {
  const result = await runGoalGit(cwd, args, 8 * 1024 * 1024, signal);
  return completeOutput(result).trim();
}

export async function resolveGoalBranchSha(cwd: string, branch: string, signal: AbortSignal | undefined): Promise<string> {
  return goalGitText(cwd, ['rev-parse', '--verify', `${toLocalBranchRef(branch)}^{commit}`], signal);
}

export async function fetchGoalIntegrationBranchSha(cwd: string, branch: string, signal: AbortSignal | undefined): Promise<string> {
  const localRef = toLocalBranchRef(branch);
  const remoteRef = toRemoteTrackingBranchRef(branch);
  const timeout = AbortSignal.timeout(30_000);
  await goalGitText(cwd, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', `+${localRef}:${remoteRef}`],
    signal === undefined ? timeout : AbortSignal.any([signal, timeout]));
  return goalGitText(cwd, ['rev-parse', '--verify', `${remoteRef}^{commit}`], signal);
}

export async function isGoalCommitIncluded(cwd: string, source: string, target: string, signal: AbortSignal | undefined): Promise<boolean> {
  const result = await runGoalGit(cwd, ['merge-base', '--is-ancestor', source, target], 0, signal, [0, 1]);
  return result.code === 0;
}

const CONTENT_OUTPUT_LIMIT = 8 * 1024 * 1024;

function completeOutput(result: GoalGitOutput): string {
  if (result.truncated) throw new Error('Goal Git output exceeds the complete-output limit');
  return result.output.toString('utf8');
}

function parseObjectId(output: string): string {
  const oid = output.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error('Goal Git returned an incomplete object ID');
  return oid;
}

function parseMergeTree(output: string): string {
  return parseObjectId(output.split('\n', 1)[0]!);
}

export async function isGoalContentIncluded(
  cwd: string, source: string, target: string, signal: AbortSignal | undefined,
): Promise<boolean> {
  if (await isGoalCommitIncluded(cwd, source, target, signal)) return true;
  const merged = await runGoalGit(cwd, ['merge-tree', '--write-tree', target, source], CONTENT_OUTPUT_LIMIT, signal, [0, 1]);
  const mergedTree = parseMergeTree(completeOutput(merged));
  if (merged.code === 1) return false;
  const targetTree = parseObjectId(await goalGitText(cwd, ['rev-parse', `${target}^{tree}`], signal));
  return mergedTree === targetTree;
}

function runGoalGitSync(
  cwd: string, args: readonly string[], env: NodeJS.ProcessEnv, acceptedCodes: readonly number[],
) {
  const result = spawnSync('git', [
    '-c', 'commit.gpgSign=false', '-c', 'merge.gpgSign=false', ...args,
  ], {
    cwd, env,
    encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: CONTENT_OUTPUT_LIMIT,
  });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null || result.status === null || !acceptedCodes.includes(result.status)) {
    const message = `Goal Git ${args[0]} failed (${result.signal ?? result.status}): ${result.stderr.toString('utf8').trim()}`;
    if (result.signal === null && result.status !== null && args[0] === 'merge-tree' && args[1] === '--write-tree') {
      let version: string | undefined;
      try {
        version = runGoalGitSync(cwd, ['--version'], env, [0]).stdout.toString('utf8');
      } catch {
        // Version diagnostics must not replace the original merge failure.
      }
      throw mergeTreeFailure(message, version);
    }
    throw new Error(message);
  }
  return result;
}

export function resolveGoalBranchShaSync(cwd: string, branch: string, env: NodeJS.ProcessEnv): string {
  const result = runGoalGitSync(cwd, ['rev-parse', '--verify', `${toLocalBranchRef(branch)}^{commit}`], env, [0]);
  return parseObjectId(result.stdout.toString('utf8'));
}

export function resolveGoalRemoteBranchShaSync(cwd: string, branch: string, env: NodeJS.ProcessEnv): string {
  const result = runGoalGitSync(cwd, ['rev-parse', '--verify', `${toRemoteTrackingBranchRef(branch)}^{commit}`], env, [0]);
  return parseObjectId(result.stdout.toString('utf8'));
}

export function isGoalContentIncludedSync(cwd: string, source: string, target: string, env: NodeJS.ProcessEnv): boolean {
  if (runGoalGitSync(cwd, ['merge-base', '--is-ancestor', source, target], env, [0, 1]).status === 0) return true;
  const merged = runGoalGitSync(cwd, ['merge-tree', '--write-tree', target, source], env, [0, 1]);
  const mergedTree = parseMergeTree(merged.stdout.toString('utf8'));
  if (merged.status === 1) return false;
  const targetTree = parseObjectId(runGoalGitSync(cwd, ['rev-parse', `${target}^{tree}`], env, [0]).stdout.toString('utf8'));
  return mergedTree === targetTree;
}
