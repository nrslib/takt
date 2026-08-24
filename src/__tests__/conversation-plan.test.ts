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
    for (const command of ['/workflow', '/mode', '/provider', '/model <value>', '/effort <value>']) {
      expect(strategy.introMessage).not.toContain(command);
    }
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
    for (const command of ['/workflow', '/mode', '/provider', '/model <value>', '/effort <value>']) {
      expect(strategy.introMessage).not.toContain(command);
    }
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

  it('should attach interactive effort without translating it into provider options', () => {
    const { ctx } = createAssistantConversationPlan('/repo', {
      assistantMode: 'assistant',
      effort: 'custom-effort',
    });

    expect(ctx.effort).toBe('custom-effort');
    expect(mockInitializeSession).toHaveBeenCalledWith('/repo', 'interactive');
  });

  it('should rebuild from an already resolved session without re-resolving runtime settings', () => {
    const provider = {
      supportsStructuredOutput: false,
      supportsNativeImageInput: false,
      keepsAllowedToolWithoutEdit: vi.fn(() => false),
      setup: vi.fn(),
      getRuntimeInstructions: vi.fn(() => null),
    };
    const { ctx } = createAssistantConversationPlan('/repo', {
      assistantMode: 'grill-me',
      model: 'temporary-model',
      resolvedSessionContext: {
        provider,
        providerType: 'codex',
        model: 'runtime-model',
        lang: 'ja',
        personaName: 'interactive',
        sessionId: 'old-session',
        providerOptions: { codex: { reasoningEffort: 'high' } },
        permissionMode: 'readonly',
      },
    });

    expect(mockInitializeSession).not.toHaveBeenCalled();
    expect(ctx).toEqual(expect.objectContaining({
      provider,
      providerType: 'codex',
      model: 'temporary-model',
      lang: 'ja',
      personaName: 'grill-me-interactive',
      sessionId: undefined,
      providerOptions: { codex: { reasoningEffort: 'high' } },
      permissionMode: 'readonly',
    }));
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
    expect(strategy.introMessage).not.toContain('/workflow');
    expect(strategy.resolveResumedSessionConfiguration).toBeUndefined();
  });

  it('should fall back to the default tools when the step declares none', () => {
    const { strategy } = createPersonaConversationPlan('/repo', {
      personaContent: 'You are the reviewer.',
      personaDisplayName: 'Reviewer',
      allowedTools: [],
    });

    expect(strategy.allowedTools).toContain('Bash');
  });

  it('should apply explicit interactive provider, model, and effort overrides', () => {
    const { ctx } = createPersonaConversationPlan('/repo', {
      personaContent: 'You are the reviewer.',
      personaDisplayName: 'Reviewer',
      allowedTools: ['Read'],
    }, {
      provider: 'claude',
      model: 'custom-model',
      effort: 'custom-effort',
    });

    expect(mockInitializeSession).toHaveBeenCalledWith('/repo', 'persona-interactive', {
      provider: 'claude',
      model: 'custom-model',
    });
    expect(ctx.effort).toBe('custom-effort');
  });
});
