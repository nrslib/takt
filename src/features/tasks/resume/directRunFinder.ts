import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readRunMetaBySlug, type RunMeta } from '../../../core/workflow/run/run-meta.js';
import { TaskRunner } from '../../../infra/task/index.js';

export interface ResumableDirectRun {
  readonly slug: string;
  readonly meta: RunMeta;
}

const RESUMABLE_STATUSES = new Set<RunMeta['status']>(['aborted', 'failed']);

function collectTaskRunSlugs(projectDir: string): Set<string> {
  const runner = new TaskRunner(projectDir);
  return new Set(
    runner.listAllTaskItems()
      .map((task) => task.runSlug)
      .filter((slug): slug is string => typeof slug === 'string' && slug.trim() !== ''),
  );
}

function resolveRunTimestamp(meta: RunMeta): string {
  return meta.updatedAt ?? meta.endTime ?? meta.startTime;
}

function compareRunsDesc(left: ResumableDirectRun, right: ResumableDirectRun): number {
  const timestampOrder = resolveRunTimestamp(right.meta).localeCompare(resolveRunTimestamp(left.meta));
  if (timestampOrder !== 0) {
    return timestampOrder;
  }
  return right.slug.localeCompare(left.slug);
}

export function findLatestResumableDirectRun(projectDir: string): ResumableDirectRun | null {
  const runsDir = join(projectDir, '.takt', 'runs');
  if (!existsSync(runsDir)) {
    return null;
  }

  const taskRunSlugs = collectTaskRunSlugs(projectDir);
  const runs = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry): ResumableDirectRun[] => {
      if (taskRunSlugs.has(entry.name)) {
        return [];
      }
      const meta = readRunMetaBySlug(projectDir, entry.name);
      if (!meta || !RESUMABLE_STATUSES.has(meta.status)) {
        return [];
      }
      return [{ slug: entry.name, meta }];
    })
    .sort(compareRunsDesc);

  return runs[0] ?? null;
}
