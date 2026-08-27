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

  it('should describe workflow agents without exposing their model identity', () => {
    buildInteractiveSystemPrompt('en', {
      grillMe: false,
      workflowContext: {
        ...WORKFLOW_CONTEXT,
        stepPreviews: [{
          name: 'plan',
          personaDisplayName: 'Architect',
          personaContent: 'You are an architect.',
          instructionContent: 'Plan the feature.',
          allowedTools: ['Read', 'Grep'],
          canEdit: false,
          provider: 'codex',
          model: 'gpt-5.6-luna',
          providerSource: 'step',
          modelSource: 'step',
          permissionMode: 'readonly',
        }],
      },
    });

    const stepDetails = templateVarsFor('score_interactive_system_prompt').stepDetails;
    expect(stepDetails).toContain('**Provider:** codex');
    expect(stepDetails).toContain('**Provider source:** step');
    expect(stepDetails).toContain('**Permission:** readonly');
    expect(stepDetails).toContain('**Persona:**');
    expect(stepDetails).toContain('**Instruction:**');
    expect(stepDetails).toContain('**Tools:** Read, Grep');
    expect(stepDetails).not.toContain('**Model:**');
    expect(stepDetails).not.toContain('**Model source:**');
    expect(stepDetails).not.toContain('gpt-5.6-luna');
  });
});

describe('assistant conversation plan', () => {
  it('should propagate the resolved formal specification comments setting to the prompt and strategy', () => {
    const { strategy } = createAssistantConversationPlan('/repo', {
      assistantMode: 'assistant',
      formalSpec: true,
      formalSpecComments: false,
    });

    expect(strategy.formalSpec).toBe(true);
    expect(strategy.formalSpecComments).toBe(false);
    expect(templateVarsFor('score_interactive_system_prompt')).toMatchObject({
      formalSpec: true,
      formalSpecComments: false,
      formalSpecCommentsEnabled: false,
    });
  });

  it('should resolve the assistant persona and keep Bash available', () => {
    const { strategy } = createAssistantConversationPlan('/repo', {
      assistantMode: 'assistant',
      formalSpec: false,
      formalSpecComments: true,
      workflowContext: WORKFLOW_CONTEXT,
    });

    expect(mockInitializeSession).toHaveBeenCalledWith('/repo', 'interactive');
    expect(strategy.allowedTools).toContain('Bash');
    expect(strategy.permissionMode).toBeUndefined();
    expect(strategy.introMessage).toContain('Interactive mode');
    expect(strategy.introMessage.match(/\/[\w-]+/g)).toEqual(['/go']);
  });

  it('should make Grill Me read-only and withhold Bash', () => {
    const { strategy } = createAssistantConversationPlan('/repo', {
      assistantMode: 'grill-me',
      formalSpec: false,
      formalSpecComments: true,
      workflowContext: WORKFLOW_CONTEXT,
    });

    expect(mockInitializeSession).toHaveBeenCalledWith('/repo', 'grill-me-interactive');
    expect(strategy.allowedTools).not.toContain('Bash');
    expect(strategy.permissionMode).toBe('readonly');
    expect(strategy.introMessage).toContain('Grill Me mode');
    expect(strategy.introMessage.match(/\/[\w-]+/g)).toEqual(['/go']);
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
      formalSpec: false,
      formalSpecComments: true,
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
      formalSpec: false,
      formalSpecComments: true,
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
      formalSpec: false,
      formalSpecComments: true,
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
      providerOptions: { codex: { reasoningEffort: 'high' } },
      permissionMode: 'readonly',
    }));
    expect(ctx.sessionId).toBeUndefined();
  });

  it('should use the assistant init context for both the first prompt and the summary', () => {
    mockLoadAssistantInitContext.mockReturnValue('init context');

    const { strategy } = createAssistantConversationPlan('/repo', {
      assistantMode: 'assistant',
      formalSpec: false,
      formalSpecComments: true,
    });

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
