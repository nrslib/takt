import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationStrategy, SessionContext } from '../features/interactive/conversationLoop.js';
import type { WorkflowContext } from '../features/interactive/interactive-summary.js';

const {
  mockResolveWorkflowConfigValues,
  mockInitializeSession,
  mockDisplayAndClearSessionState,
  mockRunConversationLoop,
  mockLoadTemplate,
  mockSelectOption,
} = vi.hoisted(() => ({
  mockResolveWorkflowConfigValues: vi.fn(),
  mockInitializeSession: vi.fn(),
  mockDisplayAndClearSessionState: vi.fn(),
  mockRunConversationLoop: vi.fn(),
  mockLoadTemplate: vi.fn(),
  mockSelectOption: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveWorkflowConfigValues: mockResolveWorkflowConfigValues,
}));

vi.mock('../features/interactive/sessionInitialization.js', () => ({
  initializeSession: mockInitializeSession,
}));

vi.mock('../features/interactive/conversationLoop.js', () => ({
  displayAndClearSessionState: mockDisplayAndClearSessionState,
  runConversationLoop: mockRunConversationLoop,
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: mockLoadTemplate,
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabelObject: vi.fn(() => ({
    intro: 'Direct instruct intro',
    proposed: 'Proposed:',
    actionPrompt: 'Action:',
    actions: {
      execute: 'Execute',
      saveTask: 'Save task',
      continue: 'Continue',
    },
  })),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: mockSelectOption,
}));

vi.mock('../shared/ui/index.js', () => ({
  blankLine: vi.fn(),
  info: vi.fn(),
}));

import { runDirectInstructMode } from '../features/tasks/resume/directInstructMode.js';

const workflowContext: WorkflowContext = {
  name: 'default',
  description: '',
  workflowStructure: '1. fix',
  stepPreviews: [],
};

const runSessionContext = {
  task: 'Previous direct task',
  workflow: 'default',
  status: 'aborted',
  stepLogs: [
    { step: 'fix', persona: 'coder', status: 'failed', content: 'failed log' },
  ],
  reports: [
    { filename: 'fix.md', content: 'failed report' },
  ],
};

function buildOptions(previousOrderContent: string | null) {
  return {
    cwd: '/project',
    runSlug: '20260524-direct-failed',
    taskContent: 'Meta task instruction',
    workflowContext,
    runSessionContext,
    previousOrderContent,
  };
}

describe('runDirectInstructMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveWorkflowConfigValues.mockReturnValue({ language: 'en', provider: 'mock' });
    mockInitializeSession.mockReturnValue({ sessionId: 'session-1' });
    mockLoadTemplate.mockReturnValue('direct instruct system prompt');
    mockRunConversationLoop.mockResolvedValue({ action: 'execute', task: 'Add regression coverage' });
  });

  it('Given provider is not configured, When direct instruct starts, Then it fails before opening a session', async () => {
    mockResolveWorkflowConfigValues.mockReturnValue({ language: 'en', provider: undefined });

    await expect(runDirectInstructMode(buildOptions(null))).rejects.toThrow('Provider is not configured.');
    expect(mockInitializeSession).not.toHaveBeenCalled();
  });

  it('Given order.md content exists, When direct instruct starts, Then the dedicated prompt receives order provenance', async () => {
    await runDirectInstructMode(buildOptions('# Previous Order\nDo the thing'));

    expect(mockLoadTemplate).toHaveBeenCalledWith(
      'score_direct_instruct_system_prompt',
      'en',
      expect.objectContaining({
        runSlug: '20260524-direct-failed',
        taskContent: 'Meta task instruction',
        runTask: 'Previous direct task',
        runWorkflow: 'default',
        runStatus: 'aborted',
        hasOrderContent: true,
        orderContent: '# Previous Order\nDo the thing',
      }),
    );
  });

  it('Given order.md is absent, When direct instruct starts, Then meta.task is not exposed as previous order', async () => {
    await runDirectInstructMode(buildOptions(null));

    expect(mockLoadTemplate).toHaveBeenCalledWith(
      'score_direct_instruct_system_prompt',
      'en',
      expect.objectContaining({
        taskContent: 'Meta task instruction',
        hasOrderContent: false,
        orderContent: '',
      }),
    );
  });

  it('Given the conversation continues, When direct instruct runs, Then only direct execution actions are offered', async () => {
    mockSelectOption.mockResolvedValueOnce('execute');
    mockRunConversationLoop.mockImplementationOnce(async (
      _cwd: string,
      _ctx: SessionContext,
      strategy: ConversationStrategy,
    ) => {
      const action = await strategy.selectAction?.('Additional direct instructions', 'en');
      return { action, task: 'Additional direct instructions' };
    });

    const result = await runDirectInstructMode(buildOptions('# Previous Order'));

    expect(result).toEqual({ action: 'execute', task: 'Additional direct instructions' });
    expect(mockRunConversationLoop).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ lang: 'en', personaName: 'instruct' }),
      expect.objectContaining({
        systemPrompt: expect.any(String),
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
        previousOrderContent: '# Previous Order',
      }),
      workflowContext,
      undefined,
    );
    const options = mockSelectOption.mock.calls[0]?.[1] as Array<{ value: string }>;
    expect(options.map((option) => option.value)).toEqual(['execute', 'continue']);
  });

  it('Given the conversation returns image attachments, When direct instruct completes, Then attachments are preserved', async () => {
    const cleanupAttachments = vi.fn();
    const attachment = {
      placeholder: '[Image #1]',
      tempPath: '/tmp/takt/session-1/attachments/image-1.png',
      fileName: 'image-1.png',
    };
    mockRunConversationLoop.mockResolvedValueOnce({
      action: 'execute',
      task: 'Use [Image #1]',
      attachments: [attachment],
      cleanupAttachments,
    });

    const result = await runDirectInstructMode(buildOptions('# Previous Order'));

    expect(result).toEqual({
      action: 'execute',
      task: 'Use [Image #1]',
      attachments: [attachment],
      cleanupAttachments: expect.any(Function),
    });
    result.cleanupAttachments?.();
    expect(cleanupAttachments).toHaveBeenCalledTimes(1);
  });

  it('Given the conversation cancels with image attachments, When direct instruct returns, Then attachments are preserved', async () => {
    const cleanupAttachments = vi.fn();
    const attachment = {
      placeholder: '[Image #1]',
      tempPath: '/tmp/takt/session-1/attachments/image-1.png',
      fileName: 'image-1.png',
    };
    mockRunConversationLoop.mockResolvedValueOnce({
      action: 'cancel',
      task: 'ignored',
      attachments: [attachment],
      cleanupAttachments,
    });

    const result = await runDirectInstructMode(buildOptions('# Previous Order'));

    expect(result).toEqual({
      action: 'cancel',
      task: '',
      attachments: [attachment],
      cleanupAttachments: expect.any(Function),
    });
    result.cleanupAttachments?.();
    expect(cleanupAttachments).toHaveBeenCalledTimes(1);
  });

  it('Given the user cancels, When direct instruct returns, Then no instruction text is propagated', async () => {
    mockRunConversationLoop.mockResolvedValueOnce({ action: 'cancel', task: 'ignored' });

    const result = await runDirectInstructMode(buildOptions('# Previous Order'));

    expect(result).toEqual({ action: 'cancel', task: '' });
  });
});
