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
