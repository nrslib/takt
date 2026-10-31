import { resolveCliInvocation } from '../../shared/utils/cli-invocation.js';
import { spawnManagedProcess } from '../../shared/utils/spawn.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { restoreGoalBranch } from '../../infra/goals/git.js';

const OUTPUT_MAX_BYTES = 16 * 1024;

export async function mergeGoalPr(cwd: string, prNumber: number, branch: string, approvedSha: string, signal: AbortSignal) {
  const outcome = await runGoalPrMerge(cwd, prNumber, signal).then(
    (result) => ({ success: true as const, result }),
    (error: unknown) => ({ success: false as const, error }),
  );
  try {
    // The goal owns this ref beyond the CLI process, including cancellation.
    await restoreGoalBranch(cwd, branch, approvedSha);
  } catch (error) {
    if (!outcome.success) {
      throw new AggregateError([outcome.error, error],
        `Goal PR merge and branch restoration failed: ${getErrorMessage(outcome.error)}; ${getErrorMessage(error)}`);
    }
    throw error;
  }
  if (!outcome.success) throw outcome.error;
  return outcome.result;
}

async function runGoalPrMerge(cwd: string, prNumber: number, signal: AbortSignal) {
  const invocation = resolveCliInvocation('merge');
  const managed = spawnManagedProcess(process.execPath, [...invocation.args, String(prNumber)], {
    cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  }, signal);
  const { child } = managed;
  if (child.stdout === null || child.stderr === null) {
    await managed.terminate();
    throw new Error('Unable to capture goal PR merge output');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  const capture = (chunk: Buffer) => {
    const remaining = OUTPUT_MAX_BYTES - bytes;
    if (chunk.length > remaining) truncated = true;
    if (remaining > 0) {
      const captured = Buffer.from(chunk.subarray(0, remaining));
      chunks.push(captured);
      bytes += captured.length;
    }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const result = await managed.wait();
  const output = Buffer.concat(chunks).toString('utf8');
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`takt merge ${prNumber} failed (${result.signal ?? result.code}): ${output}`);
  }
  return { success: true, prNumber, exitCode: result.code, output, truncated };
}
