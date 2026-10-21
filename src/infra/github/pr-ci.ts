import { z } from 'zod/v4';
import type { PrStatus, PrStatusFetchOptions } from '../../core/workflow/system/pr-execution-context.js';
import { PrCiFailureSchema, PrCiRerunSchema,
  type PrCiFailure, type PrCiRerun, type PrCiRerunResult } from '../../core/workflow/system/pr-ci.js';
import { runPrCommand } from './pr-command.js';

const FAILED_LOG_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_FAILED_LOG_CHARS = 200_000;

const RunSchema = z.object({
  databaseId: z.number().int().positive(),
  url: z.string().url(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i),
  attempt: z.number().int().positive(),
  status: z.string(),
  conclusion: z.string().nullable(),
  jobs: z.array(z.object({
    databaseId: z.number().int().positive(), name: z.string(), url: z.string().url(),
    status: z.string(), conclusion: z.string().nullable(),
  })),
});
type CiRun = z.infer<typeof RunSchema>;

const PrHeadSchema = z.object({
  number: z.number().int().positive(),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/i),
});

function actionsReference(value: string) {
  const url = new URL(value);
  const match = /^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/attempts\/\d+)?(?:\/jobs?\/\d+)?\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !match) throw new Error('Unsupported Actions check URL');
  return { id: Number(match[3]), repository: `${url.hostname}/${match[1]}/${match[2]}` };
}

async function readRun(id: number, cwd: string, options?: PrStatusFetchOptions, url?: string): Promise<CiRun> {
  const run = RunSchema.parse(JSON.parse(await runPrCommand([
    'run', 'view', String(id), '--json', 'databaseId,url,headSha,attempt,status,conclusion,jobs',
  ], cwd, options)));
  if (run.databaseId !== id || actionsReference(run.url).id !== id) throw new Error('Actions run ID does not match the requested run');
  if (url !== undefined && actionsReference(run.url).repository !== actionsReference(url).repository) {
    throw new Error('Actions run repository does not match the failed check');
  }
  return run;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function collectPrCiFailure(
  status: PrStatus, headSha: string, cwd: string, options?: PrStatusFetchOptions,
): Promise<PrCiFailure> {
  const result: PrCiFailure = { number: status.number, headSha, complete: false, checks: [], unavailable: [] };
  if (status.headSha !== headSha || !status.ci.finished || status.ci.passed) {
    result.unavailable.push({ name: 'CI', reason: 'PR HEAD or completed failure does not match the investigation target' });
    return result;
  }
  const runs = new Map<string, Promise<CiRun>>();
  const logs = new Map<string, Promise<string>>();
  for (const check of status.ci.checks ?? []) {
    if (!check.finished || check.passed) continue;
    try {
      if (check.kind !== 'CheckRun' || check.url === null) throw new Error('Failed check has no supported Actions log reference');
      const reference = actionsReference(check.url);
      const key = `${reference.repository}/${reference.id}`;
      let pending = runs.get(key);
      if (!pending) {
        pending = readRun(reference.id, cwd, options, check.url);
        runs.set(key, pending);
      }
      const run = await pending;
      if (run.headSha !== headSha) throw new Error('Actions run HEAD does not match the failed PR HEAD');
      if (run.status !== 'completed') throw new Error('Actions run has not completed');
      const failedJobs = run.jobs.filter((job) => job.status === 'completed'
        && !['success', 'neutral', 'skipped'].includes(job.conclusion ?? ''));
      if (failedJobs.length === 0) throw new Error('No failed job evidence is available');
      const jobs: PrCiFailure['checks'][number]['jobs'] = [];
      for (const job of failedJobs) {
        const jobReference = actionsReference(job.url);
        if (jobReference.id !== run.databaseId || jobReference.repository !== reference.repository) {
          throw new Error('Failed job reference does not match the Actions run');
        }
        const details = { id: job.databaseId, name: job.name, url: job.url };
        try {
          const logKey = `${key}/${run.attempt}/${job.databaseId}`;
          let pendingLog = logs.get(logKey);
          if (!pendingLog) {
            pendingLog = runPrCommand([
              'run', 'view', String(run.databaseId),
              '--attempt', String(run.attempt), '--job', String(job.databaseId), '--log-failed',
            ], cwd, options, FAILED_LOG_MAX_BUFFER).then((text) => {
              if (text.trim().length === 0) throw new Error(`Failed job ${job.databaseId} has no log content`);
              return text.length > MAX_FAILED_LOG_CHARS
                ? `[truncated: last ${MAX_FAILED_LOG_CHARS} characters]\n${text.slice(-MAX_FAILED_LOG_CHARS)}`
                : text;
            });
            logs.set(logKey, pendingLog);
          }
          const log = await pendingLog;
          jobs.push({ ...details, log });
        } catch (error) {
          options?.signal?.throwIfAborted();
          jobs.push(details);
          result.unavailable.push({ name: check.name, url: job.url, reason: errorText(error) });
        }
      }
      result.checks.push({ name: check.name, run: {
        id: run.databaseId, attempt: run.attempt, headSha: run.headSha, url: run.url,
      }, jobs });
    } catch (error) {
      options?.signal?.throwIfAborted();
      result.unavailable.push({ name: check.name, url: check.url, reason: errorText(error) });
    }
  }
  if (result.checks.length === 0 && result.unavailable.length === 0) {
    result.unavailable.push({ name: 'CI', reason: 'Failed check details are unavailable' });
  }
  result.complete = result.checks.length > 0 && result.unavailable.length === 0;
  return result;
}

export async function rerunPrCi(failure: PrCiFailure, cwd: string, options?: PrStatusFetchOptions): Promise<PrCiRerunResult> {
  const evidence = PrCiFailureSchema.parse(failure);
  const runs = [...new Map(evidence.checks.map(({ run }) => [run.url, {
    id: run.id, attempt: run.attempt, url: run.url,
  }])).values()];
  const result: PrCiRerunResult = { number: evidence.number, headSha: evidence.headSha, runs,
    success: false, failed: true };
  try {
    if (!evidence.complete || evidence.unavailable.length > 0 || runs.length === 0) {
      throw new Error('Complete failure evidence is required to rerun CI');
    }
    // Validate every target before starting any side effect.
    for (const target of runs) {
      const current = await readRun(target.id, cwd, options, target.url);
      if (current.headSha !== evidence.headSha || current.attempt !== target.attempt
        || current.status !== 'completed' || ['success', 'neutral', 'skipped'].includes(current.conclusion ?? '')) {
        throw new Error('Actions run changed since investigation');
      }
    }
    for (const target of runs) {
      const current = PrHeadSchema.parse(JSON.parse(await runPrCommand([
        'pr', 'view', String(evidence.number), '--json', 'number,headRefOid',
      ], cwd, options)));
      if (current.number !== evidence.number) throw new Error('PR status response does not match the requested PR');
      if (current.headRefOid !== evidence.headSha) {
        return { ...result, headChanged: true,
          error: `PR HEAD changed from ${evidence.headSha} to ${current.headRefOid} before CI rerun` };
      }
      await runPrCommand(['run', 'rerun', String(target.id), '--failed'], cwd, options);
    }
    return { ...result, success: true, failed: false };
  } catch (error) {
    options?.signal?.throwIfAborted();
    return { ...result, error: errorText(error) };
  }
}

export async function readCiRerunStatus(
  status: PrStatus, value: PrCiRerun, cwd: string, options?: PrStatusFetchOptions,
): Promise<PrStatus['ci']> {
  const rerun = PrCiRerunSchema.parse(value);
  if (rerun.number !== status.number) throw new Error('CI rerun target no longer matches the PR');
  if (rerun.headSha !== status.headSha) {
    return { finished: false, passed: false, checks: status.ci.checks,
      rerunHeadChange: { reason: `PR HEAD changed from ${rerun.headSha} to ${status.headSha} after CI rerun` } };
  }
  let checks = status.ci.checks ?? [];
  let finished = true;
  let passed = true;
  for (const target of rerun.runs) {
    const run = await readRun(target.id, cwd, options, target.url);
    if (run.headSha !== status.headSha) throw new Error('CI rerun HEAD does not match the PR');
    const completed = run.attempt > target.attempt && run.status === 'completed';
    const succeeded = completed && ['success', 'neutral', 'skipped'].includes(run.conclusion ?? '');
    checks = checks.map((check) => {
      if (check.kind !== 'CheckRun' || check.url === null) return check;
      let reference: ReturnType<typeof actionsReference>;
      try { reference = actionsReference(check.url); }
      catch { return check; }
      if (reference.id !== run.databaseId || reference.repository !== actionsReference(run.url).repository) return check;
      return { ...check, finished: completed, passed: succeeded };
    });
    finished = finished && completed;
    passed = passed && succeeded;
  }
  finished = finished && checks.length > 0 && checks.every((check) => check.finished);
  return { finished, passed: finished && passed && checks.every((check) => check.passed), checks };
}
