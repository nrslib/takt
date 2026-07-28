import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as runMeta from '../features/tasks/execute/runMeta.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import {
  createWorkflowRunComposition,
  type WorkflowRunHandle,
} from '../features/tasks/execute/workflowRunStorage.js';
import {
  createSessionLog,
  initNdjsonLog,
} from '../infra/fs/index.js';
import {
  createWorkflowTerminalPayloadFactory,
} from '../features/tasks/execute/workflowTerminalPayload.js';
import { openRunStorage } from '../infra/run-storage/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-run-boundary-'));
  roots.push(root);
  return root;
}

const workflow = {
  name: 'boundary-workflow',
  initialStep: 'done',
  maxSteps: 1,
  steps: [{
    name: 'done',
    persona: 'coder',
    instruction: 'done',
    rules: [{ condition: 'done', next: 'COMPLETE' }],
  }],
} as const;

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
    metaSeed: {
      backend: handle.bootstrap.backend,
      startedAt: handle.bootstrap.startedAt,
      resumeSource: null,
    },
  }).create({
    status: 'failed',
    iterations: 0,
    reason,
    lastStepContent: undefined,
    lastStepName: undefined,
    endTime: new Date().toISOString(),
  });
  await handle.finish({
    status: 'failed',
    iteration: 0,
    reason,
  }, payload);
}

describe('workflow run storage boundary', () => {
  it.each(['file', 'sqlite'] as const)(
    '%s strategy binds terminal infrastructure before exposing publication',
    (backend) => {
      const provider = createWorkflowRunComposition(backend, {
        cwd: '/nonexistent/workflow-run-storage-boundary',
        projectCwd: '/nonexistent/workflow-run-storage-boundary',
      });

      expect(provider).not.toHaveProperty('prepare');
      expect(provider).not.toHaveProperty('storageBackend');
      expect(provider).not.toHaveProperty('publishTerminal');
      expect(provider).not.toHaveProperty('bindTerminalPublisher');
      expect(provider).not.toHaveProperty('ready');
      expect(provider).not.toHaveProperty('abortController');
      expect(provider).not.toHaveProperty('bootstrap');
      expect(provider).toHaveProperty('storage.beginRun');
      expect(provider).toHaveProperty('admin.createForceFail');
      expect(provider).toHaveProperty('recovery.reconcilePending');
      expect(Object.keys(provider).sort()).toEqual([
        'admin',
        'recovery',
        'storage',
      ]);
    },
  );

  it('keeps SQLite meta projection validation out of the shared run meta module', () => {
    expect(runMeta).not.toHaveProperty('finalizeStoredRunMeta');
  });

  it.each(['file', 'sqlite'] as const)(
    '%s beginRunは共通handleを返し、backend固有の初期化を隠蔽する',
    async (backend) => {
      const cwd = createRoot();
      const composition = createWorkflowRunComposition(backend, {
        cwd,
        projectCwd: cwd,
      });
      expect(existsSync(join(cwd, '.takt', 'runs'))).toBe(false);

      const activeRun = await composition.storage.beginRun({
        workflowConfig: workflow,
        task: 'same task',
        requestedRunSlug: `${backend}-reserved-run`,
      });

      if (backend === 'file') {
        expect(existsSync(activeRun.runPaths.runRootAbs)).toBe(false);
      } else {
        expect(existsSync(activeRun.runPaths.databaseAbs)).toBe(true);
      }
      await failRun(activeRun, cwd);
      expect(existsSync(activeRun.runPaths.metaAbs)).toBe(true);
    },
  );

  it(
    'SQLite同一秒の2開始を原子的に別slugへ予約し、先行authorityを上書きしない',
    async () => {
      const cwd = createRoot();
      const composition = createWorkflowRunComposition('sqlite', {
        cwd,
        projectCwd: cwd,
      });
      const first = await composition.storage.beginRun({
        workflowConfig: workflow,
        task: 'same task',
      });
      const second = await composition.storage.beginRun({
        workflowConfig: workflow,
        task: 'same task',
      });

      expect(second.runSlug).not.toBe(first.runSlug);
      const firstRoot = openRunStorage({
        databasePath: first.runPaths.databaseAbs,
      });
      expect(firstRoot.readResumeSnapshot().run.runId).toBe(first.runSlug);
      firstRoot.close();
      await failRun(first, cwd);
      await failRun(second, cwd);
    },
  );
});
