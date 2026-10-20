import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/workflow-types.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import {
  createWorkflowRunLifecycle,
  type WorkflowRunHandle,
} from '../features/tasks/execute/workflowRunLifecycle.js';
import {
  appendNdjsonLine,
  createSessionLog,
  initNdjsonLog,
} from '../infra/fs/index.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import {
  createWorkflowTerminalPayloadFactory,
} from '../features/tasks/execute/workflowTerminalPayload.js';
import { RunProjectionError } from '../features/tasks/execute/workflowRunExecution.js';

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-run-boundary-'));
  roots.push(root);
  return root;
}

const workflow: WorkflowConfig = {
  name: 'boundary-workflow',
  initialStep: 'done',
  maxSteps: 1,
  steps: [{
    kind: 'agent',
    name: 'done',
    persona: 'coder',
    personaDisplayName: 'Coder',
    session: 'refresh',
    instruction: 'done',
    rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
  }],
};

async function failRun(
  handle: WorkflowRunHandle,
  projectCwd: string,
): Promise<void> {
  handle.bootstrap.publishRunMeta({
    runPaths: handle.runPaths,
    task: 'same task',
    workflowName: workflow.name,
  });
  initNdjsonLog(
    handle.bootstrap.sessionId,
    'same task',
    workflow.name,
    {
      logsDir: handle.runPaths.logsAbs,
      startTime: handle.bootstrap.startedAt,
    },
  );
  const reason = 'boundary cleanup';
  const sessionLog = createSessionLog(
    'same task',
    projectCwd,
    workflow.name,
    { startTime: handle.bootstrap.startedAt },
  );
  const payload = createWorkflowTerminalPayloadFactory({
    runSlug: handle.runSlug,
    projectCwd,
    task: 'same task',
    workflowName: workflow.name,
    sessionLog,
    sessionId: handle.bootstrap.sessionId,
    ndjsonLogPath: join(
      handle.runPaths.logsAbs,
      `${handle.bootstrap.sessionId}.jsonl`,
    ),
    traceReportMode: 'redacted',
  }).create({
    status: 'failed',
    iterations: 0,
    reason,
    endTime: new Date().toISOString(),
  });
  await handle.finish({
    status: 'failed',
    iteration: 0,
    reason,
  }, payload);
}

async function createTerminalRun(status: 'completed' | 'failed') {
  const cwd = createRoot();
  const task = 'trace failure task';
  const handle = await createWorkflowRunLifecycle({ cwd }).lifecycle.beginRun({
    workflowConfig: workflow,
    task,
    requestedRunSlug: 'trace-failure-run',
  });
  handle.bootstrap.publishRunMeta({
    runPaths: handle.runPaths,
    task,
    workflowName: workflow.name,
  });
  const ndjsonLogPath = initNdjsonLog(handle.bootstrap.sessionId, task, workflow.name, {
    logsDir: handle.runPaths.logsAbs,
    startTime: handle.bootstrap.startedAt,
  });
  const failure = status === 'failed'
    ? { step: 'done', error: 'provider unavailable', failureCategory: 'provider_error' as const }
    : undefined;
  const reason = failure?.error;
  const payload = createWorkflowTerminalPayloadFactory({
    runSlug: handle.runSlug,
    projectCwd: cwd,
    task,
    workflowName: workflow.name,
    sessionLog: createSessionLog(task, cwd, workflow.name, { startTime: handle.bootstrap.startedAt }),
    sessionId: handle.bootstrap.sessionId,
    ndjsonLogPath,
    traceReportMode: 'redacted',
  }).create({ status, reason, failure, iterations: 2, endTime: new Date().toISOString() });
  return { handle, ndjsonLogPath, payload, outcome: { status, reason, iteration: 2 } };
}

describe('workflow run lifecycle boundary', () => {
  it('should complete a run and report a trace issue when a phase completion record is missing', async () => {
    const { handle, ndjsonLogPath, payload, outcome } = await createTerminalRun('completed');
    appendNdjsonLine(ndjsonLogPath, {
      type: 'step_start', step: 'done', persona: 'coder', iteration: 2,
      timestamp: handle.bootstrap.startedAt,
    });
    appendNdjsonLine(ndjsonLogPath, {
      type: 'phase_start', step: 'done', iteration: 2, phase: 1, phaseName: 'execute',
      phaseExecutionId: 'done:2:1:1', instruction: 'finish task',
      systemPrompt: 'system', userInstruction: 'finish task', timestamp: handle.bootstrap.startedAt,
    });
    appendNdjsonLine(ndjsonLogPath, {
      type: 'step_complete', step: 'done', persona: 'coder', iteration: 2,
      status: 'done', content: 'finished', instruction: 'finish task', timestamp: payload.endTime,
    });

    const finalization = await handle.finish(outcome, payload);

    expect(finalization.receipt).toMatchObject({ runStatus: 'completed', iteration: 2 });
    expect(finalization.issues).toHaveLength(1);
    expect(finalization.issues[0]).toBeInstanceOf(RunProjectionError);
    expect(finalization.issues[0]).toMatchObject({
      stage: 'trace', cause: expect.objectContaining({ message: expect.stringContaining('missing status') }),
    });
    expect(JSON.parse(readFileSync(handle.runPaths.metaAbs, 'utf8'))).toMatchObject({
      status: 'completed', iterations: 2, endTime: payload.endTime,
    });
    const records = readFileSync(ndjsonLogPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(records.filter((record) => record.type === 'workflow_complete')).toEqual([payload.sessionRecord]);
  });

  it.each(['completed', 'failed'] as const)(
    'should preserve the committed %s result when saving the trace fails', async (status) => {
      const { handle, ndjsonLogPath, payload, outcome } = await createTerminalRun(status);
      mkdirSync(join(handle.runPaths.runRootAbs, 'trace.md'));

      const finalization = await handle.finish(outcome, payload);

      expect(finalization.receipt).toMatchObject({ runStatus: status, iteration: payload.iterations });
      expect(finalization.issues).toHaveLength(1);
      expect(finalization.issues[0]).toBeInstanceOf(RunProjectionError);
      expect(finalization.issues[0]).toMatchObject({ stage: 'trace', cause: expect.any(Error) });
      const meta = JSON.parse(readFileSync(handle.runPaths.metaAbs, 'utf8')) as Record<string, unknown>;
      expect(meta).toMatchObject({ status, iterations: payload.iterations, endTime: payload.endTime });
      expect(meta.reason).toEqual(payload.reason);
      expect(meta.failure).toEqual(payload.failure);
      const records = readFileSync(ndjsonLogPath, 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as { type: string });
      expect(records.filter((record) => record.type === 'workflow_complete' || record.type === 'workflow_abort'))
        .toEqual([payload.sessionRecord]);
    },
  );

  it.each([
    { status: 'completed', reason: undefined },
    { status: 'failed', reason: 'provider unavailable' },
    { status: 'aborted', reason: 'user_interrupted' },
  ] as const)('should persist $status ($reason) run records without a notice file', async ({ status, reason }) => {
    const cwd = createRoot();
    const handle = await createWorkflowRunLifecycle({ cwd }).lifecycle.beginRun({
      workflowConfig: workflow, task: 'current task', requestedRunSlug: 'terminal-run',
    });
    handle.bootstrap.publishRunMeta({ runPaths: handle.runPaths, task: 'current task', workflowName: workflow.name });
    const ndjsonLogPath = initNdjsonLog(handle.bootstrap.sessionId, 'current task', workflow.name, {
      logsDir: handle.runPaths.logsAbs, startTime: handle.bootstrap.startedAt,
    });
    const endTime = new Date().toISOString();
    const failure = status === 'failed' ? { step: 'done', error: reason! } : undefined;
    const payload = createWorkflowTerminalPayloadFactory({
      runSlug: handle.runSlug, projectCwd: cwd, task: 'current task', workflowName: workflow.name,
      sessionLog: createSessionLog('current task', cwd, workflow.name, { startTime: handle.bootstrap.startedAt }),
      sessionId: handle.bootstrap.sessionId, ndjsonLogPath, traceReportMode: 'redacted',
    }).create({ status, reason, failure, iterations: 2, endTime });

    await handle.finish({ status: status === 'aborted' ? 'cancelled' : status, reason, iteration: 2 }, payload);

    expect(JSON.parse(readFileSync(handle.runPaths.metaAbs, 'utf8'))).toMatchObject({
      task: 'current task', workflow: workflow.name, status, iterations: 2, endTime,
      ...(reason === undefined ? {} : { reason }),
      ...(failure === undefined ? {} : { failure }),
    });
    const records = readFileSync(ndjsonLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string });
    expect(records.filter((record) => record.type === 'workflow_start')).toHaveLength(1);
    expect(records.filter((record) => record.type === (status === 'completed' ? 'workflow_complete' : 'workflow_abort')))
      .toEqual([expect.objectContaining({ iterations: 2, endTime, ...(reason === undefined ? {} : { reason }) })]);
    expect(readFileSync(join(handle.runPaths.runRootAbs, 'trace.md'), 'utf8')).toContain(workflow.name);
    expect(existsSync(join(cwd, '.takt', 'session-state.json'))).toBe(false);
  });

  it(
    'beginRunはfile lifecycleの共通handleを返す',
    async () => {
      const cwd = createRoot();
      const composition = createWorkflowRunLifecycle({
        cwd,
      });
      expect(existsSync(join(cwd, '.takt', 'runs'))).toBe(false);

      const activeRun = await composition.lifecycle.beginRun({
        workflowConfig: workflow,
        task: 'same task',
        requestedRunSlug: 'reserved-run',
      });

      expect(existsSync(activeRun.runPaths.runRootAbs)).toBe(true);
      await failRun(activeRun, cwd);
      expect(existsSync(activeRun.runPaths.metaAbs)).toBe(true);
    },
  );

  it('local runs keep the legacy .takt relative metadata while central runs use state-relative paths', async () => {
    const cwd = createRoot();
    const local = createWorkflowRunLifecycle({ cwd });
    const localRun = await local.lifecycle.beginRun({
      workflowConfig: workflow,
      task: 'local task',
      requestedRunSlug: 'local-run',
    });
    expect(localRun.runPaths.runRootRel).toBe('.takt/runs/local-run');
    expect(localRun.runPaths.reportsRel).toBe('.takt/runs/local-run/reports');

    const centralRunsDirectory = join(cwd, 'central-state', 'runs');
    const central = createWorkflowRunLifecycle({
      cwd,
      runPathsDirectory: centralRunsDirectory,
    });
    const centralRun = await central.lifecycle.beginRun({
      workflowConfig: workflow,
      task: 'central task',
      requestedRunSlug: 'central-run',
    });
    expect(centralRun.runPaths.runRootRel).toBe('runs/central-run');
    expect(centralRun.runPaths.reportsRel).toBe('runs/central-run/reports');
  });

  it(
    'File同一秒の2開始を原子的に別slugへ予約する',
    async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
      const cwd = createRoot();
      const composition = createWorkflowRunLifecycle({
        cwd,
      });
      const first = await composition.lifecycle.beginRun({
        workflowConfig: workflow,
        task: 'same task',
      });
      const second = await composition.lifecycle.beginRun({
        workflowConfig: workflow,
        task: 'same task',
      });

      expect(second.runSlug).not.toBe(first.runSlug);
      expect(existsSync(first.runPaths.runRootAbs)).toBe(true);
      expect(existsSync(second.runPaths.runRootAbs)).toBe(true);
      await failRun(first, cwd);
      await failRun(second, cwd);
      vi.useRealTimers();
    },
  );

  it(
    'File明示slugの競合では一方だけが予約し敗者は勝者artifactを変更しない',
    async () => {
      const cwd = createRoot();
      const composition = createWorkflowRunLifecycle({
        cwd,
      });
      const attempts = await Promise.allSettled([1, 2].map(() => (
        composition.lifecycle.beginRun({
          workflowConfig: workflow,
          task: 'same task',
          requestedRunSlug: 'file-race-run',
        })
      )));
      const winners = attempts.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : []
      );
      const failures = attempts.filter((result) => result.status === 'rejected');
      expect(winners).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(existsSync(winners[0]!.runPaths.metaAbs)).toBe(false);

      await failRun(winners[0]!, cwd);
      expect(existsSync(winners[0]!.runPaths.metaAbs)).toBe(true);
    },
  );

  it('File明示targetが既存ならartifactを変更せず拒否する', async () => {
    const cwd = createRoot();
    const paths = buildRunPaths(cwd, 'existing-file-run');
    mkdirSync(paths.runRootAbs, { recursive: true });
    writeFileSync(paths.metaAbs, 'existing-meta', 'utf-8');
    const composition = createWorkflowRunLifecycle({ cwd });

    await expect(composition.lifecycle.beginRun({
      workflowConfig: workflow,
      task: 'same task',
      requestedRunSlug: paths.slug,
    })).rejects.toThrow(/already exists/);
    expect(readFileSync(paths.metaAbs, 'utf-8')).toBe('existing-meta');
  });

  it(
    '同一秒の2開始をfile directoryで別slugへ予約する',
    async () => {
      const cwd = createRoot();
      const composition = createWorkflowRunLifecycle({ cwd });
      const first = await composition.lifecycle.beginRun({
        workflowConfig: workflow,
        task: 'same task',
      });
      const second = await composition.lifecycle.beginRun({
        workflowConfig: workflow,
        task: 'same task',
      });

      expect(second.runSlug).not.toBe(first.runSlug);
      expect(existsSync(first.runPaths.runRootAbs)).toBe(true);
      expect(existsSync(second.runPaths.runRootAbs)).toBe(true);
      await failRun(first, cwd);
      await failRun(second, cwd);
    },
  );
});
