import { z } from 'zod/v4';
import { type PrStatus, type PrStatusFetchOptions } from '../../core/workflow/system/pr-execution-context.js';
import { runPrCommand } from './pr-command.js';
import { actionsReference, readCiRerunStatus } from './pr-ci.js';

const CheckSchema = z.discriminatedUnion('__typename', [
  z.object({ __typename: z.literal('CheckRun'), name: z.string(), detailsUrl: z.string().nullish(),
    workflowName: z.string().nullish(), status: z.string(), conclusion: z.string().nullable() }),
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

type RawCheck = z.infer<typeof CheckSchema>;

const RunIdentitySchema = z.object({
  databaseId: z.number().int().positive(),
  url: z.string().url(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i),
  workflowDatabaseId: z.number().int().positive(),
  createdAt: z.string().datetime(),
  status: z.string(),
  conclusion: z.string().nullable(),
});

async function currentCheckRuns(
  checks: RawCheck[], headSha: string, cwd: string, options?: PrStatusFetchOptions,
): Promise<{ checks: RawCheck[]; currentRuns: Array<z.infer<typeof RunIdentitySchema>>;
  supersededRuns: ReadonlyMap<number, string> }> {
  const byWorkflowName = new Map<string, Set<number>>();
  for (const check of checks) {
    if (check.__typename !== 'CheckRun' || !check.workflowName || !check.detailsUrl) continue;
    try {
      const runId = actionsReference(check.detailsUrl).id;
      const ids = byWorkflowName.get(check.workflowName) ?? new Set<number>();
      ids.add(runId);
      byWorkflowName.set(check.workflowName, ids);
    } catch {
      // Unsupported checks remain in the rollup and cannot be superseded.
    }
  }
  const candidateIds = new Set([...byWorkflowName.values()]
    .filter((ids) => ids.size > 1).flatMap((ids) => [...ids]));
  if (candidateIds.size === 0) return { checks, currentRuns: [], supersededRuns: new Map() };

  const repositories = new Map<number, string>();
  for (const check of checks) {
    if (check.__typename !== 'CheckRun' || !check.detailsUrl) continue;
    let reference: ReturnType<typeof actionsReference>;
    try { reference = actionsReference(check.detailsUrl); }
    catch { continue; }
    if (!candidateIds.has(reference.id)) continue;
    const repository = repositories.get(reference.id);
    if (repository !== undefined && repository !== reference.repository) {
      throw new Error('Actions run repository does not match the check');
    }
    repositories.set(reference.id, reference.repository);
  }
  const runs = await Promise.all([...candidateIds].map(async (id) => {
    const run = RunIdentitySchema.parse(JSON.parse(await runPrCommand([
      'run', 'view', String(id), '--json',
      'databaseId,url,headSha,workflowDatabaseId,createdAt,status,conclusion',
    ], cwd, options)));
    const reference = actionsReference(run.url);
    if (run.databaseId !== id || reference.id !== id || reference.repository !== repositories.get(id)) {
      throw new Error('Actions run does not match the check reference');
    }
    return run;
  }));
  const byWorkflow = new Map<string, typeof runs>();
  for (const run of runs) {
    const key = `${actionsReference(run.url).repository}/${run.workflowDatabaseId}`;
    byWorkflow.set(key, [...(byWorkflow.get(key) ?? []), run]);
  }
  const supersededRuns = new Map<number, string>();
  const currentRuns: typeof runs = [];
  for (const group of byWorkflow.values()) {
    const sameHead = group.every((run) => run.headSha === headSha);
    const latest = group.reduce((candidate, run) => run.createdAt > candidate.createdAt ? run : candidate);
    const uniqueLatest = group.filter((run) => run.createdAt === latest.createdAt).length === 1;
    if (sameHead && uniqueLatest) {
      for (const run of group) {
        if (run.databaseId !== latest.databaseId) {
          supersededRuns.set(run.databaseId, actionsReference(run.url).repository);
        }
      }
      currentRuns.push(latest);
    }
  }
  return { checks: checks.filter((check) => {
    if (check.__typename !== 'CheckRun' || !check.detailsUrl) return true;
    try { return !supersededRuns.has(actionsReference(check.detailsUrl).id); }
    catch { return true; }
  }), currentRuns, supersededRuns };
}

export async function fetchPrStatus(prNumber: number, cwd: string, options?: PrStatusFetchOptions): Promise<PrStatus> {
  const output = await runPrCommand([
    'pr', 'view', String(prNumber), '--json',
    'number,headRefOid,state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup',
  ], cwd, options);
  const raw = PrStatusSchema.parse(JSON.parse(output));
  if (raw.number !== prNumber) throw new Error('PR status response does not match the requested PR');
  const current = await currentCheckRuns(raw.statusCheckRollup, raw.headRefOid, cwd, options);
  const checks = current.checks.map((check) => {
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
  const finished = checks.length > 0 && checks.every((check) => check.finished)
    && current.currentRuns.every((run) => run.status === 'completed');
  const status: PrStatus = {
    number: raw.number,
    headSha: raw.headRefOid,
    ci: { finished, passed: finished && checks.every((check) => check.passed)
      && current.currentRuns.every((run) => ['success', 'neutral', 'skipped'].includes(run.conclusion ?? '')), checks },
    mergeable: raw.mergeable,
    mergeStateStatus: raw.mergeStateStatus,
    reviewDecision: raw.reviewDecision ?? '',
    merged: raw.state === 'MERGED',
  };
  if (options?.rerun !== undefined) {
    status.ci = await readCiRerunStatus(status, options.rerun, cwd, options, current.supersededRuns);
    status.ci.finished = status.ci.finished && current.currentRuns.every((run) => run.status === 'completed');
    status.ci.passed = status.ci.passed && status.ci.finished
      && current.currentRuns.every((run) => ['success', 'neutral', 'skipped'].includes(run.conclusion ?? ''));
  }
  return status;
}
