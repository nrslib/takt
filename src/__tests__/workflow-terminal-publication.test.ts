import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunStorage, openRunStorage } from '../infra/run-storage/index.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { createBootstrapRecoverySeed } from '../core/workflow/run/bootstrap-recovery-seed.js';
import { createSessionLog, initNdjsonLog } from '../infra/fs/index.js';
import { takeSessionState } from '../infra/config/index.js';
import { RunMetaManager } from '../features/tasks/execute/runMeta.js';
import {
  reconcileWorkflowTerminalPublication,
} from '../features/tasks/execute/workflowTerminalPublication.js';
import {
  createWorkflowTerminalPayloadFactory,
  deserializeWorkflowTerminalPublication,
  serializeWorkflowTerminalPublication,
} from '../features/tasks/execute/workflowTerminalPayload.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-terminal-publication-'));
  roots.push(root);
  return root;
}

function terminalizeRun(
  cwd: string,
  projectCwd: string,
  input: {
    readonly runSlug?: string;
    readonly endTime?: string;
  },
) {
  const runPaths = buildRunPaths(cwd, input.runSlug ?? 'terminal-run');
  mkdirSync(runPaths.runRootAbs, { recursive: true });
  const startedAt = '2026-07-27T09:00:00.000Z';
  new RunMetaManager(
    runPaths,
    'terminal task',
    'terminal-workflow',
    'sqlite',
    undefined,
    { startTime: startedAt },
  );
  const sessionLog = createSessionLog(
    'terminal task',
    cwd,
    'terminal-workflow',
    { startTime: startedAt },
  );
  const ndjsonLogPath = initNdjsonLog(
    'session-1',
    'terminal task',
    'terminal-workflow',
    { logsDir: runPaths.logsAbs, startTime: startedAt },
  );
  const endTime = input.endTime ?? '2026-07-27T10:00:00.000Z';
  const payload = createWorkflowTerminalPayloadFactory({
    runSlug: runPaths.slug,
    projectCwd,
    task: 'terminal task',
    workflowName: 'terminal-workflow',
    sessionLog,
    sessionId: 'session-1',
    ndjsonLogPath,
    traceReportMode: 'redacted',
    metaSeed: {
      backend: 'sqlite',
      startedAt,
      resumeSource: null,
    },
  }).create({
    status: 'completed',
    iterations: 1,
    lastStepContent: 'done',
    lastStepName: 'implement',
    endTime,
  });
  const root = createRunStorage({
    databasePath: runPaths.databaseAbs,
    bootstrapSeed: createBootstrapRecoverySeed({
      task: 'terminal task',
      workflowName: 'terminal-workflow',
      projectCwd,
      backend: 'sqlite',
      startedAt,
      sessionId: 'session-1',
    }),
    run: {
      runId: runPaths.slug,
      findingContractEnabled: false,
    },
    workflowDefinition: {
      name: 'terminal-workflow',
      codecName: 'json-v1',
      definition: '{"name":"terminal-workflow"}',
    },
  });
  const lease = root.claimLease({
    ownerKey: 'terminal-owner',
    leaseDurationMs: 9_000,
  });
  root.finishRun(lease, {
    status: 'completed',
    publication: {
      status: 'completed',
      iteration: 1,
      payload: serializeWorkflowTerminalPublication(payload),
    },
  });
  const eventId = root.readTerminalPublication()!.eventId;
  root.close();
  return { runPaths, ndjsonLogPath, eventId };
}

describe('workflow terminal publication outbox', () => {
  it('欠損したmetaとNDJSONをbootstrap seedから自己冪等に再構築する', async () => {
    const cwd = createRoot();
    const { runPaths, ndjsonLogPath, eventId } = terminalizeRun(
      cwd,
      cwd,
      { runSlug: 'rebuild-projections' },
    );
    unlinkSync(runPaths.metaAbs);
    unlinkSync(ndjsonLogPath);

    const first = await reconcileWorkflowTerminalPublication({
      databasePath: runPaths.databaseAbs,
      expectedRunId: runPaths.slug,
    });
    expect(first.issues).toEqual([]);
    const meta = JSON.parse(readFileSync(runPaths.metaAbs, 'utf-8')) as {
      readonly terminal_publication_id: string;
      readonly status: string;
    };
    expect(meta).toMatchObject({
      terminal_publication_id: eventId,
      status: 'completed',
    });
    const records = readFileSync(ndjsonLogPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { readonly type: string });
    expect(records.map(({ type }) => type)).toEqual([
      'workflow_start',
      'workflow_complete',
    ]);

    const second = await reconcileWorkflowTerminalPublication({
      databasePath: runPaths.databaseAbs,
      expectedRunId: runPaths.slug,
    });
    expect(second.issues).toEqual([]);
    expect(readFileSync(ndjsonLogPath, 'utf-8')
      .trim()
      .split('\n')).toHaveLength(2);
  });

  it('malformed NDJSONは上書きせずsession stageを未ACKに保つ', async () => {
    const cwd = createRoot();
    const { runPaths, ndjsonLogPath } = terminalizeRun(
      cwd,
      cwd,
      { runSlug: 'malformed-session-log' },
    );
    writeFileSync(ndjsonLogPath, '{"type":"workflow_start"}\nnot-json\n');

    const finalization = await reconcileWorkflowTerminalPublication({
      databasePath: runPaths.databaseAbs,
      expectedRunId: runPaths.slug,
    });
    expect(finalization.issues).toEqual([
      expect.objectContaining({
        name: 'RunProjectionError',
        stage: 'session',
      }),
    ]);
    const root = openRunStorage({ databasePath: runPaths.databaseAbs });
    expect(root.readTerminalPublication()?.stages).toEqual([
      'session',
      'trace',
    ]);
    root.close();
    expect(readFileSync(ndjsonLogPath, 'utf-8'))
      .toContain('not-json');
  });

  it('open失敗をrejectせずtyped publication issueとして返す', async () => {
    const cwd = createRoot();
    const finalization = await reconcileWorkflowTerminalPublication({
      databasePath: join(cwd, 'missing.sqlite'),
      expectedRunId: 'missing-run',
    });

    expect(finalization.issues).toEqual([
      expect.objectContaining({
        name: 'RunProjectionError',
        stage: 'publication',
      }),
    ]);
  });

  it('公開payload生成経路は直接呼び出してもdeep-frozen snapshotを返す', () => {
    const cwd = createRoot();
    const sessionLog = createSessionLog(
      'direct snapshot task',
      cwd,
      'direct-snapshot-workflow',
    );
    sessionLog.history.push({
      step: 'implement',
      persona: 'coder',
      instruction: 'implement',
      status: 'done',
      timestamp: '2026-07-27T09:00:00.000Z',
      content: 'before',
      stack: [{
        workflow: 'direct-snapshot-workflow',
        workflow_ref: 'project:sha256:direct-snapshot-workflow',
        step: 'implement',
        kind: 'agent',
        occurrence: 1,
      }],
    });

    const payload = createWorkflowTerminalPayloadFactory({
      runSlug: 'direct-snapshot-run',
      projectCwd: cwd,
      task: 'direct snapshot task',
      workflowName: 'direct-snapshot-workflow',
      sessionLog,
      sessionId: 'snapshot',
      ndjsonLogPath: join(cwd, 'snapshot.jsonl'),
      traceReportMode: 'redacted',
      metaSeed: {
        backend: 'sqlite',
        startedAt: sessionLog.startTime,
        resumeSource: null,
      },
    }).create({
      status: 'completed',
      iterations: 1,
      lastStepContent: 'done',
      lastStepName: 'implement',
      endTime: '2026-07-27T10:00:00.000Z',
    });

    sessionLog.history[0]!.content = 'after';

    expect(payload.sessionLog.history[0]!.content).toBe('before');
    expect(Object.isFrozen(payload.sessionLog.history[0])).toBe(true);
  });

  it('terminal payloadを生成時点のdeep-frozen JSON snapshotとして確定する', () => {
    const cwd = createRoot();
    const sessionLog = createSessionLog(
      'snapshot task',
      cwd,
      'snapshot-workflow',
    );
    sessionLog.history.push({
      step: 'implement',
      persona: 'coder',
      instruction: 'implement',
      status: 'done',
      timestamp: '2026-07-27T09:00:00.000Z',
      content: 'before',
      stack: [{
        workflow: 'snapshot-workflow',
        workflow_ref: 'project:sha256:snapshot-workflow',
        step: 'implement',
        kind: 'agent',
        occurrence: 1,
      }],
    });
    const traceQueries = ['before-query'];
    const traceDiscovery = {
      serviceName: 'takt' as const,
      runId: 'snapshot-run',
      workflowName: 'snapshot-workflow',
      queries: traceQueries,
    };
    const payload = createWorkflowTerminalPayloadFactory({
      runSlug: 'snapshot-run',
      projectCwd: cwd,
      task: 'snapshot task',
      workflowName: 'snapshot-workflow',
      sessionLog,
      sessionId: 'snapshot',
      ndjsonLogPath: join(cwd, 'snapshot.jsonl'),
      traceReportMode: 'redacted',
      metaSeed: {
        backend: 'sqlite',
        startedAt: sessionLog.startTime,
        resumeSource: null,
      },
      traceDiscovery,
    }).create({
      status: 'completed',
      iterations: 1,
      lastStepContent: 'done',
      lastStepName: 'implement',
      endTime: '2026-07-27T10:00:00.000Z',
    });

    sessionLog.history[0]!.content = 'after';
    sessionLog.history[0]!.stack![0]!.step = 'after';
    traceQueries[0] = 'after-query';

    expect(payload.sessionLog.history[0]).toMatchObject({
      content: 'before',
      stack: [expect.objectContaining({ step: 'implement' })],
    });
    expect(payload.traceDiscovery?.queries).toEqual(['before-query']);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.sessionLog)).toBe(true);
    expect(Object.isFrozen(payload.sessionLog.history)).toBe(true);
    expect(Object.isFrozen(payload.sessionLog.history[0])).toBe(true);
    expect(Object.isFrozen(payload.sessionLog.history[0]!.stack)).toBe(true);
    expect(Object.isFrozen(payload.traceDiscovery?.queries)).toBe(true);
  });

  it('SQLite deserialize結果もcanonical deep-frozen snapshotにする', () => {
    const cwd = createRoot();
    const sessionLog = createSessionLog(
      'deserialize task',
      cwd,
      'deserialize-workflow',
    );
    const payload = createWorkflowTerminalPayloadFactory({
      runSlug: 'deserialize-run',
      projectCwd: cwd,
      task: 'deserialize task',
      workflowName: 'deserialize-workflow',
      sessionLog,
      sessionId: 'deserialize',
      ndjsonLogPath: join(cwd, 'deserialize.jsonl'),
      traceReportMode: 'redacted',
      metaSeed: {
        backend: 'sqlite',
        startedAt: sessionLog.startTime,
        resumeSource: null,
      },
    }).create({
      status: 'completed',
      iterations: 1,
      lastStepContent: 'done',
      lastStepName: 'implement',
      endTime: '2026-07-27T10:00:00.000Z',
    });

    const deserialized = deserializeWorkflowTerminalPublication(
      serializeWorkflowTerminalPublication(payload),
    );

    expect(Object.isFrozen(deserialized)).toBe(true);
    expect(Object.isFrozen(deserialized.sessionLog)).toBe(true);
    expect(Object.isFrozen(deserialized.sessionLog.history)).toBe(true);
  });

  it('SQLite outboxはmeta/session/traceだけを投影してpublishedにする', async () => {
    const cwd = createRoot();
    const { runPaths, ndjsonLogPath, eventId } = terminalizeRun(cwd, cwd, {
    });
    const before = openRunStorage({
      databasePath: runPaths.databaseAbs,
    });
    expect(before.readTerminalPublication()).toMatchObject({
      eventId,
      stages: ['meta', 'session', 'trace'],
    });
    before.close();

    const finalization = await reconcileWorkflowTerminalPublication({
      databasePath: runPaths.databaseAbs,
      expectedRunId: runPaths.slug,
    });
    expect(finalization.issues).toEqual([]);
    const completed = openRunStorage({
      databasePath: runPaths.databaseAbs,
    });
    expect(completed.readTerminalPublication()).toMatchObject({
      eventId,
      stages: [],
      publishedAt: expect.any(Number),
    });
    completed.close();
    expect(takeSessionState(cwd)).toMatchObject({
      status: 'success',
      timestamp: '2026-07-27T10:00:00.000Z',
    });
    const records = readFileSync(ndjsonLogPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(records.filter(({ type }) => type === 'workflow_complete'))
      .toHaveLength(1);
    expect(readFileSync(join(runPaths.runRootAbs, 'trace.md'), 'utf-8'))
      .toContain('terminal-workflow');
  });

  it('古いrunのrecoveryが新しいproject session stateを巻き戻さない', async () => {
    const cwd = createRoot();
    const newer = terminalizeRun(cwd, cwd, {
      runSlug: 'newer-run',
      endTime: '2026-07-27T11:00:00.000Z',
    });
    const older = terminalizeRun(cwd, cwd, {
      runSlug: 'older-run',
      endTime: '2026-07-27T10:00:00.000Z',
    });

    await reconcileWorkflowTerminalPublication({
      databasePath: newer.runPaths.databaseAbs,
      expectedRunId: newer.runPaths.slug,
    });
    await reconcileWorkflowTerminalPublication({
      databasePath: older.runPaths.databaseAbs,
      expectedRunId: older.runPaths.slug,
    });

    expect(takeSessionState(cwd)).toMatchObject({
      status: 'success',
      timestamp: '2026-07-27T11:00:00.000Z',
    });
  });

  it('saveSessionState失敗ではsession stageをACKせずpublishedにしない', async () => {
    const cwd = createRoot();
    const blockedProjectPath = join(cwd, 'blocked-project');
    writeFileSync(blockedProjectPath, 'not a directory');
    const { runPaths } = terminalizeRun(cwd, blockedProjectPath, {
    });

    const finalization = await reconcileWorkflowTerminalPublication({
      databasePath: runPaths.databaseAbs,
      expectedRunId: runPaths.slug,
    });
    expect(finalization.issues).toEqual([
      expect.objectContaining({
        name: 'RunProjectionError',
        stage: 'session',
      }),
    ]);

    const reopened = openRunStorage({
      databasePath: runPaths.databaseAbs,
    });
    const failedPublication = reopened.readTerminalPublication();
    expect(failedPublication).toMatchObject({
      stages: ['session', 'trace'],
    });
    expect(failedPublication).not.toHaveProperty('publishedAt');
    reopened.close();

    rmSync(blockedProjectPath);
    mkdirSync(blockedProjectPath);
    const resumed = await reconcileWorkflowTerminalPublication({
      databasePath: runPaths.databaseAbs,
      expectedRunId: runPaths.slug,
    });
    expect(resumed.issues).toEqual([]);
    const published = openRunStorage({
      databasePath: runPaths.databaseAbs,
    });
    expect(published.readTerminalPublication()).toMatchObject({
      stages: [],
      publishedAt: expect.any(Number),
    });
    published.close();
  });

  it('meta投影失敗では未ACK stageを保持し、修復後に同じpublicationを再開する', async () => {
    const cwd = createRoot();
    const { runPaths, eventId } = terminalizeRun(cwd, cwd, {});
    const originalMeta = readFileSync(runPaths.metaAbs, 'utf-8');
    writeFileSync(runPaths.metaAbs, '{"status":"corrupt"}');

    const failed = await reconcileWorkflowTerminalPublication({
      databasePath: runPaths.databaseAbs,
      expectedRunId: runPaths.slug,
    });
    expect(failed.issues).toEqual([
      expect.objectContaining({
        name: 'RunProjectionError',
        stage: 'meta',
      }),
    ]);
    const pending = openRunStorage({
      databasePath: runPaths.databaseAbs,
    });
    expect(pending.readTerminalPublication()).toMatchObject({
      eventId,
      stages: ['meta', 'session', 'trace'],
    });
    pending.close();

    writeFileSync(runPaths.metaAbs, originalMeta);
    const resumed = await reconcileWorkflowTerminalPublication({
      databasePath: runPaths.databaseAbs,
      expectedRunId: runPaths.slug,
    });
    expect(resumed.issues).toEqual([]);
    const published = openRunStorage({
      databasePath: runPaths.databaseAbs,
    });
    expect(published.readTerminalPublication()).toMatchObject({
      eventId,
      stages: [],
      publishedAt: expect.any(Number),
    });
    published.close();
  });

  it('trace投影失敗ではmeta/sessionを再実行せず、trace修復後に完了する', async () => {
    const cwd = createRoot();
    const { runPaths, ndjsonLogPath, eventId } = terminalizeRun(cwd, cwd, {});
    const tracePath = join(runPaths.runRootAbs, 'trace.md');
    mkdirSync(tracePath);

    const failed = await reconcileWorkflowTerminalPublication({
      databasePath: runPaths.databaseAbs,
      expectedRunId: runPaths.slug,
    });
    expect(failed.issues).toEqual([
      expect.objectContaining({
        name: 'RunProjectionError',
        stage: 'trace',
      }),
    ]);
    const pending = openRunStorage({
      databasePath: runPaths.databaseAbs,
    });
    expect(pending.readTerminalPublication()).toMatchObject({
      eventId,
      stages: ['trace'],
    });
    pending.close();
    const terminalRecordsBeforeRetry = readFileSync(ndjsonLogPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string })
      .filter(({ type }) => type === 'workflow_complete');
    expect(terminalRecordsBeforeRetry).toHaveLength(1);

    rmSync(tracePath, { recursive: true });
    const resumed = await reconcileWorkflowTerminalPublication({
      databasePath: runPaths.databaseAbs,
      expectedRunId: runPaths.slug,
    });
    expect(resumed.issues).toEqual([]);
    const published = openRunStorage({
      databasePath: runPaths.databaseAbs,
    });
    expect(published.readTerminalPublication()).toMatchObject({
      eventId,
      stages: [],
      publishedAt: expect.any(Number),
    });
    published.close();
    expect(readFileSync(ndjsonLogPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string })
      .filter(({ type }) => type === 'workflow_complete'))
      .toHaveLength(1);
  });
});
