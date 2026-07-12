import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockResolveWorkflowConfigValues,
  mockResolveConfigValues,
  mockInitializeSession,
  mockDisplayAndClearSessionState,
  mockRunConversationLoop,
  mockLoadTemplate,
  mockSelectOption,
  mockGetLabel,
  mockGetLabelObject,
} = vi.hoisted(() => ({
  mockResolveWorkflowConfigValues: vi.fn(),
  mockResolveConfigValues: vi.fn(),
  mockInitializeSession: vi.fn(),
  mockDisplayAndClearSessionState: vi.fn(),
  mockRunConversationLoop: vi.fn(),
  mockLoadTemplate: vi.fn(),
  mockSelectOption: vi.fn(),
  mockGetLabel: vi.fn(),
  mockGetLabelObject: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveWorkflowConfigValues: mockResolveWorkflowConfigValues,
  resolveConfigValues: mockResolveConfigValues,
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

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: mockSelectOption,
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: mockGetLabel,
  getLabelObject: mockGetLabelObject,
}));

vi.mock('../shared/ui/index.js', () => ({
  blankLine: vi.fn(),
  info: vi.fn(),
}));

import { runInstructMode } from '../features/tasks/list/instructMode.js';
import { runTaskRetryMode, type RetryContext } from '../features/interactive/retryMode.js';

const instructUi = {
  intro: 'Instruct intro',
  proposed: 'Proposed:',
  actionPrompt: 'Action:',
  actions: {
    execute: 'Execute',
    saveTask: 'Save task',
    continue: 'Continue',
  },
};

function buildRetryContext(): RetryContext {
  return {
    failure: {
      taskName: 'implement-auth',
      taskContent: 'Implement authentication',
      createdAt: '2026-02-15T10:00:00Z',
      failedStep: 'review',
      error: 'Timeout',
      lastMessage: 'stopped',
      retryNote: '',
    },
    subject: {
      kind: 'branch',
      value: 'takt/implement-auth',
    },
    workflowContext: {
      name: 'default',
      description: '',
      workflowStructure: '',
      stepPreviews: [],
    },
    run: null,
    previousOrderContent: null,
  };
}

describe('assistant provider entry gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveWorkflowConfigValues.mockReturnValue({ language: 'en' });
    mockResolveConfigValues.mockReturnValue({ language: 'en' });
    mockInitializeSession.mockReturnValue({
      provider: { setup: vi.fn() },
      providerType: 'claude-sdk',
      model: 'claude-sonnet-5',
      lang: 'en',
      personaName: 'instruct',
      sessionId: undefined,
    });
    mockLoadTemplate.mockReturnValue('system prompt');
    mockRunConversationLoop.mockResolvedValue({ action: 'cancel', task: '' });
    mockSelectOption.mockResolvedValue('continue');
    mockGetLabel.mockReturnValue('Retry intro');
    mockGetLabelObject.mockReturnValue(instructUi);
  });

  it('Given top-level provider is unset, When instruct starts, Then provider resolution is deferred to initializeSession', async () => {
    await runInstructMode('/project', 'branch context', 'feature-branch', 'my-task', 'Do something', '');

    expect(mockResolveWorkflowConfigValues).toHaveBeenCalledWith('/project', ['language']);
    expect(mockInitializeSession).toHaveBeenCalledWith('/project', 'instruct');
    expect(mockRunConversationLoop).toHaveBeenCalled();
  });

  it('Given top-level provider is unset, When retry starts, Then provider resolution is deferred to initializeSession', async () => {
    mockInitializeSession.mockReturnValue({
      provider: { setup: vi.fn() },
      providerType: 'claude-sdk',
      model: 'claude-sonnet-5',
      lang: 'en',
      personaName: 'retry',
      sessionId: undefined,
    });

    await runTaskRetryMode('/project', buildRetryContext());

    expect(mockResolveConfigValues).toHaveBeenCalledWith('/project', ['language']);
    expect(mockInitializeSession).toHaveBeenCalledWith('/project', 'retry');
    expect(mockRunConversationLoop).toHaveBeenCalled();
  });
});
