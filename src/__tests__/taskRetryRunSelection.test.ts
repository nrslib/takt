import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunMeta } from '../core/workflow/run/run-meta.js';
import type { WorkflowResumePoint } from '../core/models/index.js';
import type { TaskListItem } from '../infra/task/index.js';

const { metadata, reportDirs, readMeta, listRuns, checkPath, statPath } = vi.hoisted(() => {
  const metadata = new Map<string, RunMeta>();
  const reportDirs = new Set<string>();
  return {
    metadata, reportDirs,
    readMeta: vi.fn((_cwd: string, slug: string, _warning?: (message: string) => void) => metadata.get(slug) ?? null),
    listRuns: vi.fn(() => [...metadata.keys()].map((name) => ({ name, isDirectory: () => true }))),
    checkPath: vi.fn((_path: string, _directory: boolean) => undefined),
    statPath: vi.fn((path: string) => path.endsWith('/runs') || reportDirs.has(path) ? { isDirectory: () => true } : undefined),
  };
});

vi.mock('node:fs', () => ({ readdirSync: listRuns }));
vi.mock('../core/workflow/run/run-meta.js', () => ({ readRunMetaBySlug: readMeta }));
vi.mock('../shared/utils/private-path-identity.js', () => ({ assertSafePath: checkPath, lstatOrUndefined: statPath }));
vi.mock('../shared/ui/index.js', () => ({ warn: vi.fn() }));

import { resolveTaskRetryRunSelection } from '../features/tasks/taskRetryRunSelection.js';

const cwd = '/worktree';
const task: TaskListItem = {
  kind: 'failed', name: 'task-a', taskDir: '.takt/tasks/task-a', content: 'Canonical instruction',
  createdAt: '2026-11-02T00:00:00Z', filePath: '/project/.takt/tasks.yaml', runSlug: 'latest',
};

function point(step = 'implement'): WorkflowResumePoint {
  return { version: 2, stack: [{ workflow: 'default', workflow_ref: 'project:default', step, kind: 'agent', occurrence: 1 }],
    iteration: 1, elapsed_ms: 0, workflow_call_invocations: {}, workflow_step_participations: {} };
}

function run(slug: string, startTime: string, overrides: Partial<RunMeta> = {}): RunMeta {
  const meta: RunMeta = {
    task: 'Task: Repair\nTask directory: task-a\n\nImplement using only the staged task.',
    workflow: 'default', runSlug: slug, status: 'failed', startTime,
    runRoot: `.takt/runs/${slug}`, reportDirectory: `.takt/runs/${slug}/reports`,
    contextDirectory: `.takt/runs/${slug}/context`, logsDirectory: `.takt/runs/${slug}/logs`,
    ...overrides,
  };
  metadata.set(slug, meta);
  reportDirs.add(`${cwd}/${meta.reportDirectory}`);
  return meta;
}

describe('resolveTaskRetryRunSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks(); metadata.clear(); reportDirs.clear();
  });

  it('preserves the latest saved position without scanning or checking its reports', () => {
    const saved = point('fix-verifier');
    run('latest', '2026-11-02', { resumePoint: saved });
    reportDirs.clear();
    run('older', '2026-11-01', { resumePoint: point() });

    const result = resolveTaskRetryRunSelection(task, cwd);

    expect(result).toMatchObject({ matchedRunSlug: 'latest', resumePoint: saved, skippedRuns: [] });
    expect(listRuns).not.toHaveBeenCalled();
    expect(checkPath).not.toHaveBeenCalled();
  });

  it('preserves a task-owned checkpoint even when latest metadata is absent', () => {
    const saved = point('fix-verifier');
    const result = resolveTaskRetryRunSelection({ ...task, data: { task: task.content, resume_point: saved } }, cwd);
    expect(result).toMatchObject({ matchedRunSlug: 'latest', resumePoint: saved, skippedRuns: [] });
    expect(listRuns).not.toHaveBeenCalled();
  });

  it('preserves the task-owned checkpoint when latest metadata cannot be parsed', () => {
    const saved = point('fix-verifier');
    readMeta.mockImplementationOnce((_cwd, _slug, warning) => {
      warning?.('Malformed latest metadata');
      return null;
    });
    const result = resolveTaskRetryRunSelection({ ...task, data: { task: task.content, resume_point: saved } }, cwd);
    expect(result).toMatchObject({ matchedRunSlug: 'latest', resumePoint: saved, skippedRuns: [] });
    expect(listRuns).not.toHaveBeenCalled();
  });

  // SCN-RESUME-01-P1
  it.each(['missing_metadata', 'missing_resume_point'] as const)(
    'keeps an inherited checkpoint with its source when the latest run has %s',
    (reason) => {
      const saved = point();
      const source = run('source', '2026-11-01', { resumePoint: saved });
      if (reason === 'missing_resume_point') run('latest', '2026-11-02');
      const inherited = { ...task, sourceRunSlug: 'source',
        data: { task: task.content, resume_point: saved } };

      const result = resolveTaskRetryRunSelection(inherited, cwd);

      expect(result).toMatchObject({ matchedRunSlug: 'source', runMeta: source, resumePoint: saved });
      expect(result.skippedRuns).toEqual([{ runSlug: 'latest', reason }]);
    },
  );

  // SCN-RESUME-01-N1
  it('changes from the inherited source to the latest run only when its own checkpoint is added', () => {
    const saved = point();
    const latestPoint = point('fix-verifier');
    const source = run('source', '2026-11-01', { resumePoint: saved });
    const latest = run('latest', '2026-11-02');
    const inherited = { ...task, sourceRunSlug: 'source',
      data: { task: task.content, resume_point: saved } };

    expect(resolveTaskRetryRunSelection(inherited, cwd)).toMatchObject({
      matchedRunSlug: 'source', runMeta: source, resumePoint: saved,
      skippedRuns: [{ runSlug: 'latest', reason: 'missing_resume_point' }],
    });
    metadata.set('latest', { ...latest, resumePoint: latestPoint });

    expect(resolveTaskRetryRunSelection(inherited, cwd)).toMatchObject({
      matchedRunSlug: 'latest', runMeta: { ...latest, resumePoint: latestPoint },
      resumePoint: latestPoint, skippedRuns: [],
    });
  });

  it('keeps history ordering and uses a task checkpoint only for its saved source', () => {
    const saved = point();
    const source = run('source', '2026-11-01');
    const newer = run('newer', '2026-11-01T12:00:00Z', { resumePoint: point('fix-verifier') });
    run('latest', '2026-11-02');
    const inherited = { ...task, sourceRunSlug: 'source',
      data: { task: task.content, resume_point: saved } };

    expect(resolveTaskRetryRunSelection(inherited, cwd)).toMatchObject({
      matchedRunSlug: 'newer', runMeta: newer, resumePoint: point('fix-verifier'),
    });
    metadata.delete('newer');

    expect(resolveTaskRetryRunSelection(inherited, cwd)).toMatchObject({
      matchedRunSlug: 'source', runMeta: source, resumePoint: saved,
    });
  });

  it('selects by time beyond multiple startup failures and requires reports from the same run', () => {
    run('latest', '2026-11-02');
    for (let index = 0; index < 11; index += 1) run(`startup-${index}`, '2026-11-01');
    run('z-oldest', '2026-10-28', { resumePoint: point('review') });
    const selected = run('a-newest', '2026-10-29', { resumePoint: point() });
    const unavailable = run('without-reports', '2026-10-30', { resumePoint: point('review') });
    reportDirs.delete(`${cwd}/${unavailable.reportDirectory}`);

    const result = resolveTaskRetryRunSelection(task, cwd);

    expect(result).toMatchObject({ matchedRunSlug: 'a-newest', runMeta: selected, resumePoint: point() });
    expect(result.skippedRuns).toHaveLength(13);
    expect(result.skippedRuns).toContainEqual({ runSlug: 'without-reports', reason: 'missing_reports' });
    expect(result.skippedRuns[0]).toEqual({ runSlug: 'latest', reason: 'missing_resume_point' });
  });

  it('starts without a source when no run has a checkpoint', () => {
    run('latest', '2026-11-02'); run('older', '2026-11-01');
    expect(resolveTaskRetryRunSelection(task, cwd)).toEqual({
      matchedRunSlug: null, runMeta: null, resumePoint: undefined,
      skippedRuns: [
        { runSlug: 'latest', reason: 'missing_resume_point' },
        { runSlug: 'older', reason: 'missing_resume_point' },
      ],
    });
  });

  it('recovers a generated task header when the latest directory was not created', () => {
    run('older', '2026-11-01', { resumePoint: point() });
    const result = resolveTaskRetryRunSelection(task, cwd);
    expect(result).toMatchObject({ matchedRunSlug: 'older', resumePoint: point() });
    expect(result.skippedRuns).toEqual([{ runSlug: 'latest', reason: 'missing_metadata' }]);
  });

  it.each([
    'Task directory: task-a', '> Task directory: task-a',
    '```\nTask directory: task-a\n```', '~~~\nTask directory: task-a\n~~~',
    '```\n~~~\nTask directory: task-a\n~~~\n```', '```\nTask directory: task-a',
  ])('ignores another task whose body contains %j', (body) => {
    run('latest', '2026-11-02');
    run('other', '2026-11-01', { resumePoint: point(), task: `Task: Other\nTask directory: other-task\n\n${body}` });
    expect(resolveTaskRetryRunSelection(task, cwd).matchedRunSlug).toBeNull();
  });

  it('does not search the body for a missing generated header', () => {
    run('other', '2026-11-01', { resumePoint: point(), task: 'Task: Other\n\n```\nTask: Example\nTask directory: task-a\n\n```' });
    expect(resolveTaskRetryRunSelection(task, cwd).matchedRunSlug).toBeNull();
  });

  it('retains exact task-content matching without a generated header', () => {
    run('older', '2026-11-01', { resumePoint: point(), task: task.content });
    expect(resolveTaskRetryRunSelection({ ...task, runSlug: undefined, taskDir: undefined }, cwd).matchedRunSlug).toBe('older');
  });

  it.each([false, true])('skips a discovered head without reports when no run slug was saved and an older source exists=%s', (hasOlderSource) => {
    const head = run('head', '2026-11-02', { resumePoint: point('review'), currentStep: 'review' });
    reportDirs.delete(`${cwd}/${head.reportDirectory}`);
    const older = hasOlderSource ? run('older', '2026-11-01', { resumePoint: point() }) : null;

    const result = resolveTaskRetryRunSelection({ ...task, runSlug: undefined }, cwd);

    expect(result).toEqual({
      matchedRunSlug: hasOlderSource ? 'older' : null,
      runMeta: older,
      resumePoint: hasOlderSource ? point() : undefined,
      skippedRuns: [{ runSlug: 'head', reason: 'missing_reports' }],
      failedStep: 'review',
    });
  });

  it('keeps metadata checkpoint priority over a task checkpoint when no run slug was saved', () => {
    run('older', '2026-11-01', { resumePoint: point('fix-verifier'), task: task.content });
    const result = resolveTaskRetryRunSelection({ ...task, runSlug: undefined,
      data: { task: task.content, resume_point: point('implement') },
    }, cwd);
    expect(result.matchedRunSlug).toBe('older');
    expect(result.resumePoint).toEqual(point('fix-verifier'));
  });

  it.each([false, true])('does not transfer an unowned task checkpoint to an older run with its own checkpoint=%s', (hasOlderPoint) => {
    const saved = point('review');
    const head = run('head', '2026-11-02', { resumePoint: saved, currentStep: 'review' });
    reportDirs.delete(`${cwd}/${head.reportDirectory}`);
    const olderPoint = hasOlderPoint ? point('implement') : undefined;
    const older = run('older', '2026-11-01', { resumePoint: olderPoint });

    const result = resolveTaskRetryRunSelection({ ...task, runSlug: undefined,
      data: { task: task.content, resume_point: saved },
    }, cwd);

    expect(result).toEqual({
      matchedRunSlug: hasOlderPoint ? 'older' : null,
      runMeta: hasOlderPoint ? older : null,
      resumePoint: olderPoint,
      skippedRuns: [
        { runSlug: 'head', reason: 'missing_reports' },
        ...(hasOlderPoint ? [] : [{ runSlug: 'older', reason: 'missing_resume_point' }]),
      ],
      failedStep: 'review',
    });
  });

  it.each([false, true])('starts without a source for an unowned task checkpoint when discovered history exists=%s', (hasHistory) => {
    if (hasHistory) run('older', '2026-11-01');

    const result = resolveTaskRetryRunSelection({ ...task, runSlug: undefined,
      data: { task: task.content, resume_point: point() },
    }, cwd);

    expect(result).toMatchObject({ matchedRunSlug: null, runMeta: null, resumePoint: undefined,
      skippedRuns: hasHistory ? [{ runSlug: 'older', reason: 'missing_resume_point' }] : [],
    });
  });

  it('retains the latest diagnostic step when starting without a report source', () => {
    run('latest', '2026-11-02', { currentStep: 'implement' });
    expect(resolveTaskRetryRunSelection(task, cwd)).toMatchObject({ matchedRunSlug: null, failedStep: 'implement' });
  });

  it('does not identify a merge task by matching text', () => {
    run('other', '2026-11-01', { resumePoint: point(), task: task.content });
    expect(resolveTaskRetryRunSelection({ ...task, runSlug: undefined, data: { task: task.content, merge_task: true } }, cwd).matchedRunSlug).toBeNull();
  });

  it('follows saved provenance despite instruction revisions and terminates a lineage cycle', () => {
    run('latest', '2026-11-02', { sourceRunSlug: 'previous' });
    run('previous', '2026-11-01', { task: 'Older instruction', sourceRunSlug: 'original' });
    run('original', '2026-10-31', { task: 'Original instruction', sourceRunSlug: 'previous', resumePoint: point() });
    expect(resolveTaskRetryRunSelection(task, cwd).matchedRunSlug).toBe('original');
  });

  it('propagates an unexpected I/O error instead of starting from the beginning', () => {
    readMeta.mockImplementationOnce(() => { throw new Error('EACCES'); });
    expect(() => resolveTaskRetryRunSelection(task, cwd)).toThrow('EACCES');
  });

  it('rejects malformed saved metadata instead of treating it as absent', () => {
    readMeta.mockImplementationOnce((_cwd, _slug, warning) => { warning?.('Invalid saved checkpoint'); return null; });
    expect(() => resolveTaskRetryRunSelection(task, cwd)).toThrow('Invalid saved checkpoint');
  });

  it('propagates a report boundary violation instead of silently skipping it', () => {
    run('older', '2026-11-01', { resumePoint: point() });
    checkPath.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error('Symlink reports'); });
    expect(() => resolveTaskRetryRunSelection(task, cwd)).toThrow('Symlink reports');
  });

  it('does not block recovery because unassociated metadata cannot be parsed', () => {
    run('older', '2026-11-01', { resumePoint: point() });
    listRuns.mockReturnValueOnce([
      { name: 'unassociated-broken', isDirectory: () => true },
      { name: 'older', isDirectory: () => true },
    ]);
    readMeta.mockImplementationOnce(() => null).mockImplementationOnce((_cwd, _slug, warning) => {
      warning?.('Malformed unrelated metadata');
      return null;
    });
    expect(resolveTaskRetryRunSelection(task, cwd).matchedRunSlug).toBe('older');
  });
});
