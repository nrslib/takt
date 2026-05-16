import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';

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
        rules: [{ condition: 'done', next: 'COMPLETE' }],
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
        rules: [{ condition: 'done', next: 'COMPLETE' }],
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
          { condition: 'done', next: 'COMPLETE' },
          { condition: 'fix', next: 'implement' },
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
});
