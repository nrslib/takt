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

  it('binds root and independent children to current-authority rows', async () => {
    const cwd = createRoot();
    const rootWorkflow = workflow('root-workflow', true);
    const childWorkflow = workflow('child-workflow', true);
    const run = await bindRun({
      cwd,
      runSlug: 'authority-rows',
      workflowConfig: rootWorkflow,
    });
    const rootStore = run.binding.findingAuthorityResolver.resolve({
      workflowConfig: rootWorkflow,
      runPaths: run.handle.runPaths,
      runPathNamespace: [],
    });
    expect(run.binding.findingAuthorityResolver.resolve({
      workflowConfig: rootWorkflow,
      runPaths: run.handle.runPaths,
      runPathNamespace: [],
    })).toBe(rootStore);
    const childPathsA = buildRunPaths(cwd, run.handle.runSlug, ['child-a']);
    const childPathsB = buildRunPaths(cwd, run.handle.runSlug, ['child-b']);
    const childA = run.binding.findingAuthorityResolver.resolve({
      workflowConfig: childWorkflow,
      runPaths: childPathsA,
      runPathNamespace: ['child-a'],
      workflowCallSiteIdentity: 'call-site-a',
    });
    const childB = run.binding.findingAuthorityResolver.resolve({
      workflowConfig: childWorkflow,
      runPaths: childPathsB,
      runPathNamespace: ['child-b'],
      workflowCallSiteIdentity: 'call-site-b',
    });

    rootStore.saveLedgerSnapshot();
    childA.saveLedgerSnapshot();
    childB.saveLedgerSnapshot();
    expect(existsSync(join(run.handle.runPaths.reportsAbs, 'findings-ledger.json')))
      .toBe(true);
    expect(existsSync(join(childPathsA.reportsAbs, 'findings-ledger.json'))).toBe(true);
    expect(existsSync(join(childPathsB.reportsAbs, 'findings-ledger.json'))).toBe(true);
    const database = new DatabaseSync(
      run.handle.runPaths.findingContractDatabaseAbs,
      { readOnly: true },
    );
    expect(database.prepare(`
      SELECT authority_key AS authorityKey, workflow_name AS workflowName
      FROM finding_authorities ORDER BY authority_key
    `).all()).toEqual([
      { authorityKey: 'call-site-a', workflowName: 'child-workflow' },
      { authorityKey: 'call-site-b', workflowName: 'child-workflow' },
      { authorityKey: 'root', workflowName: 'root-workflow' },
    ]);
    database.close();
    await finishRun(run);
    expect(() => rootStore.loadLedger()).toThrow(/closed/);
  });

  it('seeds a resumed authority from finding-contract.sqlite and rewrites workflow', async () => {
    const cwd = createRoot();
    const sourceWorkflow = workflow('source-workflow', true);
    const source = await bindRun({
      cwd,
      runSlug: 'source-run',
      workflowConfig: sourceWorkflow,
    });
    const sourceStore = source.binding.findingAuthorityResolver.resolve({
      workflowConfig: sourceWorkflow,
      runPaths: source.handle.runPaths,
      runPathNamespace: [],
    });
    await sourceStore.updateLedger((current) => ({
      ledger: { ...current, updatedAt: '2026-08-01T00:00:01.000Z' },
      result: undefined,
    }));
    await finishRun(source, 'failed');

    const targetWorkflow = workflow('target-workflow', true);
    const target = await bindRun({
      cwd,
      runSlug: 'target-run',
      workflowConfig: targetWorkflow,
      resumeSource: {
        sourceRunSlug: 'source-run',
        resumeMode: 'retry',
      },
    });
    const targetStore = target.binding.findingAuthorityResolver.resolve({
      workflowConfig: targetWorkflow,
      runPaths: target.handle.runPaths,
      runPathNamespace: [],
    });

    expect(targetStore.loadLedger()).toMatchObject({
      workflowName: 'target-workflow',
      updatedAt: '2026-08-01T00:00:01.000Z',
    });
    await finishRun(target);
  });

  it('starts with empty Finding storage when requeue source has no finding-contract.sqlite', async () => {
    const cwd = createRoot();
    const source = await bindRun({
      cwd,
      runSlug: 'file-only-source',
      workflowConfig: workflow('file-only', false),
    });
    expect(existsSync(source.handle.runPaths.findingContractDatabaseAbs)).toBe(false);
    await finishRun(source, 'failed');

    const targetRunSlug = 'fresh-target';
    const targetPaths = buildRunPaths(cwd, targetRunSlug);
    const targetWorkflow = workflow('target-workflow', true);
    const target = await bindRun({
      cwd,
      runSlug: targetRunSlug,
      workflowConfig: targetWorkflow,
      resumeSource: {
        sourceRunSlug: source.handle.runSlug,
        resumeMode: 'requeue',
      },
    });
    const targetStore = target.binding.findingAuthorityResolver.resolve({
      workflowConfig: targetWorkflow,
      runPaths: target.handle.runPaths,
      runPathNamespace: [],
    });

    expect(targetStore.loadLedger()).toMatchObject({
      workflowName: 'target-workflow',
      findings: [],
      rawFindings: [],
    });
    expect(existsSync(targetPaths.findingContractDatabaseAbs)).toBe(true);
    await finishRun(target);
  });

  it('does not inspect requeue source Finding storage when target workflow has no Finding Contract', async () => {
    const cwd = createRoot();
    const source = await bindRun({
      cwd,
      runSlug: 'non-finding-source',
      workflowConfig: workflow('non-finding-source', false),
    });
    writeFileSync(source.handle.runPaths.findingContractDatabaseAbs, 'not sqlite');
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
  });

  it('resolves requeue source lazily when a child workflow uses Finding Contract', async () => {
    const cwd = createRoot();
    const rootWorkflow = workflow('root-without-findings', false);
    const childWorkflow = workflow('child-with-findings', true);
    const source = await bindRun({
      cwd,
      runSlug: 'child-finding-source',
      workflowConfig: rootWorkflow,
    });
    const sourceStore = source.binding.findingAuthorityResolver.resolve({
      workflowConfig: childWorkflow,
      runPaths: source.handle.runPaths,
      runPathNamespace: ['child'],
      workflowCallSiteIdentity: 'child-call-site',
    });
    await sourceStore.updateLedger((current) => ({
      ledger: { ...current, updatedAt: '2026-08-01T00:00:01.000Z' },
      result: undefined,
    }));
    await finishRun(source, 'failed');

    const target = await bindRun({
      cwd,
      runSlug: 'child-finding-target',
      workflowConfig: rootWorkflow,
      resumeSource: {
        sourceRunSlug: source.handle.runSlug,
        resumeMode: 'requeue',
      },
    });
    const targetStore = target.binding.findingAuthorityResolver.resolve({
      workflowConfig: childWorkflow,
      runPaths: target.handle.runPaths,
      runPathNamespace: ['child'],
      workflowCallSiteIdentity: 'child-call-site',
    });

    expect(targetStore.loadLedger()).toMatchObject({
      workflowName: 'child-with-findings',
      updatedAt: '2026-08-01T00:00:01.000Z',
    });
    await finishRun(target);
  });
});
