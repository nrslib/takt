import { execFile } from 'node:child_process';
import { z } from 'zod/v4';
import { PR_STATUS_TIMEOUT_MS, PrStatusTimeoutError,
  type PrStatus, type PrStatusFetchOptions } from '../../core/workflow/system/pr-execution-context.js';

const CheckSchema = z.discriminatedUnion('__typename', [
  z.object({ __typename: z.literal('CheckRun'), status: z.string(), conclusion: z.string().nullable() }),
  z.object({ __typename: z.literal('StatusContext'), state: z.string() }),
]);

const PrStatusSchema = z.object({
  number: z.number().int().positive(),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/i),
  state: z.string(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  reviewDecision: z.string().nullable(),
  statusCheckRollup: z.array(CheckSchema),
});

export async function fetchPrStatus(prNumber: number, cwd: string, options?: PrStatusFetchOptions): Promise<PrStatus> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  const output = await new Promise<string>((resolve, reject) => {
    let terminationError: unknown;
    const child = execFile('gh', [
      'pr', 'view', String(prNumber), '--json',
      'number,headRefOid,state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup',
    ], { cwd, encoding: 'utf-8' }, (error, stdout) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (terminationError !== undefined) reject(terminationError);
      else if (error !== null) reject(error);
      else resolve(stdout);
    });
    // AbortSignal supplied to execFile can reject before the process exits.
    // Kill directly so the callback observes exit before releasing ownership.
    const terminate = (error: unknown) => {
      if (terminationError !== undefined) return;
      terminationError = error;
      child.kill('SIGKILL');
    };
    const abort = () => terminate(signal!.reason);
    const timer = setTimeout(() => terminate(new PrStatusTimeoutError()), options?.timeoutMs ?? PR_STATUS_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  const raw = PrStatusSchema.parse(JSON.parse(output));
  if (raw.number !== prNumber) throw new Error('PR status response does not match the requested PR');
  const checks = raw.statusCheckRollup.map((check) => {
    if (check.__typename === 'StatusContext') {
      return {
        finished: ['SUCCESS', 'FAILURE', 'ERROR'].includes(check.state),
        passed: check.state === 'SUCCESS',
      };
    }
    return {
      finished: check.status === 'COMPLETED',
      passed: check.status === 'COMPLETED' && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion ?? ''),
    };
  });
  const finished = checks.length > 0 && checks.every((check) => check.finished);
  return {
    number: raw.number,
    headSha: raw.headRefOid,
    ci: { finished, passed: finished && checks.every((check) => check.passed) },
    mergeable: raw.mergeable,
    mergeStateStatus: raw.mergeStateStatus,
    reviewDecision: raw.reviewDecision ?? '',
    merged: raw.state === 'MERGED',
  };
}
