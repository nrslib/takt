import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  mkdtempSync,
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
  FindingStorageResolver,
  ROOT_FINDING_AUTHORITY_KEY,
} from '../infra/finding-storage/index.js';
import { createSessionLog, initNdjsonLog } from '../infra/fs/index.js';

const roots: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-finding-source-ancestry-'));
  roots.push(root);
  return root;
}

function workflow(name: string): WorkflowConfig {
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
    findingContract: {
      manager: {
        persona: 'findings-manager',
        instruction: 'manage',
        outputContract: 'findings-manager',
      },
    },
  };
}

function writeRunMeta(
  cwd: string,
  runSlug: string,
  sourceRunSlug?: string,
): void {
  const paths = buildRunPaths(cwd, runSlug);
  mkdirSync(paths.runRootAbs, { recursive: true });
  writeFileSync(paths.metaAbs, JSON.stringify({
    task: 'task',
    workflow: 'workflow',
    runSlug,
    runRoot: paths.runRootRel,
    reportDirectory: paths.reportsRel,
    contextDirectory: paths.contextRel,
    logsDirectory: paths.logsRel,
    status: 'failed',
    startTime: '2026-08-03T00:00:00.000Z',
    endTime: '2026-08-03T00:00:01.000Z',
    iterations: 0,
    ...(sourceRunSlug === undefined
      ? {}
      : {
          source_run_slug: sourceRunSlug,
          resume_mode: 'requeue',
        }),
  }, null, 2));
}

async function createAuthority(input: {
  readonly cwd: string;
  readonly runSlug: string;
  readonly authorityKey: string;
  readonly workflowName: string;
  readonly updatedAt?: string;
}): Promise<void> {
  const paths = buildRunPaths(input.cwd, input.runSlug);
  const resolver = new FindingStorageResolver({
    databasePath: paths.findingContractDatabaseAbs,
    runId: input.runSlug,
    now: () => '2026-08-03T00:00:00.000Z',
  });
  const store = resolver.resolveAuthority({
    authorityKey: input.authorityKey,
    workflowName: input.workflowName,
    reportDir: paths.reportsAbs,
  });
  if (input.updatedAt !== undefined) {
    const updatedAt = input.updatedAt;
    await store.updateLedger((ledger) => ({
      ledger: { ...ledger, updatedAt },
      result: undefined,
    }));
  }
  resolver.close();
}

function readAuthorityCount(cwd: string, runSlug: string): number {
  const database = new DatabaseSync(
    buildRunPaths(cwd, runSlug).findingContractDatabaseAbs,
    { readOnly: true },
  );
  const row = database.prepare(
    'SELECT count(*) AS count FROM finding_authorities',
  ).get() as { count: number };
  database.close();
  return row.count;
}

function createUnseededDatabase(
  cwd: string,
  runSlug: string,
  seededSourceRunSlug: string,
): void {
  const paths = buildRunPaths(cwd, runSlug);
  const sourcePaths = buildRunPaths(cwd, seededSourceRunSlug);
  const resolver = new FindingStorageResolver({
    databasePath: paths.findingContractDatabaseAbs,
    runId: runSlug,
    source: {
      databasePath: sourcePaths.findingContractDatabaseAbs,
      runId: seededSourceRunSlug,
    },
  });
  expect(() => resolver.resolveAuthority({
    authorityKey: 'authority-not-in-source',
    workflowName: 'child-workflow',
    reportDir: paths.reportsAbs,
  })).toThrow('Finding authority "authority-not-in-source" is missing from the source');
  resolver.close();

  const database = new DatabaseSync(paths.findingContractDatabaseAbs, { readOnly: true });
  expect(database.prepare('SELECT count(*) AS count FROM finding_authorities').get())
    .toEqual({ count: 0 });
  database.close();
}

async function createDatabaseWithIdentity(input: {
  readonly cwd: string;
  readonly runSlug: string;
  readonly databaseInstanceId: string;
  readonly storedRunId: string;
}): Promise<void> {
  await createAuthority({
    cwd: input.cwd,
    runSlug: input.runSlug,
    authorityKey: ROOT_FINDING_AUTHORITY_KEY,
    workflowName: 'source-workflow',
  });
  const database = new DatabaseSync(
    buildRunPaths(input.cwd, input.runSlug).findingContractDatabaseAbs,
  );
  database.prepare(`
    UPDATE database_identity
    SET database_instance_id = ?, run_id = ?
  `).run(input.databaseInstanceId, input.storedRunId);
  database.close();
}

async function bindTarget(input: {
  readonly cwd: string;
  readonly runSlug: string;
  readonly resumeSource: RunResumeSource;
}) {
  const workflowConfig = workflow('target-workflow');
  const lifecycle = createWorkflowRunLifecycle({ cwd: input.cwd }).lifecycle;
  const handle = await lifecycle.beginRun({
    workflowConfig,
    task: 'task',
    requestedRunSlug: input.runSlug,
    resumeSource: input.resumeSource,
  });
  handle.bootstrap.publishRunMeta({
    runPaths: handle.runPaths,
    task: 'task',
    workflowName: workflowConfig.name,
    resumeSource: input.resumeSource,
  });
  const sessionLog = createSessionLog(
    'task',
    input.cwd,
    workflowConfig.name,
    { startTime: handle.bootstrap.startedAt },
  );
  const ndjsonLogPath = initNdjsonLog(
    handle.bootstrap.sessionId,
    'task',
    workflowConfig.name,
    {
      logsDir: handle.runPaths.logsAbs,
      startTime: handle.bootstrap.startedAt,
    },
  );
  const terminalPayloads = createWorkflowTerminalPayloadFactory({
    runSlug: handle.runSlug,
    projectCwd: input.cwd,
    task: 'task',
    workflowName: workflowConfig.name,
    sessionLog,
    sessionId: handle.bootstrap.sessionId,
    ndjsonLogPath,
    traceReportMode: 'redacted',
  });
  const binding = await handle.bindExecution({
    workflowConfig,
    resumeSource: input.resumeSource,
    terminalPayloads,
  });
  return { binding, handle, terminalPayloads, workflowConfig };
}

function resolveRootAuthority(
  target: Awaited<ReturnType<typeof bindTarget>>,
) {
  return target.binding.findingAuthorityResolver.resolve({
    workflowConfig: target.workflowConfig,
    runPaths: target.handle.runPaths,
    runPathNamespace: [],
  });
}

async function finishRun(run: {
  readonly handle: WorkflowRunHandle;
  readonly terminalPayloads: ReturnType<typeof createWorkflowTerminalPayloadFactory>;
}): Promise<void> {
  const endTime = '2026-08-03T00:00:02.000Z';
  const payload = run.terminalPayloads.create({
    status: 'failed',
    iterations: 0,
    reason: 'test complete',
    endTime,
  });
  await run.handle.finish({
    status: 'failed',
    iteration: 0,
    reason: 'test complete',
  }, payload);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Finding storage resume source ancestry', () => {
  it.each([
    {
      name: 'an unseeded database',
      arrange: (cwd: string) => createUnseededDatabase(
        cwd,
        'unseeded-b',
        'seeded-a',
      ),
    },
    {
      name: 'a missing database',
      arrange: (_cwd: string) => undefined,
    },
  ])('imports from the last seeded ancestor through $name', async ({ arrange }) => {
    const cwd = createRoot();
    await createAuthority({
      cwd,
      runSlug: 'seeded-a',
      authorityKey: ROOT_FINDING_AUTHORITY_KEY,
      workflowName: 'source-workflow',
      updatedAt: '2026-08-03T00:00:09.000Z',
    });
    writeRunMeta(cwd, 'unseeded-b', 'seeded-a');
    arrange(cwd);

    const target = await bindTarget({
      cwd,
      runSlug: 'requeue-c',
      resumeSource: { sourceRunSlug: 'unseeded-b', resumeMode: 'requeue' },
    });
    const store = resolveRootAuthority(target);

    expect(store.loadLedger()).toMatchObject({
      workflowName: 'target-workflow',
      updatedAt: '2026-08-03T00:00:09.000Z',
    });
    await finishRun(target);
  });

  it.each([
    {
      name: 'an unseeded database',
      arrange: (cwd: string) => createUnseededDatabase(
        cwd,
        'unseeded-b',
        'seeded-a',
      ),
    },
    {
      name: 'a missing database',
      arrange: (_cwd: string) => undefined,
    },
  ])('starts with an empty ledger when ancestry ends at $name', async ({ arrange }) => {
    const cwd = createRoot();
    await createAuthority({
      cwd,
      runSlug: 'seeded-a',
      authorityKey: ROOT_FINDING_AUTHORITY_KEY,
      workflowName: 'unrelated-workflow',
    });
    writeRunMeta(cwd, 'unseeded-b');
    arrange(cwd);

    const target = await bindTarget({
      cwd,
      runSlug: 'requeue-c',
      resumeSource: { sourceRunSlug: 'unseeded-b', resumeMode: 'requeue' },
    });
    const store = resolveRootAuthority(target);

    expect(store.loadLedger()).toMatchObject({
      workflowName: 'target-workflow',
      findings: [],
      rawFindings: [],
    });
    await finishRun(target);
  });

  it.each([
    {
      name: 'cycle',
      arrange: (cwd: string) => {
        writeRunMeta(cwd, 'unseeded-b', 'unseeded-d');
        writeRunMeta(cwd, 'unseeded-d', 'unseeded-b');
        createUnseededDatabase(cwd, 'unseeded-b', 'seeded-a');
        createUnseededDatabase(cwd, 'unseeded-d', 'seeded-a');
      },
      expected: 'Finding storage source ancestry contains a cycle at "unseeded-b"',
    },
    {
      name: 'missing metadata',
      arrange: (cwd: string) => {
        createUnseededDatabase(cwd, 'unseeded-b', 'seeded-a');
      },
      expected: 'Finding storage source run "unseeded-b" has no readable metadata',
    },
    {
      name: 'malformed metadata',
      arrange: (cwd: string) => {
        createUnseededDatabase(cwd, 'unseeded-b', 'seeded-a');
        writeFileSync(buildRunPaths(cwd, 'unseeded-b').metaAbs, '{');
      },
      expected: 'Finding storage source run "unseeded-b" has no readable metadata',
    },
    {
      name: 'invalid parent slug',
      arrange: (cwd: string) => {
        createUnseededDatabase(cwd, 'unseeded-b', 'seeded-a');
        writeRunMeta(cwd, 'unseeded-b', '../invalid');
      },
      expected: 'Finding storage source run slug "../invalid" is invalid',
    },
  ])('fails fast at $name', async ({ arrange, expected }) => {
    const cwd = createRoot();
    await createAuthority({
      cwd,
      runSlug: 'seeded-a',
      authorityKey: ROOT_FINDING_AUTHORITY_KEY,
      workflowName: 'source-workflow',
    });
    arrange(cwd);

    const target = await bindTarget({
      cwd,
      runSlug: 'requeue-c',
      resumeSource: { sourceRunSlug: 'unseeded-b', resumeMode: 'requeue' },
    });
    expect(() => resolveRootAuthority(target)).toThrow(expected);
    expect(readAuthorityCount(cwd, 'unseeded-b')).toBe(0);
    await finishRun(target);
  });

  it.each([
    {
      name: 'malformed SQLite',
      arrange: async (cwd: string) => {
        const paths = buildRunPaths(cwd, 'invalid-source');
        mkdirSync(paths.runRootAbs, { recursive: true });
        writeFileSync(paths.findingContractDatabaseAbs, 'not sqlite');
      },
      expected: /not a database/,
    },
    {
      name: 'schema mismatch',
      arrange: async (cwd: string) => {
        const paths = buildRunPaths(cwd, 'invalid-source');
        mkdirSync(paths.runRootAbs, { recursive: true });
        const database = new DatabaseSync(paths.findingContractDatabaseAbs);
        database.exec('CREATE TABLE unrelated_table (id TEXT PRIMARY KEY) STRICT');
        database.close();
      },
      expected: /schema tables mismatch/,
    },
    {
      name: 'invalid database identity',
      arrange: async (cwd: string) => createDatabaseWithIdentity({
        cwd,
        runSlug: 'invalid-source',
        databaseInstanceId: '',
        storedRunId: 'invalid-source',
      }),
      expected: /database identity is invalid/,
    },
    {
      name: 'source run ID mismatch',
      arrange: async (cwd: string) => createDatabaseWithIdentity({
        cwd,
        runSlug: 'invalid-source',
        databaseInstanceId: 'database-instance',
        storedRunId: 'different-run',
      }),
      expected: /source run id mismatch/,
    },
    {
      name: 'SQLite read error',
      arrange: async (cwd: string) => {
        const paths = buildRunPaths(cwd, 'invalid-source');
        mkdirSync(paths.findingContractDatabaseAbs, { recursive: true });
      },
      expected: /disk I\/O error/,
    },
  ])('fails fast for $name through production source resolution', async ({
    arrange,
    expected,
  }) => {
    const cwd = createRoot();
    await arrange(cwd);
    const target = await bindTarget({
      cwd,
      runSlug: 'requeue-target',
      resumeSource: { sourceRunSlug: 'invalid-source', resumeMode: 'requeue' },
    });

    expect(() => resolveRootAuthority(target)).toThrow(expected);
    await finishRun(target);
  });

  it('does not traverse a seeded source that lacks only the requested authority', async () => {
    const cwd = createRoot();
    await createAuthority({
      cwd,
      runSlug: 'seeded-a',
      authorityKey: 'child-call-site',
      workflowName: 'child-workflow',
    });
    await createAuthority({
      cwd,
      runSlug: 'seeded-b',
      authorityKey: ROOT_FINDING_AUTHORITY_KEY,
      workflowName: 'source-workflow',
    });
    writeRunMeta(cwd, 'seeded-b', 'seeded-a');
    const target = await bindTarget({
      cwd,
      runSlug: 'requeue-c',
      resumeSource: { sourceRunSlug: 'seeded-b', resumeMode: 'requeue' },
    });

    expect(() => target.binding.findingAuthorityResolver.resolve({
      workflowConfig: workflow('child-workflow'),
      runPaths: target.handle.runPaths,
      runPathNamespace: ['child'],
      workflowCallSiteIdentity: 'child-call-site',
    })).toThrow('Finding authority "child-call-site" is missing from the source');
    await finishRun(target);
  });
});
