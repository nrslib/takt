import { z } from 'zod/v4';
import { type PrStatus, type PrStatusFetchOptions } from '../../core/workflow/system/pr-execution-context.js';
import { runPrCommand } from './pr-command.js';
import { readCiRerunStatus } from './pr-ci.js';

const CheckSchema = z.discriminatedUnion('__typename', [
  z.object({ __typename: z.literal('CheckRun'), name: z.string(), detailsUrl: z.string().nullish(),
    status: z.string(), conclusion: z.string().nullable() }),
  z.object({ __typename: z.literal('StatusContext'), context: z.string(), targetUrl: z.string().nullish(), state: z.string() }),
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
  const output = await runPrCommand([
    'pr', 'view', String(prNumber), '--json',
    'number,headRefOid,state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup',
  ], cwd, options);
  const raw = PrStatusSchema.parse(JSON.parse(output));
  if (raw.number !== prNumber) throw new Error('PR status response does not match the requested PR');
  const checks = raw.statusCheckRollup.map((check) => {
    if (check.__typename === 'StatusContext') {
      return {
        kind: check.__typename,
        name: check.context,
        url: check.targetUrl ?? null,
        finished: ['SUCCESS', 'FAILURE', 'ERROR'].includes(check.state),
        passed: check.state === 'SUCCESS',
      };
    }
    return {
      kind: check.__typename,
      name: check.name,
      url: check.detailsUrl ?? null,
      finished: check.status === 'COMPLETED',
      passed: check.status === 'COMPLETED' && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion ?? ''),
    };
  });
  const finished = checks.length > 0 && checks.every((check) => check.finished);
  const status: PrStatus = {
    number: raw.number,
    headSha: raw.headRefOid,
    ci: { finished, passed: finished && checks.every((check) => check.passed), checks },
    mergeable: raw.mergeable,
    mergeStateStatus: raw.mergeStateStatus,
    reviewDecision: raw.reviewDecision ?? '',
    merged: raw.state === 'MERGED',
  };
  if (options?.rerun !== undefined) {
    status.ci = await readCiRerunStatus(status, options.rerun, cwd, options);
  }
  return status;
}
