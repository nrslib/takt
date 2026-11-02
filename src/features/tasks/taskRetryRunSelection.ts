import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { TaskListItem } from '../../infra/task/index.js';
import type { WorkflowResumePoint } from '../../core/models/index.js';
import { readRunMetaBySlug, type RunMeta } from '../../core/workflow/run/run-meta.js';
import { assertSafePath, lstatOrUndefined } from '../../shared/utils/private-path-identity.js';
import { warn } from '../../shared/ui/index.js';

export interface SkippedTaskRetryRun {
  readonly runSlug: string;
  readonly reason: 'missing_metadata' | 'missing_resume_point' | 'missing_reports';
}

export interface TaskRetryRunSelection {
  readonly matchedRunSlug: string | null;
  readonly runMeta: RunMeta | null;
  readonly resumePoint: WorkflowResumePoint | undefined;
  readonly skippedRuns: readonly SkippedTaskRetryRun[];
  readonly failedStep?: string;
}

function rejectMalformedMetadata(message: string): never {
  // Unreadable saved state must not be mistaken for an absent checkpoint.
  throw new Error(message);
}

function readRetryMeta(cwd: string, slug: string): RunMeta | null {
  return readRunMetaBySlug(cwd, slug, rejectMalformedMetadata);
}

function matchesTask(meta: RunMeta, task: TaskListItem): boolean {
  if (task.data?.merge_task === true) return false;
  if (meta.task === task.content) return true;
  if (task.taskDir === undefined) return false;
  const header = /^Task: [^\r\n]*\r?\nTask directory: ([^\r\n]+)\r?\n\r?\n/.exec(meta.task);
  return header?.[1] === basename(task.taskDir);
}

export function resolveTaskRetryRunSelection(task: TaskListItem, cwd: string): TaskRetryRunSelection {
  const taskResumePointRunSlug = task.sourceRunSlug ?? task.runSlug;
  function resolveResumePoint(runSlug: string | null, runMeta: RunMeta | null): WorkflowResumePoint | undefined {
    // A startup failure can leave the task checkpoint owned by its source run.
    return runMeta?.resumePoint ?? (
      taskResumePointRunSlug === runSlug
        ? task.data?.resume_point
        : undefined
    );
  }

  const latestSlug = task.runSlug ?? task.sourceRunSlug ?? null;
  const latestMeta = latestSlug === null ? null : readRunMetaBySlug(cwd, latestSlug,
    task.data?.resume_point === undefined ? rejectMalformedMetadata : warn);
  const savedPoint = resolveResumePoint(latestSlug, latestMeta);
  if (latestSlug !== null && savedPoint !== undefined) {
    return { matchedRunSlug: latestSlug, runMeta: latestMeta, resumePoint: savedPoint, skippedRuns: [] };
  }

  const lineage = new Set<string>();
  const sources = [task.sourceRunSlug, latestMeta?.sourceRunSlug];
  for (const slug of sources) {
    if (slug === undefined || lineage.has(slug)) continue;
    lineage.add(slug);
    const source = readRetryMeta(cwd, slug)?.sourceRunSlug;
    if (source !== undefined) sources.push(source);
  }

  const runsDir = join(cwd, '.takt', 'runs');
  assertSafePath(runsDir, true);
  const candidates: Array<{ slug: string; startTime: string }> = [];
  if (lstatOrUndefined(runsDir) !== undefined) {
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === latestSlug) continue;
      const meta = readRunMetaBySlug(cwd, entry.name, lineage.has(entry.name) ? rejectMalformedMetadata : warn);
      if (meta !== null && (lineage.has(entry.name) || matchesTask(meta, task))) {
        candidates.push({ slug: entry.name, startTime: meta.startTime });
      }
    }
  }
  candidates.sort((a, b) => b.startTime.localeCompare(a.startTime) || b.slug.localeCompare(a.slug));
  const head = candidates[0];
  const latest = latestSlug === null && head !== undefined
    ? readRetryMeta(cwd, head.slug)
    : latestMeta;
  const failedStep = latest?.failure?.step.trim() || latest?.currentStep?.trim();
  const skippedRuns: SkippedTaskRetryRun[] = [];
  if (latestSlug !== null) {
    skippedRuns.push({ runSlug: latestSlug, reason: latestMeta === null ? 'missing_metadata' : 'missing_resume_point' });
  }
  for (const { slug } of candidates) {
    const meta = readRetryMeta(cwd, slug);
    if (meta === null) {
      skippedRuns.push({ runSlug: slug, reason: 'missing_metadata' });
      continue;
    }
    const resumePoint = resolveResumePoint(slug, meta);
    if (resumePoint === undefined) {
      skippedRuns.push({ runSlug: slug, reason: 'missing_resume_point' });
      continue;
    }
    const reports = join(cwd, meta.reportDirectory);
    assertSafePath(reports, true);
    if (lstatOrUndefined(reports) === undefined) {
      skippedRuns.push({ runSlug: slug, reason: 'missing_reports' });
      continue;
    }
    return { matchedRunSlug: slug, runMeta: meta, resumePoint, skippedRuns, failedStep };
  }
  return { matchedRunSlug: null, runMeta: null, resumePoint: undefined, skippedRuns, failedStep };
}
