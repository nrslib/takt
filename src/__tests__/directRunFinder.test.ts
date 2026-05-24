import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findLatestResumableDirectRun } from '../features/tasks/resume/directRunFinder.js';

let projectDir: string;

function writeRunMeta(slug: string, meta: Record<string, unknown>): void {
  const metaPath = path.join(projectDir, '.takt', 'runs', slug, 'meta.json');
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify({
    task: `Task for ${slug}`,
    workflow: 'default',
    runSlug: slug,
    runRoot: `.takt/runs/${slug}`,
    reportDirectory: `.takt/runs/${slug}/reports`,
    contextDirectory: `.takt/runs/${slug}/context`,
    logsDirectory: `.takt/runs/${slug}/logs`,
    startTime: '2026-05-24T00:00:00.000Z',
    ...meta,
  }), 'utf-8');
}

function writeTasksFile(runSlugs: string[]): void {
  const tasksPath = path.join(projectDir, '.takt', 'tasks.yaml');
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, stringifyYaml({
    tasks: runSlugs.map((runSlug, index) => ({
      name: `task-${index}`,
      status: 'failed',
      content: `Queued task ${index}`,
      created_at: '2026-05-24T00:00:00.000Z',
      started_at: '2026-05-24T00:01:00.000Z',
      completed_at: '2026-05-24T00:02:00.000Z',
      run_slug: runSlug,
      failure: { error: 'failed' },
    })),
  }), 'utf-8');
}

describe('findLatestResumableDirectRun', () => {
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-direct-run-finder-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('Given no direct failed or aborted runs, When searching, Then null is returned', () => {
    writeRunMeta('20260524-completed', {
      status: 'completed',
      updatedAt: '2026-05-24T00:10:00.000Z',
    });
    writeRunMeta('20260524-running', {
      status: 'running',
      updatedAt: '2026-05-24T00:20:00.000Z',
    });

    const result = findLatestResumableDirectRun(projectDir);

    expect(result).toBeNull();
  });

  it('Given task-linked and direct runs, When searching, Then task-linked run slugs are excluded', () => {
    writeTasksFile(['20260524-task-linked']);
    writeRunMeta('20260524-task-linked', {
      status: 'aborted',
      updatedAt: '2026-05-24T00:30:00.000Z',
    });
    writeRunMeta('20260524-direct', {
      status: 'failed',
      updatedAt: '2026-05-24T00:10:00.000Z',
    });

    const result = findLatestResumableDirectRun(projectDir);

    expect(result?.slug).toBe('20260524-direct');
  });

  it('Given multiple direct aborted or failed runs, When searching, Then the newest updated run is selected', () => {
    writeRunMeta('20260524-old-failed', {
      status: 'failed',
      updatedAt: '2026-05-24T00:10:00.000Z',
    });
    writeRunMeta('20260524-new-aborted', {
      status: 'aborted',
      updatedAt: '2026-05-24T00:30:00.000Z',
    });
    writeRunMeta('20260524-completed-newer', {
      status: 'completed',
      updatedAt: '2026-05-24T00:40:00.000Z',
    });

    const result = findLatestResumableDirectRun(projectDir);

    expect(result?.slug).toBe('20260524-new-aborted');
    expect(result?.meta.status).toBe('aborted');
  });
});
