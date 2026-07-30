import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FindingLedger, WorkflowConfig } from '../core/models/index.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import { runFindingManagerForStep } from '../core/workflow/findings/manager-runner.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { readRunMeta } from '../core/workflow/run/run-meta.js';
import { createBootstrapRecoverySeed } from '../core/workflow/run/bootstrap-recovery-seed.js';
import {
  createRunStorage,
  openRunStorage,
} from '../infra/run-storage/index.js';
import type {
  LeaseHandle,
  RunStorageRoot,
} from '../infra/run-storage/index.js';
import {
  createWorkflowRunComposition,
  TOP_LEVEL_WORKFLOW_EXECUTION_STEP_KEY,
  type WorkflowRunExecutionContext,
} from '../features/tasks/execute/workflowRunStorage.js';
import {
  SqliteWorkflowRunStorageLifecycle,
} from '../features/tasks/execute/sqliteWorkflowRunStorageLifecycle.js';
import { authorizeFindingLedgerFixture } from './helpers/finding-lifecycle-fixture.js';
import {
  createWorkflowTerminalPayloadFactory,
} from '../features/tasks/execute/workflowTerminalPayload.js';
import {
  createSessionLog,
  initNdjsonLog,
} from '../infra/fs/index.js';
import {
  resolveWorkflowRunTerminalStatus,
} from '../features/tasks/execute/workflowTerminalStatus.js';
import type { RunStorageBackend } from '../core/models/config-types.js';
import { findingReviewPublicationFixture } from './helpers/finding-review-publication.js';

const roots: string[] = [];
const TERMINAL_PUBLICATION_PAYLOAD = '{}';

async function createTestWorkflowRunStorage(
  input: Omit<
    WorkflowRunExecutionContext,
    'terminalPayloads'
  > & {
    readonly backend: RunStorageBackend;
    readonly cwd: string;
    readonly projectCwd: string;
  },
) {
  const {
    backend,
    cwd,
    projectCwd,
    ...storageInput
  } = input;
  const provider = createWorkflowRunComposition(backend, {
    cwd,
    projectCwd,
  });
  const activeRun = await provider.storage.beginRun({
    workflowConfig: input.workflowConfig,
    task: 'task',
    requestedRunSlug: input.runPaths.slug,
    ...(input.resumeSource === undefined
      ? {}
      : { resumeSource: input.resumeSource }),
  });
  activeRun.bootstrap.publishRunMeta({
    runPaths: input.runPaths,
    task: 'task',
    workflowName: input.workflowConfig.name,
    ...(input.resumeSource === undefined
      ? {}
      : { resumeSource: input.resumeSource }),
  });
  const sessionLog = createSessionLog(
    'task',
    cwd,
    input.workflowConfig.name,
    { startTime: activeRun.bootstrap.startedAt },
  );
  const ndjsonLogPath = initNdjsonLog(
    activeRun.bootstrap.sessionId,
    'task',
    input.workflowConfig.name,
    {
      logsDir: input.runPaths.logsAbs,
      startTime: activeRun.bootstrap.startedAt,
    },
  );
  const terminalPayloads = createWorkflowTerminalPayloadFactory({
    runSlug: input.runPaths.slug,
    projectCwd,
    task: 'task',
    workflowName: input.workflowConfig.name,
    sessionLog,
    sessionId: activeRun.bootstrap.sessionId,
    ndjsonLogPath,
    traceReportMode: 'redacted',
    metaSeed: {
      backend,
      startedAt: activeRun.bootstrap.startedAt,
      resumeSource: input.resumeSource === undefined
        ? null
        : {
            mode: input.resumeSource.resumeMode,
            sourceRunSlug: input.resumeSource.sourceRunSlug ?? null,
          },
    },
  });
  const binding = await activeRun.bindExecution({
    ...storageInput,
    terminalPayloads,
  });
  const execution = {
    run: binding.execution.run,
    finish: activeRun.finish,
  };
  return {
    provider,
    bootstrap: activeRun.bootstrap,
    terminalPayloads,
    executionHandle: execution,
    findingAuthorityResolver: binding.findingAuthorityResolver,
    finishPayload: async (
      payload: ReturnType<typeof terminalPayloads.create>,
      status: 'completed' | 'failed' | 'cancelled',
    ) => execution.finish({
      status,
      iteration: payload.iterations,
      ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    }, payload),
    complete: async (finishInput: {
        readonly status: 'completed' | 'failed' | 'cancelled';
        readonly iteration: number;
        readonly reason?: string;
        readonly publicationPayload: string;
      }): Promise<void> => {
      const publicationStatus = finishInput.status === 'cancelled'
        ? 'aborted'
        : finishInput.status;
      const payload = terminalPayloads.create({
        status: publicationStatus,
        iterations: finishInput.iteration,
        ...(finishInput.reason === undefined
          ? {}
          : { reason: finishInput.reason }),
        lastStepContent: publicationStatus === 'completed' ? 'done' : undefined,
        lastStepName: 'done',
        endTime: '2026-07-27T10:00:00.000Z',
      });
      const finalization = await execution.finish({
        status: finishInput.status,
        iteration: finishInput.iteration,
        ...(finishInput.reason === undefined
          ? {}
          : { reason: finishInput.reason }),
      }, payload);
      if (finalization.issues.length !== 0) {
        throw new AggregateError(finalization.issues);
      }
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-workflow-run-storage-'));
  roots.push(root);
  return root;
}

function workflow(withFindingContract: boolean): WorkflowConfig {
  return {
    name: 'storage-test',
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
            ledgerPath: '.takt/findings/storage-test.json',
            rawFindingsPath: '.takt/findings/raw',
            reviewerOutput: 'structured',
            manager: {
              persona: 'findings-manager',
              instruction: 'manage',
              outputContract: 'findings-manager',
            },
          },
        }
      : {}),
  };
}

function findingWorkflow(name: string): WorkflowConfig {
  return {
    ...workflow(true),
    name,
    findingContract: {
      ledgerPath: `.takt/findings/${name}.json`,
      rawFindingsPath: `.takt/findings/${name}-raw`,
      reviewerOutput: 'structured',
      manager: {
        persona: 'findings-manager',
        instruction: 'manage',
        outputContract: 'findings-manager',
      },
    },
  };
}

async function runEmptyManagerRound(
  store: FindingLedgerStore,
  callNamespace: string,
): Promise<void> {
  const result = await runFindingManagerForStep({
    contract: workflow(true).findingContract!,
    ledgerStore: store,
    optionsBuilder: {
      resolveStepProviderModel: () => ({
        provider: 'codex',
        model: 'gpt-test',
      }),
    } as never,
    stepExecutor: {
      buildPhase1Instruction: (instruction: string) => instruction,
      recordSynthesizedAgentUsage: () => undefined,
      normalizeStructuredOutput: (_step: unknown, response: unknown) => response,
    } as never,
    cwd: process.cwd(),
    parentStep: {
      kind: 'agent',
      name: 'reviewers',
      persona: 'reviewer',
      edit: false,
    } as never,
    stepIteration: 1,
    subResults: [{
      subStep: {
        kind: 'agent',
        name: 'architecture-review',
        persona: 'architecture-reviewer',
        edit: false,
      } as never,
      publication: findingReviewPublicationFixture({
        scopeIdentity: store.ledgerIdentity,
        parentStepName: 'reviewers',
        stepIteration: 1,
        reviewerStepName: 'architecture-review',
        callNamespace,
        reportContent: 'APPROVE',
        rawFindings: [],
      }),
    }],
    workflowName: store.workflowName,
    runId: store.runId,
    callNamespace,
    timestamp: '2026-07-27T00:00:00.000Z',
  });
  expect(result.status).toBe('updated');
}

function withOpenFinding(
  ledger: FindingLedger,
  findingId: string,
): FindingLedger {
  const observation = {
    runId: 'source-run',
    stepName: 'review',
    timestamp: ledger.updatedAt,
  };
  return authorizeFindingLedgerFixture({
    ...ledger,
    nextId: Number.parseInt(findingId.slice(2), 10) + 1,
    findings: [
      ...ledger.findings,
      {
        id: findingId,
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: `${findingId} remains open`,
        evidenceIds: [],
        description: 'Resume must preserve this open finding.',
        reviewers: ['reviewer'],
        rawFindingIds: [],
        firstSeen: observation,
        lastSeen: observation,
        revision: 1,
      },
    ],
    stopBudget: {
      roundMarkers: [`round-${findingId}`],
      firstRoundAt: ledger.updatedAt,
      exhausted: false,
    },
  });
}

function writeRunMeta(
  cwd: string,
  slug: string,
  storageBackend: 'file' | 'sqlite',
  workflowName = 'storage-test',
): void {
  const paths = buildRunPaths(cwd, slug);
  mkdirSync(paths.runRootAbs, { recursive: true });
  writeFileSync(paths.metaAbs, JSON.stringify({
    task: 'task',
    workflow: workflowName,
    runSlug: slug,
    runRoot: paths.runRootRel,
    reportDirectory: paths.reportsRel,
    contextDirectory: paths.contextRel,
    logsDirectory: paths.logsRel,
    storageBackend,
    status: 'completed',
    startTime: '2026-07-27T00:00:00.000Z',
  }));
}

describe('workflow run storage composition', () => {
  it('maps workflow results to completed, failed, and cancelled terminal states', () => {
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

  it.each(['file', 'sqlite'] as const)(
    '%s implementation satisfies the shared Finding authority and terminal lifecycle contract',
    async (backend) => {
      const cwd = createRoot();
      const runPaths = buildRunPaths(cwd, `${backend}-contract-run`);
      const storage = await createTestWorkflowRunStorage({
        backend,
        workflowConfig: workflow(true),
        projectCwd: cwd,
        cwd,
        runPaths,
      });

      const store = storage.findingAuthorityResolver.resolve({
        workflowConfig: workflow(true),
        runPaths,
        runPathNamespace: [],
      });
      expect(store.runId).toBe(runPaths.slug);
      expect(store.workflowName).toBe('storage-test');
      expect(() => store.saveRawFindings(
        store.runId,
        'contract-reviewer',
        [],
      )).not.toThrow();
      expect(storage.executionHandle).not.toHaveProperty(
        'terminalCommittedBeforeCreation',
      );
      expect(storage.executionHandle).not.toHaveProperty(
        'setupFailureTerminalCommitted',
      );
      expect(Object.keys(storage.executionHandle).sort()).toEqual([
        'finish',
        'run',
      ]);
      expect(storage.executionHandle).not.toHaveProperty('assertHealthy');
      expect(storage.executionHandle).not.toHaveProperty('close');
      expect(storage.executionHandle).not.toHaveProperty('publishTerminal');
      expect(storage.executionHandle).toMatchObject({
        run: expect.any(Function),
        finish: expect.any(Function),
      });
      await expect(storage.complete({
        status: 'completed',
        iteration: 0,
        publicationPayload: TERMINAL_PUBLICATION_PAYLOAD,
      })).resolves.toBeUndefined();
    },
  );

  it('File通常実行は従来のmeta・NDJSON・traceを直接生成する', async () => {
    const cwd = createRoot();
    const runPaths = buildRunPaths(cwd, 'file-adapter-run');
    const storage = await createTestWorkflowRunStorage({
      backend: 'file',
      workflowConfig: workflow(false),
      projectCwd: cwd,
      cwd,
      runPaths,
    });
    const payload = storage.terminalPayloads.create({
      status: 'completed',
      iterations: 1,
      lastStepContent: 'done',
      lastStepName: 'done',
      endTime: '2026-07-27T10:00:00.000Z',
    });
    const finalization = await storage.finishPayload(payload, 'completed');
    expect(finalization.issues).toEqual([]);
    expect(JSON.parse(readFileSync(runPaths.metaAbs, 'utf-8'))).toMatchObject({
      status: 'completed',
      iterations: 1,
    });
    expect(readFileSync(
      join(runPaths.logsAbs, `${storage.bootstrap.sessionId}.jsonl`),
      'utf-8',
    )).toContain('"type":"workflow_complete"');
    expect(existsSync(join(runPaths.runRootAbs, 'trace.md'))).toBe(true);
  });

  it('SQLite terminal status assert失敗でもheartbeat停止・lease解放・closeを完了する', async () => {
    vi.useFakeTimers();
    const cwd = createRoot();
    const runPaths = buildRunPaths(cwd, 'sqlite-status-assert-run');
    const storage = await createTestWorkflowRunStorage({
      backend: 'sqlite',
      workflowConfig: workflow(false),
      projectCwd: cwd,
      cwd,
      runPaths,
    });
    const payload = storage.terminalPayloads.create({
      status: 'completed',
      iterations: 1,
      lastStepContent: 'done',
      lastStepName: 'done',
      endTime: '2026-07-27T10:00:00.000Z',
    });

    await expect(
      storage.executionHandle.finish({
        status: 'failed',
        iteration: 1,
        reason: 'failed',
      }, payload),
    ).rejects.toThrow(/does not match run status/i);
    expect(vi.getTimerCount()).toBe(0);
    const reopened = openRunStorage({
      databasePath: runPaths.databaseAbs,
    });
    const replacementLease = reopened.claimLease({
      ownerKey: 'replacement-owner',
      leaseDurationMs: 30_000,
    });
    reopened.releaseLease(replacementLease);
    reopened.close();
  });

  it('SQLiteがstage時点のnested terminal snapshotを投影する', async () => {
    const observations: Array<{
      readonly content: string;
      readonly stackStep: string;
      readonly traceQuery: string;
    }> = [];

    for (const backend of ['sqlite'] as const) {
      const cwd = createRoot();
      const runPaths = buildRunPaths(cwd, `${backend}-snapshot-run`);
      const workflowConfig = workflow(false);
      const storage = await createTestWorkflowRunStorage({
        backend,
        workflowConfig,
        projectCwd: cwd,
        cwd,
        runPaths,
      });
      const sessionLog = createSessionLog(
        'task',
        cwd,
        workflowConfig.name,
        { startTime: storage.bootstrap.startedAt },
      );
      sessionLog.history.push({
        step: 'done',
        persona: 'coder',
        instruction: 'done',
        status: 'done',
        timestamp: '2026-07-27T09:30:00.000Z',
        content: 'before-content',
        stack: [{
          workflow: workflowConfig.name,
          workflow_ref: 'project:sha256:snapshot-workflow',
          step: 'done',
          kind: 'agent',
          occurrence: 1,
        }],
      });
      const ndjsonLogPath = initNdjsonLog(
        storage.bootstrap.sessionId,
        'task',
        workflowConfig.name,
        {
          logsDir: runPaths.logsAbs,
          startTime: sessionLog.startTime,
        },
      );
      const traceQueries = ['before-query'];
      const payload = createWorkflowTerminalPayloadFactory({
        runSlug: runPaths.slug,
        projectCwd: cwd,
        task: 'task',
        workflowName: workflowConfig.name,
        sessionLog,
        sessionId: storage.bootstrap.sessionId,
        ndjsonLogPath,
        traceReportMode: 'redacted',
        metaSeed: {
          backend,
          startedAt: storage.bootstrap.startedAt,
          resumeSource: null,
        },
        traceDiscovery: {
          serviceName: 'takt',
          runId: runPaths.slug,
          workflowName: workflowConfig.name,
          queries: traceQueries,
        },
      }).create({
        status: 'completed',
        iterations: 1,
        lastStepContent: 'done',
        lastStepName: 'done',
        endTime: '2026-07-27T10:00:00.000Z',
      });

      sessionLog.startTime = '2026-07-27T09:59:00.000Z';
      sessionLog.history[0]!.content = 'after-content';
      sessionLog.history[0]!.stack![0]!.step = 'after-step';
      traceQueries[0] = 'after-query';
      const finalization = await storage.finishPayload(payload, 'completed');
      expect(finalization.issues).toEqual([]);

      const reopened = openRunStorage({
        databasePath: runPaths.databaseAbs,
      });
      const stored = JSON.parse(
        reopened.readTerminalPublication()!.payload,
      ) as typeof payload;
      reopened.close();
      observations.push({
        content: stored.sessionLog.history[0]!.content,
        stackStep: stored.sessionLog.history[0]!.stack![0]!.step,
        traceQuery: stored.traceDiscovery!.queries[0]!,
      });
    }

    expect(observations[0]).toEqual({
      content: 'before-content',
      stackStep: 'done',
      traceQuery: 'before-query',
    });
  });

  it('keeps file backend on the existing Finding ledger authority', async () => {
    const cwd = createRoot();
    const runPaths = buildRunPaths(cwd, 'file-run');
    const storage = await createTestWorkflowRunStorage({
      backend: 'file',
      workflowConfig: workflow(true),
      projectCwd: cwd,
      cwd,
      runPaths,
    });

    expect(storage.findingAuthorityResolver.resolve({
      workflowConfig: workflow(true),
      runPaths,
      runPathNamespace: [],
    }).workflowName).toBe('storage-test');
    expect(existsSync(runPaths.databaseAbs)).toBe(false);
  });

  it('binds a file child Finding store to the resolved root run slug', async () => {
    const cwd = createRoot();
    const rootRunPaths = buildRunPaths(cwd, 'file-child-run');
    const childRunPaths = buildRunPaths(cwd, rootRunPaths.slug, [
      'subworkflows',
      'parallel-review-child',
    ]);
    const childWorkflow = findingWorkflow('child-review');
    const storage = await createTestWorkflowRunStorage({
      backend: 'file',
      workflowConfig: workflow(false),
      projectCwd: cwd,
      cwd,
      runPaths: rootRunPaths,
    });
    mkdirSync(childRunPaths.reportsAbs, { recursive: true });

    const store = storage.findingAuthorityResolver.resolve({
      workflowConfig: childWorkflow,
      runPaths: childRunPaths,
      runPathNamespace: [
        'subworkflows',
        'parallel-review-child',
      ],
      workflowCallSiteIdentity: 'parallel-review-child',
    });

    expect(store.runId).toBe(rootRunPaths.slug);
    expect(() => store.saveLedgerSnapshot()).not.toThrow();
    expect(existsSync(join(
      childRunPaths.reportsAbs,
      'findings-ledger.json',
    ))).toBe(true);
  });

  it('does not construct a Finding store when the workflow has no contract', async () => {
    const cwd = createRoot();
    const runPaths = buildRunPaths(cwd, 'file-run-without-findings');
    await createTestWorkflowRunStorage({
      backend: 'file',
      workflowConfig: workflow(false),
      projectCwd: cwd,
      cwd,
      runPaths,
    });

    expect(existsSync(runPaths.databaseAbs)).toBe(false);
  });

  it('creates SQLite authority and records a named top-level execution', async () => {
    const cwd = createRoot();
    const runPaths = buildRunPaths(cwd, 'sqlite-run');
    const storage = await createTestWorkflowRunStorage({
      backend: 'sqlite',
      workflowConfig: workflow(true),
      projectCwd: cwd,
      cwd,
      runPaths,
    });
    const rootStore = storage.findingAuthorityResolver.resolve({
      workflowConfig: workflow(true),
      runPaths,
      runPathNamespace: [],
    });
    expect(rootStore.runId).toBe(runPaths.slug);
    expect(() => rootStore.saveRawFindings(
      rootStore.runId,
      'reviewers',
      [],
    )).not.toThrow();
    await runEmptyManagerRound(rootStore, '');
    expect(rootStore.loadLedger()).toMatchObject({
      workflowName: 'storage-test',
    });
    expect(existsSync(join(
      cwd,
      '.takt/findings/storage-test.json',
    ))).toBe(false);
    await expect(storage.complete({
      status: 'completed',
      iteration: 1,
      publicationPayload: TERMINAL_PUBLICATION_PAYLOAD,
    })).resolves.toBeUndefined();

    const reopened = openRunStorage({ databasePath: runPaths.databaseAbs });
    const snapshot = reopened.readResumeSnapshot();
    expect(snapshot.run.status).toBe('completed');
    expect(snapshot.scopes[0]?.stepExecutions).toEqual([
      expect.objectContaining({
        stepId: TOP_LEVEL_WORKFLOW_EXECUTION_STEP_KEY,
        status: 'completed',
      }),
    ]);
    reopened.close();
  });

  it('imports the source SQLite Finding authority into a resumed target', async () => {
    const cwd = createRoot();
    const sourcePaths = buildRunPaths(cwd, 'source-run');
    const source = await createTestWorkflowRunStorage({
      backend: 'sqlite',
      workflowConfig: workflow(true),
      projectCwd: cwd,
      cwd,
      runPaths: sourcePaths,
    });
    const sourceStore = source.findingAuthorityResolver.resolve({
      workflowConfig: workflow(true),
      runPaths: sourcePaths,
      runPathNamespace: [],
    });
    await sourceStore.updateLedger((ledger) => ({
      ledger: { ...ledger, nextId: 7 },
      result: undefined,
    }));
    await source.complete({
      status: 'failed',
      iteration: 1,
      reason: 'resume source failed',
      publicationPayload: TERMINAL_PUBLICATION_PAYLOAD,
    });
    writeRunMeta(cwd, sourcePaths.slug, 'sqlite');

    const targetPaths = buildRunPaths(cwd, 'target-run');
    const target = await createTestWorkflowRunStorage({
      backend: 'sqlite',
      workflowConfig: workflow(true),
      projectCwd: cwd,
      cwd,
      runPaths: targetPaths,
      resumeSource: {
        sourceRunSlug: sourcePaths.slug,
        resumeMode: 'retry',
      },
    });

    const targetStore = target.findingAuthorityResolver.resolve({
      workflowConfig: workflow(true),
      runPaths: targetPaths,
      runPathNamespace: [],
    });
    expect(targetStore.loadLedger().nextId).toBe(7);
    await target.complete({
      status: 'completed',
      iteration: 1,
      publicationPayload: TERMINAL_PUBLICATION_PAYLOAD,
    });
  });

  it('imports every current Finding projection and reuses imported workflow-call scopes', async () => {
    const cwd = createRoot();
    const rootWorkflow = findingWorkflow('root-authority');
    const childA = findingWorkflow('child-authority-a');
    const childB = findingWorkflow('child-authority-b');
    const childC = findingWorkflow('child-authority-c');
    const sourcePaths = buildRunPaths(cwd, 'multi-authority-source');
    const source = await createTestWorkflowRunStorage({
      backend: 'sqlite',
      workflowConfig: rootWorkflow,
      projectCwd: cwd,
      cwd,
      runPaths: sourcePaths,
    });
    const childAStore = source.findingAuthorityResolver.resolve({
      workflowConfig: childA,
      runPaths: sourcePaths,
      runPathNamespace: ['call-a'],
      workflowCallSiteIdentity: 'call-a',
    });
    const childBStore = source.findingAuthorityResolver.resolve({
      workflowConfig: childB,
      runPaths: sourcePaths,
      runPathNamespace: ['call-b'],
      workflowCallSiteIdentity: 'call-b',
    });
    expect(childAStore.runId).toBe(sourcePaths.slug);
    expect(childBStore.runId).toBe(sourcePaths.slug);
    expect(() => childAStore.saveRawFindings(
      childAStore.runId,
      'reviewers',
      [],
    )).not.toThrow();
    expect(() => childBStore.saveRawFindings(
      childBStore.runId,
      'reviewers',
      [],
    )).not.toThrow();
    await runEmptyManagerRound(childAStore, 'call-a');
    await runEmptyManagerRound(childBStore, 'call-b');
    await childAStore.updateLedger((ledger) => ({
      ledger: withOpenFinding(ledger, 'F-0001'),
      result: undefined,
    }));
    await childAStore.updateLedger((ledger) => ({
      ledger: {
        ...ledger,
        fixpoint: {
          snapshot: {
            provisionalKeys: [],
            substantiveEntries: ['F-0001:open'],
            unadjudicatedConflictEntries: [],
          },
          reached: false,
        },
      },
      result: undefined,
    }));
    await childBStore.updateLedger((ledger) => ({
      ledger: withOpenFinding(ledger, 'F-0002'),
      result: undefined,
    }));
    await source.complete({
      status: 'failed',
      iteration: 1,
      reason: 'resume source failed',
      publicationPayload: TERMINAL_PUBLICATION_PAYLOAD,
    });
    writeRunMeta(cwd, sourcePaths.slug, 'sqlite');

    const targetPaths = buildRunPaths(cwd, 'multi-authority-target');
    const target = await createTestWorkflowRunStorage({
      backend: 'sqlite',
      workflowConfig: rootWorkflow,
      projectCwd: cwd,
      cwd,
      runPaths: targetPaths,
      resumeSource: {
        sourceRunSlug: sourcePaths.slug,
        resumeMode: 'retry',
      },
    });

    const importedRoot = openRunStorage({
      databasePath: targetPaths.databaseAbs,
    });
    const imported = importedRoot.readResumeSnapshot();
    importedRoot.close();
    expect(imported.findingHeads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        current_revision: 1,
      }),
      expect.objectContaining({
        current_revision: 1,
      }),
    ]));

    const scopeCountBeforeResolve = imported.scopes.length;
    const resumedA = target.findingAuthorityResolver.resolve({
      workflowConfig: childA,
      runPaths: targetPaths,
      runPathNamespace: ['call-a'],
      workflowCallSiteIdentity: 'call-a',
    });
    const newAuthority = target.findingAuthorityResolver.resolve({
      workflowConfig: childC,
      runPaths: targetPaths,
      runPathNamespace: ['call-c'],
      workflowCallSiteIdentity: 'call-c',
    });
    expect(resumedA.loadLedger()).toMatchObject({
      findings: [expect.objectContaining({ id: 'F-0001', status: 'open' })],
      stopBudget: expect.objectContaining({
        roundMarkers: ['round-F-0001'],
      }),
      fixpoint: expect.objectContaining({ reached: false }),
    });
    expect(newAuthority.loadLedger()).toMatchObject({
      workflowName: 'child-authority-c',
      findings: [],
    });
    await target.complete({
      status: 'completed',
      iteration: 1,
      publicationPayload: TERMINAL_PUBLICATION_PAYLOAD,
    });

    const completed = openRunStorage({ databasePath: targetPaths.databaseAbs });
    const completedSnapshot = completed.readResumeSnapshot();
    expect(completedSnapshot.scopes).toHaveLength(scopeCountBeforeResolve + 1);
    expect(completedSnapshot.scopes.every(
      (scope) => scope.runtime.status === 'completed',
    )).toBe(true);
    expect(completedSnapshot.findingHeads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        current_revision: 1,
      }),
      expect.objectContaining({
        current_revision: 1,
      }),
    ]));
    completed.close();
  });

  it('resumes a reached child authority when the root has no Finding Contract', async () => {
    const cwd = createRoot();
    const rootWorkflow = workflow(false);
    const childWorkflow = findingWorkflow('child-only-authority');
    const sourcePaths = buildRunPaths(cwd, 'child-only-source');
    const source = await createTestWorkflowRunStorage({
      backend: 'sqlite',
      workflowConfig: rootWorkflow,
      projectCwd: cwd,
      cwd,
      runPaths: sourcePaths,
    });
    const sourceStore = source.findingAuthorityResolver.resolve({
      workflowConfig: childWorkflow,
      runPaths: sourcePaths,
      runPathNamespace: ['child-only-call'],
      workflowCallSiteIdentity: 'child-only-call',
    });
    await sourceStore.updateLedger((ledger) => ({
      ledger: withOpenFinding(ledger, 'F-0001'),
      result: undefined,
    }));
    await source.complete({
      status: 'failed',
      iteration: 1,
      reason: 'resume source failed',
      publicationPayload: TERMINAL_PUBLICATION_PAYLOAD,
    });
    writeRunMeta(cwd, sourcePaths.slug, 'sqlite');

    const targetPaths = buildRunPaths(cwd, 'child-only-target');
    const target = await createTestWorkflowRunStorage({
      backend: 'sqlite',
      workflowConfig: rootWorkflow,
      projectCwd: cwd,
      cwd,
      runPaths: targetPaths,
      resumeSource: {
        sourceRunSlug: sourcePaths.slug,
        resumeMode: 'retry',
      },
    });
    const resumedStore = target.findingAuthorityResolver.resolve({
      workflowConfig: childWorkflow,
      runPaths: targetPaths,
      runPathNamespace: ['child-only-call'],
      workflowCallSiteIdentity: 'child-only-call',
    });
    expect(resumedStore.runId).toBe(targetPaths.slug);
    expect(() => resumedStore.saveRawFindings(
      resumedStore.runId,
      'reviewers',
      [],
    )).not.toThrow();
    await runEmptyManagerRound(
      resumedStore,
      'child-only-call',
    );
    expect(resumedStore.loadLedger()).toMatchObject({
      workflowName: 'child-only-authority',
      findings: [expect.objectContaining({ id: 'F-0001', status: 'open' })],
    });
    await target.complete({
      status: 'completed',
      iteration: 1,
      publicationPayload: TERMINAL_PUBLICATION_PAYLOAD,
    });

    const completed = openRunStorage({ databasePath: targetPaths.databaseAbs });
    const snapshot = completed.readResumeSnapshot();
    completed.close();
    expect(snapshot.run).toMatchObject({
      findingContractEnabled: 1,
      status: 'completed',
    });
    expect(snapshot.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scopeId: 'root',
        findingContractEnabled: 0,
      }),
      expect.objectContaining({
        kind: 'workflow_call',
        findingContractEnabled: 1,
      }),
    ]));
  });

  it('uses the current meta workflow when resuming SQLite Finding state', async () => {
    const cwd = createRoot();
    const sourceWorkflow = findingWorkflow('source-workflow');
    const targetWorkflow = findingWorkflow('target-workflow');
    const sourcePaths = buildRunPaths(cwd, 'workflow-switch-source');
    const source = await createTestWorkflowRunStorage({
      backend: 'sqlite',
      workflowConfig: sourceWorkflow,
      projectCwd: cwd,
      cwd,
      runPaths: sourcePaths,
    });
    const sourceStore = source.findingAuthorityResolver.resolve({
      workflowConfig: sourceWorkflow,
      runPaths: sourcePaths,
    });
    await sourceStore.updateLedger((ledger) => ({
      ledger: { ...ledger, nextId: 7 },
      result: undefined,
    }));
    await source.complete({
      status: 'failed',
      iteration: 1,
      reason: 'resume under another workflow',
      publicationPayload: TERMINAL_PUBLICATION_PAYLOAD,
    });
    writeRunMeta(cwd, sourcePaths.slug, 'sqlite', sourceWorkflow.name);

    const targetPaths = buildRunPaths(cwd, 'workflow-switch-target');
    const target = await createTestWorkflowRunStorage({
      backend: 'sqlite',
      workflowConfig: targetWorkflow,
      projectCwd: cwd,
      cwd,
      runPaths: targetPaths,
      resumeSource: {
        sourceRunSlug: sourcePaths.slug,
        resumeMode: 'retry',
      },
    });
    const targetStore = target.findingAuthorityResolver.resolve({
      workflowConfig: targetWorkflow,
      runPaths: targetPaths,
    });

    expect(readRunMeta(targetPaths.metaAbs)?.workflow).toBe('target-workflow');
    expect(targetStore.loadLedger()).toMatchObject({
      workflowName: 'target-workflow',
      nextId: 7,
    });
    await target.complete({
      status: 'completed',
      iteration: 1,
      publicationPayload: TERMINAL_PUBLICATION_PAYLOAD,
    });
  });

  it('fails loudly when resume authority selects another backend', async () => {
    const cwd = createRoot();
    const sourcePaths = buildRunPaths(cwd, 'file-source');
    writeRunMeta(cwd, sourcePaths.slug, 'file');
    const targetPaths = buildRunPaths(cwd, 'sqlite-target');

    await expect(createTestWorkflowRunStorage({
      backend: 'sqlite',
      workflowConfig: workflow(true),
      projectCwd: cwd,
      cwd,
      runPaths: targetPaths,
      resumeSource: {
        sourceRunSlug: 'file-source',
        resumeMode: 'retry',
      },
    })).rejects.toThrow(/backend mismatch/i);
    expect(existsSync(targetPaths.databaseAbs)).toBe(false);
  });

  it('requested source directory slugとSQLite内run slugの差替えを拒否する', async () => {
    const cwd = createRoot();
    const actualPaths = buildRunPaths(cwd, 'run-b');
    mkdirSync(actualPaths.runRootAbs, { recursive: true });
    const actual = createRunStorage({
      databasePath: actualPaths.databaseAbs,
      bootstrapSeed: createBootstrapRecoverySeed({
        task: 'task',
        workflowName: 'storage-test',
        projectCwd: cwd,
        backend: 'sqlite',
        startedAt: '2026-07-27T09:00:00.000Z',
        sessionId: 'run-b-session',
      }),
      run: {
        runId: actualPaths.slug,
        workflowName: 'storage-test',
        findingContractEnabled: true,
      },
    });
    actual.close();
    const requestedPaths = buildRunPaths(cwd, 'run-a');
    mkdirSync(requestedPaths.runRootAbs, { recursive: true });
    copyFileSync(actualPaths.databaseAbs, requestedPaths.databaseAbs);
    writeRunMeta(cwd, requestedPaths.slug, 'sqlite');
    const targetPaths = buildRunPaths(cwd, 'target-run');

    await expect(createTestWorkflowRunStorage({
      backend: 'sqlite',
      workflowConfig: workflow(true),
      projectCwd: cwd,
      cwd,
      runPaths: targetPaths,
      resumeSource: {
        sourceRunSlug: requestedPaths.slug,
        resumeMode: 'retry',
      },
    })).rejects.toThrow(
      /database slug "run-b".*requested source run "run-a"/i,
    );
    expect(existsSync(targetPaths.databaseAbs)).toBe(false);
  });

  it('also rejects a SQLite source when the current backend is file', async () => {
    const cwd = createRoot();
    const sourcePaths = buildRunPaths(cwd, 'sqlite-source');
    mkdirSync(sourcePaths.runRootAbs, { recursive: true });
    createRunStorage({
      databasePath: sourcePaths.databaseAbs,
      bootstrapSeed: createBootstrapRecoverySeed({
        task: 'task',
        workflowName: 'storage-test',
        projectCwd: cwd,
        backend: 'sqlite',
        startedAt: '2026-07-27T09:00:00.000Z',
        sessionId: 'sqlite-source-session',
      }),
      run: {
        runId: sourcePaths.slug,
        workflowName: 'storage-test',
        findingContractEnabled: true,
      },
    }).close();
    const targetPaths = buildRunPaths(cwd, 'file-target');

    await expect(createTestWorkflowRunStorage({
      backend: 'file',
      workflowConfig: workflow(true),
      projectCwd: cwd,
      cwd,
      runPaths: targetPaths,
      resumeSource: {
        sourceRunSlug: 'sqlite-source',
        resumeMode: 'retry',
      },
    })).rejects.toThrow(/backend mismatch/i);
  });

  it('rejects an identical SQLite resume source and target path', async () => {
    const cwd = createRoot();
    const paths = buildRunPaths(cwd, 'same-run');
    const source = await createTestWorkflowRunStorage({
      backend: 'sqlite',
      workflowConfig: workflow(true),
      projectCwd: cwd,
      cwd,
      runPaths: paths,
    });
    await source.complete({
      status: 'failed',
      iteration: 1,
      reason: 'resume source failed',
      publicationPayload: TERMINAL_PUBLICATION_PAYLOAD,
    });
    writeRunMeta(cwd, paths.slug, 'sqlite');

    await expect(createTestWorkflowRunStorage({
      backend: 'sqlite',
      workflowConfig: workflow(true),
      projectCwd: cwd,
      cwd,
      runPaths: paths,
      resumeSource: {
        sourceRunSlug: paths.slug,
        resumeMode: 'retry',
      },
    })).rejects.toThrow(/distinct source and target run slugs/);
  });

  it('fails loudly when the SQLite resume source database is missing', async () => {
    const cwd = createRoot();
    writeRunMeta(cwd, 'missing-source', 'sqlite');
    const targetPaths = buildRunPaths(cwd, 'sqlite-target');

    await expect(createTestWorkflowRunStorage({
      backend: 'sqlite',
      workflowConfig: workflow(true),
      projectCwd: cwd,
      cwd,
      runPaths: targetPaths,
      resumeSource: {
        sourceRunSlug: 'missing-source',
        resumeMode: 'retry',
      },
    })).rejects.toThrow();
    expect(existsSync(targetPaths.databaseAbs)).toBe(false);
  });

  it('aborts on heartbeat failure and clears the timer during cleanup', async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const finishRun = vi.fn(() => ({
      runId: 'heartbeat-run',
      eventId: 'a'.repeat(64),
      runStatus: 'failed' as const,
      iteration: 2,
      payloadDigest:
        '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      terminalAt: 1,
    }));
    const close = vi.fn();
    const root = {
      heartbeatLease: vi.fn(() => {
        throw new Error('heartbeat failed');
      }),
      finishRun,
      releaseLease: vi.fn(),
      close,
    } as unknown as RunStorageRoot;
    const lifecycle = new SqliteWorkflowRunStorageLifecycle({
      root,
      lease: {} as LeaseHandle,
      abortController,
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toEqual(
      new Error('heartbeat failed'),
    );
    expect(() => lifecycle.assertHealthy()).toThrow('heartbeat failed');
    expect(lifecycle.finish({
      status: 'failed',
      iteration: 2,
      reason: 'heartbeat failed',
    }, TERMINAL_PUBLICATION_PAYLOAD)).toEqual({
      receipt: {
        runId: 'heartbeat-run',
        publicationId: 'a'.repeat(64),
        runStatus: 'failed',
        iteration: 2,
        payloadSha256:
          '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        proof: {
          backend: 'sqlite',
          terminalAt: 1,
        },
      },
      issues: [],
    });
    expect(finishRun).toHaveBeenCalledWith(
      expect.anything(),
      {
        status: 'failed',
        failureReason: 'heartbeat failed',
        publication: {
          status: 'failed',
          iteration: 2,
          reason: 'heartbeat failed',
          payload: TERMINAL_PUBLICATION_PAYLOAD,
        },
      },
    );
    expect(root.releaseLease).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminal commit失敗時も全cleanup errorをprimaryへ集約する', () => {
    const finishRun = vi.fn(() => {
      throw new Error('terminalize failed');
    });
    const releaseLease = vi.fn(() => {
      throw new Error('release failed');
    });
    const close = vi.fn(() => {
      throw new Error('close failed');
    });
    const lifecycle = new SqliteWorkflowRunStorageLifecycle({
      root: {
        heartbeatLease: vi.fn(),
        finishRun,
        releaseLease,
        close,
      } as unknown as RunStorageRoot,
      lease: {} as LeaseHandle,
      abortController: new AbortController(),
    });

    let caught: unknown;
    try {
      lifecycle.finish({
        status: 'failed',
        iteration: 2,
        reason: 'workflow failed',
      }, TERMINAL_PUBLICATION_PAYLOAD);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'terminalize failed' }),
      expect.objectContaining({ message: 'release failed' }),
      expect.objectContaining({ message: 'close failed' }),
    ]);
  });

  it('reports a committed terminal state close error as cleanup issue', () => {
    const closeError = new Error('close failed after commit');
    const root = {
      heartbeatLease: vi.fn(),
      finishRun: vi.fn(() => ({
        runId: 'cleanup-run',
        eventId: 'b'.repeat(64),
        runStatus: 'completed' as const,
        iteration: 2,
        payloadDigest:
          '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        terminalAt: 2,
      })),
      releaseLease: vi.fn(),
      close: vi.fn(() => {
        throw closeError;
      }),
    } as unknown as RunStorageRoot;
    const lifecycle = new SqliteWorkflowRunStorageLifecycle({
      root,
      lease: {} as LeaseHandle,
      abortController: new AbortController(),
    });

    const result = lifecycle.finish({
      status: 'completed',
      iteration: 2,
    }, TERMINAL_PUBLICATION_PAYLOAD);

    expect(result.issues).toEqual([
      expect.objectContaining({
        name: 'RunCleanupError',
        cause: closeError,
      }),
    ]);
    expect(root.releaseLease).not.toHaveBeenCalled();
  });
});
