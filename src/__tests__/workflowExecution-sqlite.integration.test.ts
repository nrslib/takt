import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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

const sqliteLifecycle = vi.hoisted(() => ({
  closedDatabases: [] as string[],
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

vi.mock('../infra/run-storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../infra/run-storage/index.js')
  >();
  return {
    ...actual,
    createRunStorage: (
      options: Parameters<typeof actual.createRunStorage>[0],
    ) => {
      const root = actual.createRunStorage(options);
      return new Proxy(root, {
        get(target, property) {
          if (property === 'close') {
            return () => {
              sqliteLifecycle.closedDatabases.push(options.databasePath);
              return target.close();
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

function workflow(withFindingContract: boolean): WorkflowConfig {
  return {
    name: withFindingContract ? 'root-finding' : 'without-finding',
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
            ledgerPath: '.takt/findings/root.json',
            rawFindingsPath: '.takt/findings/root-raw',
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

function configureSqliteFindingStorage(projectDir: string): void {
  const configDir = join(projectDir, '.takt');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), [
    'run_storage:',
    '  backend: sqlite',
    '',
  ].join('\n'));
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
    sqliteLifecycle.closedDatabases.length = 0;
    terminal.waitForAssistantResponse.mockResolvedValue({
      sessionId: 'claude-session-1',
      assistantText: 'done',
      events: [],
    });
    projectDir = mkdtempSync(join(tmpdir(), 'takt-sqlite-finding-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-sqlite-global-'));
    originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    configureSqliteFindingStorage(projectDir);
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
    expect(existsSync(runPaths.databaseAbs)).toBe(false);
    expect(readMeta(projectDir, runSlug)).toMatchObject({
      storageBackend: 'file',
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
    expect(existsSync(runPaths.databaseAbs)).toBe(true);
    expect(readMeta(projectDir, runSlug)).toMatchObject({
      storageBackend: 'file',
      status: 'completed',
    });
    const { openRunStorage } = await import('../infra/run-storage/index.js');
    const sqlite = openRunStorage({ databasePath: runPaths.databaseAbs });
    expect(sqlite.readResumeSnapshot().findingHeads).toHaveLength(1);
    expect(sqlite.readTerminalPublication()).toBeUndefined();
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
  ledger_path: .takt/findings/child.json
  raw_findings_path: .takt/findings/child-raw
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
    expect(existsSync(runPaths.databaseAbs)).toBe(true);
    const { openRunStorage } = await import('../infra/run-storage/index.js');
    const sqlite = openRunStorage({ databasePath: runPaths.databaseAbs });
    const snapshot = sqlite.readResumeSnapshot();
    expect(snapshot.findingHeads).toHaveLength(1);
    expect(snapshot.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'workflow_call',
        findingContractEnabled: 1,
      }),
    ]));
    expect(sqlite.readTerminalPublication()).toBeUndefined();
    sqlite.close();
    expect(readMeta(projectDir, runSlug)).toMatchObject({
      storageBackend: 'file',
      status: 'completed',
    });
  });

  it('source SQLite欠落でも実engineがresumeしFinding 0から開始する', async () => {
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
    unlinkSync(sourcePaths.databaseAbs);

    const targetResult = await executeWorkflow(
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
    );

    expect(targetResult.success).toBe(true);
    expect(existsSync(targetPaths.databaseAbs)).toBe(true);
    const { openRunStorage } = await import('../infra/run-storage/index.js');
    const sqlite = openRunStorage({ databasePath: targetPaths.databaseAbs });
    expect(sqlite.readResumeSnapshot().findingRevisions).toEqual([
      expect.objectContaining({ next_id: 1 }),
    ]);
    sqlite.close();
    expect(readMeta(projectDir, targetRunSlug)).toMatchObject({
      storageBackend: 'file',
      status: 'completed',
      sourceRunSlug,
    });
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
      reason: 'Step "implement" failed: injected provider failure',
    });
    expect(sqliteLifecycle.closedDatabases).toContain(runPaths.databaseAbs);
    expect(readMeta(projectDir, runSlug)).toMatchObject({
      storageBackend: 'file',
      status: 'failed',
      reason: 'Step "implement" failed: injected provider failure',
    });
    const { openRunStorage } = await import('../infra/run-storage/index.js');
    const sqlite = openRunStorage({ databasePath: runPaths.databaseAbs });
    expect(sqlite.readTerminalPublication()).toBeUndefined();
    sqlite.close();
  });
});
