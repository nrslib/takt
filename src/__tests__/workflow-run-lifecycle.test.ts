import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import type { RunResumeSource } from '../core/workflow/run/run-meta.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import {
  createWorkflowRunLifecycle,
  type WorkflowRunHandle,
} from '../features/tasks/execute/workflowRunLifecycle.js';
import {
  createWorkflowTerminalPayloadFactory,
} from '../features/tasks/execute/workflowTerminalPayload.js';
import {
  resolveWorkflowRunTerminalStatus,
} from '../features/tasks/execute/workflowTerminalStatus.js';
import { createSessionLog, initNdjsonLog } from '../infra/fs/index.js';

const roots: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-workflow-run-lifecycle-'));
  roots.push(root);
  return root;
}

function workflow(name: string, withFindingContract: boolean): WorkflowConfig {
  return {
    name,
    maxSteps: 1,
    initialStep: 'done',
    steps: [{
      name: 'done',
      persona: 'coder',
      instruction: 'done',
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    }],
    ...(withFindingContract
      ? {
          findingContract: {
            manager: {
              persona: 'findings-manager',
              instruction: 'manage',
              outputContract: 'findings-manager',
            },
            adjudicator: { persona: 'supervisor' },
          },
        }
      : {}),
  };
}

async function bindRun(input: {
  readonly cwd: string;
  readonly runSlug: string;
  readonly workflowConfig: WorkflowConfig;
  readonly resumeSource?: RunResumeSource;
}) {
  const composition = createWorkflowRunLifecycle({
    cwd: input.cwd,
  });
  const handle = await composition.lifecycle.beginRun({
    workflowConfig: input.workflowConfig,
    task: 'task',
    requestedRunSlug: input.runSlug,
    ...(input.resumeSource === undefined ? {} : { resumeSource: input.resumeSource }),
  });
  handle.bootstrap.publishRunMeta({
    runPaths: handle.runPaths,
    task: 'task',
    workflowName: input.workflowConfig.name,
    ...(input.resumeSource === undefined ? {} : { resumeSource: input.resumeSource }),
  });
  const sessionLog = createSessionLog(
    'task',
    input.cwd,
    input.workflowConfig.name,
    { startTime: handle.bootstrap.startedAt },
  );
  const ndjsonLogPath = initNdjsonLog(
    handle.bootstrap.sessionId,
    'task',
    input.workflowConfig.name,
    {
      logsDir: handle.runPaths.logsAbs,
      startTime: handle.bootstrap.startedAt,
    },
  );
  const terminalPayloads = createWorkflowTerminalPayloadFactory({
    runSlug: handle.runSlug,
    projectCwd: input.cwd,
    task: 'task',
    workflowName: input.workflowConfig.name,
    sessionLog,
    sessionId: handle.bootstrap.sessionId,
    ndjsonLogPath,
    traceReportMode: 'redacted',
  });
  const binding = await handle.bindExecution({
    workflowConfig: input.workflowConfig,
    ...(input.resumeSource === undefined ? {} : { resumeSource: input.resumeSource }),
    terminalPayloads,
  });
  return { handle, binding, terminalPayloads };
}

async function finishRun(
  run: Awaited<ReturnType<typeof bindRun>>,
  status: 'completed' | 'failed' = 'completed',
): Promise<void> {
  const reason = status === 'failed' ? 'injected failure' : undefined;
  const payload = run.terminalPayloads.create({
    status,
    iterations: 1,
    ...(reason === undefined ? {} : { reason }),
    lastStepContent: status === 'completed' ? 'done' : undefined,
    lastStepName: 'done',
    endTime: '2026-08-01T00:00:00.000Z',
  });
  const finalization = await run.handle.finish({
    status,
    iteration: 1,
    ...(reason === undefined ? {} : { reason }),
  }, payload);
  expect(finalization.issues).toEqual([]);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('workflow run lifecycle composition', () => {
  it('maps workflow results to file terminal states', () => {
    expect(resolveWorkflowRunTerminalStatus({ success: true })).toBe('completed');
    expect(resolveWorkflowRunTerminalStatus({
      success: false,
      abortKind: 'interrupt',
    })).toBe('cancelled');
    expect(resolveWorkflowRunTerminalStatus({
      success: false,
      abortKind: 'user_input_cancelled',
    })).toBe('cancelled');
    expect(resolveWorkflowRunTerminalStatus({
      success: false,
      abortKind: 'step_error',
    })).toBe('failed');
    expect(resolveWorkflowRunTerminalStatus({
      success: false,
      abortKind: 'blocked',
    })).toBe('failed');
    expect(resolveWorkflowRunTerminalStatus({
      success: false,
      abortKind: 'user_input_required',
    })).toBe('failed');
  });

  it('does not create Finding SQLite when no authority is reached', async () => {
    const cwd = createRoot();
    const run = await bindRun({
      cwd,
      runSlug: 'without-findings',
      workflowConfig: workflow('without-findings', false),
    });

    expect(existsSync(run.handle.runPaths.findingContractDatabaseAbs)).toBe(false);
    await finishRun(run);
    expect(existsSync(run.handle.runPaths.findingContractDatabaseAbs)).toBe(false);
    expect(JSON.parse(readFileSync(run.handle.runPaths.metaAbs, 'utf-8'))).toMatchObject({
      status: 'completed',
    });
  });







  it('resumes a normal workflow without opening or changing a residual SQLite file', async () => {
    const cwd = createRoot();
    const source = await bindRun({
      cwd,
      runSlug: 'non-finding-source',
      workflowConfig: workflow('non-finding-source', false),
    });
    const residualBytes = Buffer.from('residual database bytes');
    writeFileSync(source.handle.runPaths.findingContractDatabaseAbs, residualBytes);
    await finishRun(source, 'failed');

    const target = await bindRun({
      cwd,
      runSlug: 'non-finding-target',
      workflowConfig: workflow('non-finding-target', false),
      resumeSource: {
        sourceRunSlug: source.handle.runSlug,
        resumeMode: 'requeue',
      },
    });

    expect(existsSync(target.handle.runPaths.findingContractDatabaseAbs)).toBe(false);
    await finishRun(target);
    expect(readFileSync(source.handle.runPaths.findingContractDatabaseAbs)).toEqual(residualBytes);
  });


});
