import { spawnSync } from 'node:child_process';
import { spawnManagedProcess } from '../../shared/utils/spawn.js';
import { buildSafeGitEnvironment } from '../task/git-environment.js';
import { toLocalBranchRef } from '../../shared/utils/gitBranchValidation.js';

export interface GoalGitOutput {
  output: Buffer;
  truncated: boolean;
  code: number;
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
    throw new Error(`Goal Git ${args[0]} failed (${result.signal ?? result.code}): ${Buffer.concat(errors).toString('utf8').trim()}`);
  }
  return { output: Buffer.concat(chunks), truncated, code: result.code };
}

export async function goalGitText(cwd: string, args: readonly string[], signal: AbortSignal | undefined): Promise<string> {
  const result = await runGoalGit(cwd, args, 8 * 1024 * 1024, signal);
  if (result.truncated) throw new Error('Goal Git output exceeds the complete-output limit');
  return result.output.toString('utf8').trim();
}

export async function resolveGoalBranchSha(cwd: string, branch: string, signal: AbortSignal | undefined): Promise<string> {
  return goalGitText(cwd, ['rev-parse', '--verify', `${toLocalBranchRef(branch)}^{commit}`], signal);
}

export async function isGoalCommitIncluded(cwd: string, source: string, target: string, signal: AbortSignal | undefined): Promise<boolean> {
  const result = await runGoalGit(cwd, ['merge-base', '--is-ancestor', source, target], 0, signal, [0, 1]);
  return result.code === 0;
}

const CONTENT_OUTPUT_LIMIT = 8 * 1024 * 1024;

function parseCommitSha(output: string): string {
  const sha = output.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error('Goal Git returned an incomplete commit SHA');
  return sha;
}

function changedPathArgs(source: string, target: string): string[] {
  return ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', source, target, '--'];
}

function parseChangedPaths(output: Buffer): string[] {
  if (output.length === 0) return [];
  if (output.at(-1) !== 0) throw new Error('Goal Git returned incomplete changed paths');
  // Git のパスは任意のバイト列なので、UTF-8 の置換文字による衝突を避ける。
  return output.subarray(0, -1).toString('latin1').split('\0');
}

function goalPathsMatch(changed: Buffer, different: Buffer): boolean {
  const differingPaths = new Set(parseChangedPaths(different));
  return !parseChangedPaths(changed).some((path) => differingPaths.has(path));
}

export async function isGoalContentIncluded(
  cwd: string, source: string, target: string, signal: AbortSignal | undefined,
): Promise<boolean> {
  if (await isGoalCommitIncluded(cwd, source, target, signal)) return true;
  const base = parseCommitSha(await goalGitText(cwd, ['merge-base', source, target], signal));
  const changed = await runGoalGit(cwd, changedPathArgs(base, source), CONTENT_OUTPUT_LIMIT, signal);
  if (changed.truncated) throw new Error('Goal Git output exceeds the complete-output limit');
  const different = await runGoalGit(cwd, changedPathArgs(source, target), CONTENT_OUTPUT_LIMIT, signal);
  if (different.truncated) throw new Error('Goal Git output exceeds the complete-output limit');
  return goalPathsMatch(changed.output, different.output);
}

function runGoalGitSync(
  cwd: string, args: readonly string[], env: NodeJS.ProcessEnv, acceptedCodes: readonly number[],
) {
  const result = spawnSync('git', [
    '-c', 'commit.gpgSign=false', '-c', 'merge.gpgSign=false', ...args,
  ], { cwd, env, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: CONTENT_OUTPUT_LIMIT });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null || result.status === null || !acceptedCodes.includes(result.status)) {
    throw new Error(`Goal Git ${args[0]} failed (${result.signal ?? result.status}): ${result.stderr.toString('utf8').trim()}`);
  }
  return result;
}

export function resolveGoalBranchShaSync(cwd: string, branch: string, env: NodeJS.ProcessEnv): string {
  const result = runGoalGitSync(cwd, ['rev-parse', '--verify', `${toLocalBranchRef(branch)}^{commit}`], env, [0]);
  return parseCommitSha(result.stdout.toString('utf8'));
}

export function isGoalContentIncludedSync(cwd: string, source: string, target: string, env: NodeJS.ProcessEnv): boolean {
  if (runGoalGitSync(cwd, ['merge-base', '--is-ancestor', source, target], env, [0, 1]).status === 0) return true;
  const base = parseCommitSha(runGoalGitSync(cwd, ['merge-base', source, target], env, [0]).stdout.toString('utf8'));
  const changed = runGoalGitSync(cwd, changedPathArgs(base, source), env, [0]);
  const different = runGoalGitSync(cwd, changedPathArgs(source, target), env, [0]);
  return goalPathsMatch(changed.stdout, different.stdout);
}
