import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { FindingDatabase } from '../infra/finding-storage/database.js';
import { createTestFindingLedgerStore } from './helpers/finding-storage.js';

const terminalMocks = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue({ id: 'tmux-session', name: 'takt-claude-terminal' }),
  pasteText: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  readBaseline: vi.fn().mockResolvedValue({ byteOffset: 0, lineNumberOffset: 0 }),
  findSession: vi.fn().mockResolvedValue({ sessionId: 'claude-session-1' }),
  waitForAssistantResponse: vi.fn().mockResolvedValue({
    sessionId: 'claude-session-1',
    assistantText: 'done',
    events: [],
  }),
}));

vi.mock('../infra/claude/cli-capability.js', () => ({
  assertClaudeSkillsDisableSupported: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../infra/claude-terminal/tmux-backend.js', () => ({
  TmuxTerminalBackend: vi.fn().mockImplementation(() => ({
    start: terminalMocks.start,
    pasteText: terminalMocks.pasteText,
    stop: terminalMocks.stop,
  })),
}));

vi.mock('../infra/claude-terminal/transcript-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/claude-terminal/transcript-reader.js')>();
  return {
    ...actual,
    ProjectClaudeTranscriptReader: vi.fn().mockImplementation(() => ({
      readBaseline: terminalMocks.readBaseline,
      findSession: terminalMocks.findSession,
      waitForAssistantResponse: terminalMocks.waitForAssistantResponse,
    })),
  };
});

function makeConfig(): WorkflowConfig {
  return {
    name: 'claude-terminal-workflow',
    maxSteps: 3,
    initialStep: 'implement',
    steps: [
      {
        name: 'implement',
        personaDisplayName: 'implement',
        instruction: 'Implement {task}',
        provider: 'claude-terminal',
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
      },
    ],
  };
}

function makeReportConfig(): WorkflowConfig {
  return {
    name: 'claude-terminal-workflow-report',
    maxSteps: 3,
    initialStep: 'implement',
    steps: [
      {
        name: 'implement',
        personaDisplayName: 'implement',
        instruction: 'Implement {task}',
        provider: 'claude-terminal',
        outputContracts: [{ name: 'report.md', format: '# Report' }],
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
      },
    ],
  };
}

function makeMultiRuleConfig(): WorkflowConfig {
  return {
    name: 'claude-terminal-workflow-phase3',
    maxSteps: 3,
    initialStep: 'implement',
    steps: [
      {
        name: 'implement',
        personaDisplayName: 'implement',
        instruction: 'Implement {task}',
        provider: 'claude-terminal',
        rules: [
          normalizeRule({ condition: 'done', next: 'COMPLETE' }),
          normalizeRule({ condition: 'fix', next: 'implement' }),
        ],
      },
    ],
  };
}

describe('executeWorkflow claude-terminal integration', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let originalTaktConfigDir: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    terminalMocks.start.mockResolvedValue({ id: 'tmux-session', name: 'takt-claude-terminal' });
    terminalMocks.pasteText.mockResolvedValue(undefined);
    terminalMocks.stop.mockResolvedValue(undefined);
    terminalMocks.readBaseline.mockResolvedValue({ byteOffset: 0, lineNumberOffset: 0 });
    terminalMocks.findSession.mockResolvedValue({ sessionId: 'claude-session-1' });
    terminalMocks.waitForAssistantResponse.mockResolvedValue({
      sessionId: 'claude-session-1',
      assistantText: 'done',
      events: [],
    });
    projectDir = await mkdtemp(join(tmpdir(), 'takt-claude-terminal-workflow-'));
    globalConfigDir = await mkdtemp(join(tmpdir(), 'takt-claude-terminal-global-'));
    originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
  });

  afterEach(async () => {
    if (originalTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(globalConfigDir, { recursive: true, force: true });
  });

  it('Given workflow root deny ask handler, When claude-terminal runs through executeWorkflow, Then terminal startup is not blocked', async () => {
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');

    const result = await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
    });

    expect(result.success).toBe(true);
    expect(terminalMocks.start).toHaveBeenCalledOnce();
    expect(terminalMocks.pasteText).toHaveBeenCalledOnce();
    expect(terminalMocks.waitForAssistantResponse).toHaveBeenCalledOnce();
    expect(terminalMocks.start).toHaveBeenCalledWith(expect.objectContaining({
      cwd: projectDir,
      backend: 'tmux',
    }));
  });

  it('Given global claude sandbox option, When claude-terminal runs, Then sandbox option does not abort the workflow', async () => {
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');

    const result = await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      providerOptions: {
        claude: {
          sandbox: {
            allowUnsandboxedCommands: true,
          },
        },
      },
    });

    expect(result.success).toBe(true);
    expect(terminalMocks.start).toHaveBeenCalledOnce();
  });

  it('Given claude-terminal step with outputContracts, When report phase runs, Then internal maxTurns does not fail the provider', async () => {
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');
    terminalMocks.waitForAssistantResponse
      .mockResolvedValueOnce({
        sessionId: 'claude-session-1',
        assistantText: 'done',
        events: [],
      })
      .mockResolvedValueOnce({
        sessionId: 'claude-session-1',
        assistantText: '# report',
        events: [],
      });

    const result = await executeWorkflow(makeReportConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
    });

    expect(result.success).toBe(true);
    expect(terminalMocks.start).toHaveBeenCalledTimes(2);
    expect(terminalMocks.waitForAssistantResponse).toHaveBeenCalledTimes(2);
  });

  it('Given claude-terminal step with multiple rules, When phase 3 judgment runs, Then internal maxTurns does not fail the provider', async () => {
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');
    terminalMocks.waitForAssistantResponse
      .mockResolvedValueOnce({
        sessionId: 'claude-session-1',
        assistantText: 'work complete',
        events: [],
      })
      .mockResolvedValueOnce({
        sessionId: 'claude-session-1',
        assistantText: '{"step":1,"reason":"done"}',
        events: [],
      });

    const result = await executeWorkflow(makeMultiRuleConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
    });

    expect(result.success).toBe(true);
    expect(terminalMocks.start).toHaveBeenCalledTimes(2);
    expect(terminalMocks.waitForAssistantResponse).toHaveBeenCalledTimes(2);
  });

  it('bootstrap失敗後も解決済みoperation lineageを次のdistinct resumeへ引き継ぐ', async () => {
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');
    const sourceRunSlug = '20260801-bootstrap-source';
    const failedRunSlug = '20260801-bootstrap-failed';
    const resumedRunSlug = '20260801-bootstrap-resumed';

    await executeWorkflow(makeConfig(), 'source task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      reportDirName: sourceRunSlug,
    });
    const sourceMetaPath = join(projectDir, '.takt', 'runs', sourceRunSlug, 'meta.json');
    const sourceMeta = JSON.parse(await readFile(sourceMetaPath, 'utf-8')) as {
      status: string;
      operation_journal_run_slug?: string;
    };
    sourceMeta.status = 'failed';
    await writeFile(sourceMetaPath, JSON.stringify(sourceMeta), 'utf-8');
    createTestFindingLedgerStore({
      projectCwd: projectDir,
      runId: sourceRunSlug,
      reportDir: join(projectDir, '.takt', 'runs', sourceRunSlug, 'reports'),
      workflowName: makeConfig().name,
    });

    await expect(executeWorkflow(makeConfig(), 'failed target task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      reportDirName: failedRunSlug,
      resumeSource: { sourceRunSlug, resumeMode: 'requeue' },
      taskSpec: {
        runSlug: failedRunSlug,
        sourceTaskDir: join(projectDir, 'missing-task-source'),
        attachmentManifest: [{
          relativePath: 'attachments/missing.png',
          kind: 'file',
          contentSha256: 'a'.repeat(64),
        }],
        taskPrompt: 'missing task prompt',
        orderContent: 'missing task',
        stagedOrderContent: 'missing task',
      },
    })).rejects.toThrow();
    const failedMeta = JSON.parse(await readFile(
      join(projectDir, '.takt', 'runs', failedRunSlug, 'meta.json'),
      'utf-8',
    )) as {
      status: string;
      source_run_slug?: string;
      operation_journal_run_slug?: string;
      operation_claim_token?: string;
    };
    expect(failedMeta).toMatchObject({
      status: 'failed',
      source_run_slug: sourceRunSlug,
      operation_journal_run_slug: sourceMeta.operation_journal_run_slug,
      operation_claim_token: expect.any(String),
    });
    FindingDatabase.openTarget({
      databasePath: join(
        projectDir,
        '.takt',
        'runs',
        failedRunSlug,
        'finding-contract.sqlite',
      ),
      runId: failedRunSlug,
    }).close();

    terminalMocks.waitForAssistantResponse
      .mockResolvedValueOnce({
        sessionId: 'claude-session-1',
        assistantText: 'work complete',
        events: [],
      })
      .mockResolvedValueOnce({
        sessionId: 'claude-session-1',
        assistantText: '{"step":1,"reason":"done"}',
        events: [],
      });
    const resumed = await executeWorkflow(makeMultiRuleConfig(), 'resumed target task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      reportDirName: resumedRunSlug,
      resumeSource: { sourceRunSlug: failedRunSlug, resumeMode: 'requeue' },
    });
    expect(resumed.success).toBe(true);
    const resumedMeta = JSON.parse(await readFile(
      join(projectDir, '.takt', 'runs', resumedRunSlug, 'meta.json'),
      'utf-8',
    )) as { workflow: string };
    expect(resumedMeta.workflow).toBe('claude-terminal-workflow-phase3');
  });

  it('source runのfinding DBが欠落したrequeueは空台帳へ縮退せず失敗する', async () => {
    const { executeWorkflow } = await import('../features/tasks/execute/workflowExecution.js');
    const targetRunSlug = '20260801-missing-source-resumed';

    await expect(executeWorkflow(makeConfig(), 'resumed task', projectDir, {
      projectCwd: projectDir,
      provider: 'claude-terminal',
      reportDirName: targetRunSlug,
      resumeSource: {
        sourceRunSlug: '20260801-missing-source',
        resumeMode: 'requeue',
      },
    })).rejects.toThrow(/has no finding contract database/);
  });

});
