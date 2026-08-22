/**
 * The readline loop, the ACP adapter and the Ink TUI all drive the same plans.
 * These lock the per-mode contract so a front-end cannot drift from the others.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInitializeSession, mockLoadTemplate, mockLoadAssistantInitContext } = vi.hoisted(() => ({
  mockInitializeSession: vi.fn(),
  mockLoadTemplate: vi.fn(),
  mockLoadAssistantInitContext: vi.fn(),
}));

vi.mock('../features/interactive/sessionInitialization.js', () => ({
  initializeSession: (...args: unknown[]) => mockInitializeSession(...args),
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: (...args: unknown[]) => mockLoadTemplate(...args),
}));

vi.mock('../features/interactive/assistantInitFiles.js', () => ({
  loadAssistantInitContext: (...args: unknown[]) => mockLoadAssistantInitContext(...args),
}));

import {
  buildInteractiveSystemPrompt,
  createAssistantConversationPlan,
  createPersonaConversationPlan,
} from '../features/interactive/conversationPlan.js';

function templateVarsFor(name: string): Record<string, unknown> {
  const call = mockLoadTemplate.mock.calls.find((args) => args[0] === name);
  if (!call) {
    throw new Error(`template ${name} was not rendered`);
  }
  return call[2] as Record<string, unknown>;
}

const WORKFLOW_CONTEXT = {
  name: 'default',
  description: 'default workflow',
  workflowStructure: '1. plan',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockInitializeSession.mockReturnValue({
    provider: { setup: vi.fn(), getRuntimeInstructions: vi.fn(() => null) },
    providerType: 'mock',
    model: 'mock-model',
    lang: 'en',
    personaName: 'interactive',
    sessionId: undefined,
  });
  mockLoadTemplate.mockReturnValue('rendered template');
  mockLoadAssistantInitContext.mockReturnValue(undefined);
});

describe('interactive system prompt', () => {
  it('should report no workflow preview and no run session when neither is given', () => {
    buildInteractiveSystemPrompt('en', { grillMe: false });

    expect(templateVarsFor('score_interactive_system_prompt')).toMatchObject({
      grillMe: false,
      hasWorkflowPreview: false,
      workflowStructure: '',
      stepDetails: '',
      hasRunSession: false,
      runTask: '',
      runWorkflow: '',
      runStatus: '',
      runStepLogs: '',
      runReports: '',
    });
  });

  it('should mark a workflow preview only when step previews exist', () => {
    buildInteractiveSystemPrompt('en', {
      grillMe: true,
      workflowContext: { ...WORKFLOW_CONTEXT, stepPreviews: [] },
    });

    expect(templateVarsFor('score_interactive_system_prompt')).toMatchObject({
      grillMe: true,
      hasWorkflowPreview: false,
      workflowStructure: '1. plan',
    });
  });
});

describe('assistant conversation plan', () => {
  it('should resolve the assistant persona and keep Bash available', () => {
    const { strategy } = createAssistantConversationPlan('/repo', {
      assistantMode: 'assistant',
      workflowContext: WORKFLOW_CONTEXT,
    });

    expect(mockInitializeSession).toHaveBeenCalledWith('/repo', 'interactive');
    expect(strategy.allowedTools).toContain('Bash');
    expect(strategy.permissionMode).toBeUndefined();
    expect(strategy.introMessage).toContain('Interactive mode');
  });

  it('should make Grill Me read-only and withhold Bash', () => {
    const { strategy } = createAssistantConversationPlan('/repo', {
      assistantMode: 'grill-me',
      workflowContext: WORKFLOW_CONTEXT,
    });

    expect(mockInitializeSession).toHaveBeenCalledWith('/repo', 'grill-me-interactive');
    expect(strategy.allowedTools).not.toContain('Bash');
    expect(strategy.permissionMode).toBe('readonly');
    expect(strategy.introMessage).toContain('Grill Me');
  });

  it('should forward the CLI provider and model overrides and the resumed session', () => {
    mockInitializeSession.mockReturnValue({
      provider: { setup: vi.fn(), getRuntimeInstructions: vi.fn(() => null) },
      providerType: 'mock',
      model: 'mock-model',
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    });

    const { ctx } = createAssistantConversationPlan('/repo', {
      assistantMode: 'assistant',
      provider: 'mock',
      model: 'other-model',
      sessionId: 'session-9',
    });

    expect(mockInitializeSession).toHaveBeenCalledWith('/repo', 'interactive', {
      provider: 'mock',
      model: 'other-model',
    });
    expect(ctx.sessionId).toBe('session-9');
  });

  it('should use the assistant init context for both the first prompt and the summary', () => {
    mockLoadAssistantInitContext.mockReturnValue('init context');

    const { strategy } = createAssistantConversationPlan('/repo', { assistantMode: 'assistant' });

    expect(strategy.initialPromptContext).toBe('init context');
    expect(strategy.summaryPromptContext).toBe('init context');
  });
});

describe('persona conversation plan', () => {
  it('should run under the persona session and its own tools', () => {
    const { strategy } = createPersonaConversationPlan('/repo', {
      personaContent: 'You are the reviewer.',
      personaDisplayName: 'Reviewer',
      allowedTools: ['Read'],
    });

    expect(mockInitializeSession).toHaveBeenCalledWith('/repo', 'persona-interactive');
    expect(strategy.allowedTools).toEqual(['Read']);
    expect(strategy.systemPrompt).toContain('You are the reviewer.');
    expect(strategy.introMessage).toContain('[Reviewer]');
  });

  it('should fall back to the default tools when the step declares none', () => {
    const { strategy } = createPersonaConversationPlan('/repo', {
      personaContent: 'You are the reviewer.',
      personaDisplayName: 'Reviewer',
      allowedTools: [],
    });

    expect(strategy.allowedTools).toContain('Bash');
  });
});
