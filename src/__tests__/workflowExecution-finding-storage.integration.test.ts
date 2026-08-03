import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { readRunMeta } from '../core/workflow/run/run-meta.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

const terminal = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue({
    id: 'tmux-session',
    name: 'takt-sqlite-finding-integration',
  }),
  pasteText: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  readBaseline: vi.fn().mockResolvedValue({
    byteOffset: 0,
    lineNumberOffset: 0,
  }),
  findSession: vi.fn().mockResolvedValue({ sessionId: 'claude-session-1' }),
  waitForAssistantResponse: vi.fn().mockResolvedValue({
    sessionId: 'claude-session-1',
    assistantText: 'done',
    events: [],
  }),
}));

vi.mock('../infra/claude/cli-capability.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../infra/claude/cli-capability.js')
  >()),
  assertClaudeSkillsDisableSupported: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../infra/claude-terminal/tmux-backend.js', () => ({
  TmuxTerminalBackend: vi.fn().mockImplementation(() => ({
    start: terminal.start,
    pasteText: terminal.pasteText,
    stop: terminal.stop,
  })),
}));

vi.mock('../infra/claude-terminal/transcript-reader.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../infra/claude-terminal/transcript-reader.js')
  >();
  return {
    ...actual,
    ProjectClaudeTranscriptReader: vi.fn().mockImplementation(() => ({
      readBaseline: terminal.readBaseline,
      findSession: terminal.findSession,
      waitForAssistantResponse: terminal.waitForAssistantResponse,
    })),
  };
});

function workflow(
  withFindingContract: boolean,
  name = withFindingContract ? 'root-finding' : 'without-finding',
): WorkflowConfig {
  return {
    name,
    maxSteps: 3,
    initialStep: 'implement',
    steps: [{
      name: 'implement',
      personaDisplayName: 'implement',
      instruction: 'Implement {task}',
      provider: 'claude-terminal',
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
    }],
    ...(withFindingContract
      ? {
          findingContract: {
            manager: {
              persona: 'findings-manager',
              instruction: 'Manage findings',
              outputContract: 'findings-manager',
            },
          },
        }
      : {}),
  };
}

function readMeta(projectDir: string, runSlug: string) {
  return readRunMeta(buildRunPaths(projectDir, runSlug).metaAbs);
}

describe('SQLite Finding store / file run lifecycle integration', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let originalTaktConfigDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    terminal.waitForAssistantResponse.mockResolvedValue({
      sessionId: 'claude-session-1',
      assistantText: 'done',
      events: [],
    });
    projectDir = mkdtempSync(join(tmpdir(), 'takt-sqlite-finding-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-sqlite-global-'));
    originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
  });

  afterEach(() => {
    if (originalTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    }
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
  });

  it('Finding Contract未使用runは実engineでもSQLiteを作らない', async () => {
    const runSlug = 'without-finding-contract';
    const runPaths = buildRunPaths(projectDir, runSlug);
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    const result = await executeWorkflow(
      workflow(false),
      'task without findings',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        reportDirName: runSlug,
      },
    );

    expect(result.success).toBe(true);
    expect(existsSync(runPaths.findingContractDatabaseAbs)).toBe(false);
    expect(readMeta(projectDir, runSlug)).toMatchObject({
      status: 'completed',
    });
  });

  it('root Finding Contractの初アクセスで実engineがSQLiteをlazy createする', async () => {
    const runSlug = 'root-finding-contract';
    const runPaths = buildRunPaths(projectDir, runSlug);
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    const result = await executeWorkflow(
      workflow(true),
      'task with root findings',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        reportDirName: runSlug,
      },
    );

    expect(result.success).toBe(true);
    expect(existsSync(runPaths.findingContractDatabaseAbs)).toBe(true);
    expect(readMeta(projectDir, runSlug)).toMatchObject({
      status: 'completed',
    });
    const sqlite = new DatabaseSync(runPaths.findingContractDatabaseAbs, {
      readOnly: true,
    });
    expect(sqlite.prepare(`
      SELECT authority_key AS authorityKey, workflow_name AS workflowName
      FROM finding_authorities
    `).all()).toEqual([{
      authorityKey: 'root',
      workflowName: 'root-finding',
    }]);
    expect(sqlite.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all()).toEqual([
      { name: 'database_identity' },
      { name: 'finding_authorities' },
    ]);
    sqlite.close();
  });

  it('child Finding Contractの初アクセスで実engineがSQLiteをlazy createする', async () => {
    const workflowsDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'parent.yaml'), `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    writeFileSync(join(workflowsDir, 'child.yaml'), `name: child
subworkflow:
  callable: true
finding_contract:
  manager:
    persona: findings-manager
    instruction: Manage findings
    output_contract: findings-manager
initial_step: review
max_steps: 2
steps:
  - name: review
    persona: reviewer
    persona_display_name: reviewer
    provider: claude-terminal
    instruction: Review
    rules:
      - condition: done
        next: COMPLETE
`);
    const { loadWorkflowByIdentifier } = await import(
      '../infra/config/loaders/workflowLoader.js'
    );
    const parent = loadWorkflowByIdentifier('parent', projectDir);
    if (parent === null) {
      throw new Error('Parent workflow was not loaded');
    }
    const runSlug = 'child-finding-contract';
    const runPaths = buildRunPaths(projectDir, runSlug);
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    const result = await executeWorkflow(parent, 'task with child findings', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      reportDirName: runSlug,
    });

    expect(result.success).toBe(true);
    expect(existsSync(runPaths.findingContractDatabaseAbs)).toBe(true);
    const sqlite = new DatabaseSync(runPaths.findingContractDatabaseAbs, {
      readOnly: true,
    });
    const authorities = sqlite.prepare(`
      SELECT authority_key AS authorityKey, workflow_name AS workflowName
      FROM finding_authorities
    `).all() as Array<{ authorityKey: string; workflowName: string }>;
    expect(authorities).toHaveLength(1);
    expect(authorities[0]).toMatchObject({ workflowName: 'child' });
    expect(authorities[0]?.authorityKey).not.toBe('root');
    sqlite.close();
    expect(readMeta(projectDir, runSlug)).toMatchObject({
      status: 'completed',
    });
  });

  it('source SQLite欠落ならtarget storage作成前にfail-fastする', async () => {
    const sourceRunSlug = 'source-with-deleted-sqlite';
    const targetRunSlug = 'target-with-fresh-findings';
    const sourcePaths = buildRunPaths(projectDir, sourceRunSlug);
    const targetPaths = buildRunPaths(projectDir, targetRunSlug);
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );
    terminal.waitForAssistantResponse.mockRejectedValueOnce(
      new Error('source interrupted'),
    );
    const sourceResult = await executeWorkflow(
      workflow(true),
      'source finding task',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        reportDirName: sourceRunSlug,
      },
    );
    expect(sourceResult.success).toBe(false);
    unlinkSync(sourcePaths.findingContractDatabaseAbs);

    const expectedError = `Requeue source run "${sourceRunSlug}" has no finding contract database: ${sourcePaths.findingContractDatabaseAbs}`;
    await expect(executeWorkflow(
      workflow(true),
      'resumed finding task',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        reportDirName: targetRunSlug,
        resumeSource: {
          sourceRunSlug,
          resumeMode: 'requeue',
        },
      },
    )).rejects.toThrow(expectedError);

    expect(existsSync(targetPaths.findingContractDatabaseAbs)).toBe(false);
  });

  it('workflow変更後もsource authorityを新workflow名でseedする', async () => {
    const sourceRunSlug = 'workflow-change-source';
    const targetRunSlug = 'workflow-change-target';
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );
    terminal.waitForAssistantResponse.mockRejectedValueOnce(
      new Error('source interrupted for workflow change'),
    );
    expect((await executeWorkflow(
      workflow(true, 'source-workflow'),
      'source task',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        reportDirName: sourceRunSlug,
      },
    )).success).toBe(false);

    expect((await executeWorkflow(
      workflow(true, 'target-workflow'),
      'target task',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        reportDirName: targetRunSlug,
        resumeSource: {
          sourceRunSlug,
          resumeMode: 'requeue',
        },
      },
    )).success).toBe(true);

    const targetPaths = buildRunPaths(projectDir, targetRunSlug);
    const database = new DatabaseSync(targetPaths.findingContractDatabaseAbs, {
      readOnly: true,
    });
    const row = database.prepare(`
      SELECT workflow_name AS workflowName, revision, ledger_json AS ledgerJson
      FROM finding_authorities WHERE authority_key = 'root'
    `).get() as { workflowName: string; revision: number; ledgerJson: string };
    expect(row.workflowName).toBe('target-workflow');
    expect(row.revision).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(row.ledgerJson)).toMatchObject({
      workflowName: 'target-workflow',
    });
    database.close();
  });

  it('parallel workflow calls use distinct child authority keys', async () => {
    const workflowsDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'parallel-parent.yaml'), `name: parallel-parent
initial_step: fanout
max_steps: 3
steps:
  - name: fanout
    parallel:
      - name: child-a
        kind: workflow_call
        call: parallel-child
        rules:
          - condition: COMPLETE
      - name: child-b
        kind: workflow_call
        call: parallel-child
        rules:
          - condition: COMPLETE
    rules:
      - condition: all("COMPLETE")
        next: COMPLETE
`);
    writeFileSync(join(workflowsDir, 'parallel-child.yaml'), `name: parallel-child
subworkflow:
  callable: true
finding_contract:
  manager:
    persona: findings-manager
    instruction: Manage findings
    output_contract: findings-manager
initial_step: review
max_steps: 2
steps:
  - name: review
    persona: reviewer
    persona_display_name: reviewer
    provider: claude-terminal
    instruction: Review
    rules:
      - condition: done
        next: COMPLETE
`);
    const { loadWorkflowByIdentifier } = await import(
      '../infra/config/loaders/workflowLoader.js'
    );
    const parent = loadWorkflowByIdentifier('parallel-parent', projectDir);
    if (parent === null) {
      throw new Error('Parallel parent workflow was not loaded');
    }
    const runSlug = 'parallel-child-authorities';
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    const result = await executeWorkflow(parent, 'parallel task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      reportDirName: runSlug,
    });

    expect(result.success).toBe(true);
    const runPaths = buildRunPaths(projectDir, runSlug);
    const database = new DatabaseSync(runPaths.findingContractDatabaseAbs, {
      readOnly: true,
    });
    const authorities = database.prepare(`
      SELECT authority_key AS authorityKey, workflow_name AS workflowName
      FROM finding_authorities ORDER BY authority_key
    `).all() as Array<{ authorityKey: string; workflowName: string }>;
    expect(authorities).toHaveLength(2);
    expect(authorities.map((authority) => authority.workflowName)).toEqual([
      'parallel-child',
      'parallel-child',
    ]);
    expect(authorities[0]?.authorityKey).not.toBe(authorities[1]?.authorityKey);
    expect(authorities.every((authority) => authority.authorityKey !== 'root'))
      .toBe(true);
    database.close();
  });

  it('provider abort後にSQLite Finding resourceをcloseしfileへfailedを確定する', async () => {
    const runSlug = 'failed-finding-contract';
    const runPaths = buildRunPaths(projectDir, runSlug);
    terminal.waitForAssistantResponse.mockRejectedValueOnce(
      new Error('injected provider failure'),
    );
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    const result = await executeWorkflow(
      workflow(true),
      'failing finding task',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        reportDirName: runSlug,
      },
    );

    expect(result).toMatchObject({
      success: false,
      reason: 'injected provider failure',
    });
    expect(existsSync(runPaths.findingContractDatabaseAbs)).toBe(true);
    expect(readMeta(projectDir, runSlug)).toMatchObject({
      status: 'failed',
      reason: 'Step "implement" failed: injected provider failure',
    });
    const sqlite = new DatabaseSync(runPaths.findingContractDatabaseAbs, {
      readOnly: true,
    });
    expect(sqlite.prepare(`
      SELECT count(*) AS count FROM finding_authorities
    `).get()).toEqual({ count: 1 });
    sqlite.close();
  });

  it('external abortでもFinding DBにterminal stateを入れずfileへ確定する', async () => {
    const runSlug = 'aborted-finding-contract';
    const runPaths = buildRunPaths(projectDir, runSlug);
    const abortController = new AbortController();
    abortController.abort('integration abort');
    const { executeWorkflow } = await import(
      '../features/tasks/execute/workflowExecution.js'
    );

    const result = await executeWorkflow(
      workflow(true),
      'aborted finding task',
      projectDir,
      {
        projectCwd: projectDir,
        provider: 'claude-terminal',
        reportDirName: runSlug,
        abortSignal: abortController.signal,
      },
    );

    expect(result.success).toBe(false);
    expect(readMeta(projectDir, runSlug)).toMatchObject({
      status: 'aborted',
    });
    const database = new DatabaseSync(runPaths.findingContractDatabaseAbs, {
      readOnly: true,
    });
    expect(database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all()).toEqual([
      { name: 'database_identity' },
      { name: 'finding_authorities' },
    ]);
    database.close();
  });
});
