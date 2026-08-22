/**
 * Tests for /resume command and initializeSession changes.
 *
 * Verifies:
 * - initializeSession returns sessionId: undefined (no implicit auto-load)
 * - /resume command calls selectRecentSession and updates sessionId
 * - /resume with cancel does not change sessionId
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveAssistantProviderModelFromConfig as realResolveAssistantProviderModelFromConfig,
  type AssistantCliOverrides,
  type AssistantProviderConfig,
} from '../core/config/provider-resolution.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  setupRawStdin,
  restoreStdin,
  toRawInputs,
  createMockProvider,
  createScenarioProvider,
  type MockProviderCapture,
} from './helpers/stdinSimulator.js';

const { mockResolveAssistantConfigLayers } = vi.hoisted(() => ({
  mockResolveAssistantConfigLayers: vi.fn((_projectDir: string): AssistantProviderConfig => ({
    local: { provider: 'mock' },
    global: {},
  })),
}));

const { mockUpdatePersonaSession } = vi.hoisted(() => ({
  mockUpdatePersonaSession: vi.fn(),
}));

// --- Infrastructure mocks ---

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'mock', language: 'en' })),
  getBuiltinWorkflowsEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValues: vi.fn(() => ({ language: 'en', provider: 'mock', model: undefined })),
  resolveNonWorkflowProviderOptions: vi.fn(() => ({
    codex: { skills: { repo: false, user: false } },
  })),
  takeSessionState: vi.fn(() => null),
  updatePersonaSession: mockUpdatePersonaSession,
}));

vi.mock('../features/interactive/assistantConfig.js', () => ({
  resolveAssistantConfigLayers: (projectDir: string) => mockResolveAssistantConfigLayers(projectDir),
  resolveAssistantProviderModel: (projectDir: string, cliOverrides?: AssistantCliOverrides) =>
    realResolveAssistantProviderModelFromConfig(
      mockResolveAssistantConfigLayers(projectDir),
      cliOverrides,
    ),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(),
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => mockLogger,
}));

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn(() => false),
}));

vi.mock('../infra/config/paths.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPersonaSessions: vi.fn(() => ({})),
  updatePersonaSession: vi.fn(),
  getProjectConfigDir: vi.fn(() => '/tmp'),
  takeSessionState: vi.fn(() => null),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  blankLine: vi.fn(),
  StreamDisplay: vi.fn().mockImplementation(() => ({
    createHandler: vi.fn(() => vi.fn()),
    flush: vi.fn(),
  })),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn().mockResolvedValue('execute'),
}));

const mockSelectRecentSession = vi.fn<(cwd: string, lang: 'en' | 'ja') => Promise<string | null>>();

vi.mock('../features/interactive/sessionSelector.js', () => ({
  selectRecentSession: (...args: [string, 'en' | 'ja']) => mockSelectRecentSession(...args),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn((_key: string, _lang: string) => 'Mock label'),
  getLabelObject: vi.fn(() => ({
    intro: 'Intro',
    resume: 'Resume',
    noConversation: 'No conversation',
    summarizeFailed: 'Summarize failed',
    continuePrompt: 'Continue?',
    proposed: 'Proposed:',
    actionPrompt: 'What next?',
    retryNoOrder: 'No previous order found.',
    retryUnavailable: '/retry is not available in this mode.',
    cancelled: 'Cancelled',
    actions: { execute: 'Execute', saveTask: 'Save', continue: 'Continue' },
  })),
}));

// --- Imports (after mocks) ---

import { getProvider } from '../infra/providers/index.js';
import { selectOption } from '../shared/prompt/index.js';
import { error as logError, info as logInfo } from '../shared/ui/index.js';
import { callAIWithRetry, runConversationLoop, type SessionContext } from '../features/interactive/conversationLoop.js';
import * as interactiveModule from '../features/interactive/interactive.js';
import { initializeSession } from '../features/interactive/sessionInitialization.js';
import { SlashCommand } from '../shared/constants.js';

const mockGetProvider = vi.mocked(getProvider);
const mockSelectOption = vi.mocked(selectOption);
const mockLogInfo = vi.mocked(logInfo);
const mockLogError = vi.mocked(logError);

// --- Helpers ---

function setupProvider(responses: string[]): MockProviderCapture {
  const { provider, capture } = createMockProvider(responses);
  mockGetProvider.mockReturnValue(provider);
  return capture;
}

function createSessionContext(overrides: Partial<SessionContext> = {}): SessionContext {
  const { provider } = createMockProvider([]);
  mockGetProvider.mockReturnValue(provider);
  return {
    provider: provider as SessionContext['provider'],
    providerType: 'mock' as SessionContext['providerType'],
    model: undefined,
    lang: 'en',
    personaName: 'interactive',
    sessionId: undefined,
    ...overrides,
  };
}

const defaultStrategy = {
  systemPrompt: 'test system prompt',
  allowedTools: ['Read'],
  formalSpec: false,
  transformPrompt: (msg: string) => msg,
  introMessage: 'Test intro',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectOption.mockResolvedValue('execute');
  mockSelectRecentSession.mockResolvedValue(null);
  mockResolveAssistantConfigLayers.mockReturnValue({
    local: { provider: 'mock' },
    global: {},
  });
});

afterEach(() => {
  restoreStdin();
});

function createMissingImageAttachment() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-missing-image-'));
  const tempPath = path.join(tempDir, 'missing-image.png');
  fs.rmSync(tempDir, { recursive: true, force: true });
  return {
    placeholder: '[Image #1]',
    tempPath,
    fileName: 'image-1.png',
  };
}

// =================================================================
// initializeSession: no implicit session auto-load
// =================================================================
describe('initializeSession', () => {
  it('should return sessionId as undefined (no implicit auto-load)', () => {
    const ctx = initializeSession('/test/cwd', 'interactive');

    expect(ctx.sessionId).toBeUndefined();
    expect(ctx.personaName).toBe('interactive');
  });
});

describe('callAIWithRetry', () => {
  it('does not persist a returned session when persistence is disabled', async () => {
    const { provider } = createScenarioProvider([
      { content: 'summary', sessionId: 'summary-session' },
    ]);
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'grill-me-interactive',
      sessionId: undefined,
    };

    const { sessionId } = await callAIWithRetry(
      'summarize',
      'summary prompt',
      [],
      '/repo',
      ctx,
      { persistSession: false },
    );

    expect(sessionId).toBe('summary-session');
    expect(mockUpdatePersonaSession).not.toHaveBeenCalled();
  });

  it('passes session provider options to the initial call and stale-session retry', async () => {
    const { provider, capture } = createScenarioProvider([
      { content: 'stale', status: 'error' },
      { content: 'ok', sessionId: 'fresh-session' },
    ]);
    const providerOptions = { claude: { effort: 'high' as const } };
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'claude',
      model: 'opus',
      lang: 'en',
      personaName: 'interactive',
      sessionId: 'stale-session',
      providerOptions,
    };

    await callAIWithRetry('hello', 'base system prompt', ['Read'], '/repo', ctx);

    expect(capture.providerOptions).toEqual([providerOptions, providerOptions]);
    expect(capture.sessionIds).toEqual(['stale-session', undefined]);
  });

  it('passes permission mode to the initial call and stale-session retry', async () => {
    const { provider, capture } = createScenarioProvider([
      { content: 'stale', status: 'error' },
      { content: 'ok', sessionId: 'fresh-session' },
    ]);
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'codex',
      model: 'gpt-5',
      lang: 'en',
      personaName: 'interactive',
      sessionId: 'stale-session',
    };

    await callAIWithRetry('hello', 'base system prompt', [], '/repo', ctx, {
      permissionMode: 'readonly',
    });

    expect(capture.permissionModes).toEqual(['readonly', 'readonly']);
    expect(capture.sessionIds).toEqual(['stale-session', undefined]);
  });

  it('omits synthetic permissions and selector tools for DeepSeek Harness', async () => {
    const { provider, capture } = createScenarioProvider([
      { content: 'done', sessionId: 'deepseek-session' },
    ]);
    const deepseekProvider = provider as SessionContext['provider'] & {
      supportsPermissionControls: () => boolean;
    };
    deepseekProvider.supportsPermissionControls = () => false;
    mockGetProvider.mockReturnValue(deepseekProvider);
    const ctx: SessionContext = {
      provider: deepseekProvider,
      providerType: 'deepseek-harness' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    await callAIWithRetry('hello', 'base system prompt', ['Read'], '/repo', ctx, {
      permissionMode: 'readonly',
      outputMode: 'silent',
    });

    expect(capture.allowedTools).toEqual([undefined]);
    expect(capture.permissionModes).toEqual([undefined]);
  });

  it('retains an explicit session permission mode for an unsupported provider', async () => {
    const { provider, capture } = createScenarioProvider([
      { content: 'done', sessionId: 'deepseek-session' },
    ]);
    const deepseekProvider = provider as SessionContext['provider'] & {
      supportsPermissionControls: () => boolean;
    };
    deepseekProvider.supportsPermissionControls = () => false;
    mockGetProvider.mockReturnValue(deepseekProvider);
    const ctx: SessionContext = {
      provider: deepseekProvider,
      providerType: 'deepseek-harness' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
      permissionMode: 'readonly',
    };

    await callAIWithRetry('hello', 'base system prompt', ['Read'], '/repo', ctx, {
      outputMode: 'silent',
    });

    expect(capture.allowedTools).toEqual([undefined]);
    expect(capture.permissionModes).toEqual(['readonly']);
  });

  it('expands image placeholders and omits native attachments for non-native providers', async () => {
    const { provider, capture } = createScenarioProvider([
      { content: 'stale', status: 'error' },
      { content: 'ok', sessionId: 'fresh-session' },
    ], { supportsNativeImageInput: false });
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: 'stale-session',
    };

    await callAIWithRetry('inspect [Image #1]', 'base system prompt', [], '/repo', ctx, {
      imageAttachments: [{ placeholder: '[Image #1]', path: '/tmp/takt-image-1.png' }],
    });

    expect(capture.prompts).toEqual([
      'inspect [Image #1] (`/tmp/takt-image-1.png`)',
      'inspect [Image #1] (`/tmp/takt-image-1.png`)',
    ]);
    expect(capture.imageAttachments).toEqual([undefined, undefined]);
    expect(capture.sessionIds).toEqual(['stale-session', undefined]);
    expect(mockLogInfo).toHaveBeenCalled();
  });

  it('appends image paths for non-native providers when prompts omit placeholders', async () => {
    const { provider, capture } = createScenarioProvider([
      { content: 'ok', sessionId: 'fresh-session' },
    ], { supportsNativeImageInput: false });
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    await callAIWithRetry('Summarize the completed run.', 'base system prompt', [], '/repo', ctx, {
      imageAttachments: [{ placeholder: '[Image #1]', path: '/tmp/takt-image-1.png' }],
    });

    expect(capture.prompts).toEqual([
      'Summarize the completed run.\n\n[Image #1] path: `/tmp/takt-image-1.png`',
    ]);
    expect(capture.imageAttachments).toEqual([undefined]);
    expect(mockLogInfo).toHaveBeenCalled();
  });

  it('keeps local image paths out of prompts for native providers and stale-session retry', async () => {
    const { provider, capture } = createScenarioProvider([
      { content: 'stale', status: 'error' },
      { content: 'ok', sessionId: 'fresh-session' },
    ], { supportsNativeImageInput: true });
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'codex',
      model: 'gpt-5',
      lang: 'en',
      personaName: 'interactive',
      sessionId: 'stale-session',
    };
    const imageAttachments = [{ placeholder: '[Image #1]', path: '/tmp/takt-image-1.png' }];

    await callAIWithRetry('inspect [Image #1]', 'base system prompt', [], '/repo', ctx, {
      imageAttachments,
    });

    expect(capture.prompts).toEqual([
      'inspect [Image #1]',
      'inspect [Image #1]',
    ]);
    for (const prompt of capture.prompts) {
      expect(prompt).not.toContain('/tmp/takt-image-1.png');
    }
    expect(capture.imageAttachments).toEqual([imageAttachments, imageAttachments]);
    expect(mockLogInfo).not.toHaveBeenCalled();
  });
});

// =================================================================
// /resume command
// =================================================================
describe('/resume command', () => {
  it('should call selectRecentSession and update sessionId when session selected', async () => {
    // Given: /resume → select session → /cancel
    setupRawStdin(toRawInputs(['/resume', '/cancel']));
    setupProvider([]);
    mockSelectRecentSession.mockResolvedValue('selected-session-abc');

    const ctx = createSessionContext();

    // When
    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined);

    // Then: selectRecentSession called
    expect(mockSelectRecentSession).toHaveBeenCalledWith('/test', 'en');

    // Then: info about loaded session displayed
    expect(mockLogInfo).toHaveBeenCalled();

    // Then: cancelled at the end
    expect(result.action).toBe('cancel');
  });

  it('should not change sessionId when user cancels session selection', async () => {
    // Given: /resume → cancel selection → /cancel
    setupRawStdin(toRawInputs(['/resume', '/cancel']));
    setupProvider([]);
    mockSelectRecentSession.mockResolvedValue(null);

    const ctx = createSessionContext();
    const resolveResumedSessionConfiguration = vi.fn();

    // When
    const result = await runConversationLoop('/test', ctx, {
      ...defaultStrategy,
      resolveResumedSessionConfiguration,
    }, undefined, undefined);

    // Then: selectRecentSession called but returned null
    expect(mockSelectRecentSession).toHaveBeenCalledWith('/test', 'en');
    expect(resolveResumedSessionConfiguration).not.toHaveBeenCalled();

    // Then: cancelled
    expect(result.action).toBe('cancel');
  });

  it('should use resumed session for subsequent AI calls', async () => {
    // Given: /resume → select session → send message → /cancel
    setupRawStdin(toRawInputs(['/resume', 'hello world', '/cancel']));
    mockSelectRecentSession.mockResolvedValue('resumed-session-xyz');

    const { provider, capture } = createScenarioProvider([
      { content: 'AI response' },
    ]);

    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    // When
    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined);

    // Then: AI call should use the resumed session ID
    expect(capture.sessionIds[0]).toBe('resumed-session-xyz');
    expect(result.action).toBe('cancel');
  });

  it.each([false, true])(
    'should apply resumed formal specification mode=%s to regular and summary prompts',
    async (formalSpec) => {
      setupRawStdin(toRawInputs(['/resume', 'describe parser states', '/go add rollback plan']));
      mockSelectRecentSession.mockResolvedValue('resumed-session-xyz');
      const resolveResumedSessionConfiguration = vi.fn().mockResolvedValue({
        systemPrompt: `resumed system prompt formalSpec=${formalSpec}`,
        formalSpec,
      });
      const { provider, capture } = createScenarioProvider([
        { content: 'Which transitions can fail?' },
        { content: 'Generated task instruction.' },
      ]);
      const ctx = createSessionContext({
        provider: provider as SessionContext['provider'],
      });

      const result = await runConversationLoop('/test', ctx, {
        ...defaultStrategy,
        formalSpec: !formalSpec,
        resolveResumedSessionConfiguration,
      }, undefined, undefined);

      expect(result.action).toBe('execute');
      expect(resolveResumedSessionConfiguration).toHaveBeenCalledOnce();
      expect(capture.systemPrompts[0]).toBe(`resumed system prompt formalSpec=${formalSpec}`);
      if (formalSpec) {
        expect(capture.prompts[1]).toMatch(/\bQuint\b/);
        expect(capture.prompts[1]).toMatch(/\bAlloy\b/);
      } else {
        expect(capture.prompts[1]).not.toMatch(/\bQuint\b/);
        expect(capture.prompts[1]).not.toMatch(/\bAlloy\b/);
      }
    },
  );

  it('should keep inline /go text as user note after resuming a session', async () => {
    setupRawStdin(toRawInputs(['/resume', '/go add rollback plan']));
    mockSelectRecentSession.mockResolvedValue('resumed-session-xyz');

    const { provider, capture } = createScenarioProvider([
      { content: 'Summarized resumed task.' },
    ]);

    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined);

    expect(capture.callCount).toBe(1);
    expect(result).toEqual({
      action: 'execute',
      task: 'Summarized resumed task.',
    });
  });

  it('should reject /retry in non-retry mode', async () => {
    setupRawStdin(toRawInputs(['/retry', '/cancel']));
    setupProvider([]);

    const ctx = createSessionContext();
    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined);

    expect(mockLogInfo).toHaveBeenCalled();
    expect(result.action).toBe('cancel');
  });

  it('should complete /r to /retry when retry is available', async () => {
    // Given: /r → Tab → Enter completes to /retry, then /cancel exits
    setupRawStdin(toRawInputs(['/r\t', '/cancel']));
    setupProvider([]);

    const ctx = createSessionContext();

    // When
    const result = await runConversationLoop('/test', ctx, {
      ...defaultStrategy,
      enableRetryCommand: true,
    }, undefined, undefined);

    // Then
    expect(mockLogInfo).toHaveBeenCalled();
    expect(mockSelectRecentSession).not.toHaveBeenCalled();
    expect(result.action).toBe('cancel');
  });
});

// =================================================================
// /go command: summary AI session isolation
// =================================================================
describe('/go command', () => {
  it('does not turn a disabled /accept into an execution result in a guarded mode', async () => {
    setupRawStdin(toRawInputs(['/accept', '/go']));
    const { provider } = createScenarioProvider([
      { content: 'Assistant response to accept text' },
      { content: 'Revised order body' },
    ]);
    const ctx = createSessionContext({ provider: provider as SessionContext['provider'] });

    const result = await runConversationLoop('/test', ctx, {
      ...defaultStrategy,
      enabledCommands: [SlashCommand.Go, SlashCommand.Cancel],
      trackResultSource: true,
    }, undefined, undefined);

    expect(result).toMatchObject({
      action: 'execute',
      task: 'Revised order body',
      source: 'go',
    });
  });

  it.each([false, true])('should apply resolved formal specification mode=%s to the real summary prompt', async (formalSpec) => {
    setupRawStdin(toRawInputs(['/go improve parser behavior']));
    const { provider, capture } = createScenarioProvider([
      { content: 'Generated task instruction.' },
    ]);
    const ctx = createSessionContext({
      provider: provider as SessionContext['provider'],
    });

    const result = await runConversationLoop('/test', ctx, {
      ...defaultStrategy,
      formalSpec,
    }, undefined, undefined);

    expect(result.action).toBe('execute');
    expect(capture.prompts[0]).toContain('## Markdown + Gherkin Output Format');
    if (formalSpec) {
      expect(capture.prompts[0]).toMatch(/\bQuint\b/);
      expect(capture.prompts[0]).toMatch(/\bAlloy\b/);
    } else {
      expect(capture.prompts[0]).not.toMatch(/\bQuint\b/);
      expect(capture.prompts[0]).not.toMatch(/\bAlloy\b/);
    }
  });

  it('should pass the resolved formal specification mode to the summary builder', async () => {
    const buildSummaryPromptSpy = vi.spyOn(interactiveModule, 'buildSummaryPrompt');
    setupRawStdin(toRawInputs(['/go improve parser behavior']));
    const { provider } = createScenarioProvider([
      { content: 'Generated task instruction.' },
    ]);
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock',
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    const result = await runConversationLoop('/test', ctx, {
      ...defaultStrategy,
      formalSpec: true,
    }, undefined, undefined);

    expect(result.action).toBe('execute');
    expect(buildSummaryPromptSpy).toHaveBeenCalledWith(
      expect.any(Array),
      false,
      'en',
      expect.any(String),
      expect.any(String),
      undefined,
      undefined,
      undefined,
      true,
    );
  });

  it('should keep the session value instead of re-resolving project config inside the conversation loop', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-formal-spec-session-value-'));
    fs.mkdirSync(path.join(projectDir, '.takt'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.takt', 'config.yaml'),
      ['assistant:', '  formal_spec: false'].join('\n'),
      'utf-8',
    );
    setupRawStdin(toRawInputs(['/go improve parser behavior']));
    const { provider, capture } = createScenarioProvider([
      { content: 'Generated task instruction.' },
    ]);
    const ctx = createSessionContext({
      provider: provider as SessionContext['provider'],
    });

    try {
      const result = await runConversationLoop(projectDir, ctx, {
        ...defaultStrategy,
        formalSpec: true,
      }, undefined, undefined);

      expect(result.action).toBe('execute');
      expect(capture.prompts[0]).toMatch(/\bQuint\b/);
      expect(capture.prompts[0]).toMatch(/\bAlloy\b/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('should isolate the summary AI without replacing the resumable conversation session', async () => {
    // Given: send message (AI responds with sessionId) → /go triggers summary
    setupRawStdin(toRawInputs(['hello', '/go']));

    const { provider, capture } = createScenarioProvider([
      // Call 0: user message → AI responds and sets sessionId
      { content: 'AI response', sessionId: 'session-abc' },
      // Call 1: /go summary → should NOT inherit sessionId
      { content: '## Fix broken title\nDetails here', sessionId: 'summary-session' },
    ]);

    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    // When
    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined);

    // Then: first AI call had no session (initial state)
    expect(capture.sessionIds[0]).toBeUndefined();
    // Then: summary call must NOT inherit the conversation session
    expect(capture.sessionIds[1]).toBeUndefined();
    expect(mockUpdatePersonaSession).toHaveBeenCalledTimes(1);
    expect(mockUpdatePersonaSession).toHaveBeenCalledWith(
      '/test',
      'interactive',
      'session-abc',
      'mock',
    );
    expect(result.action).toBe('execute');
  });

  it('should return a rejected /go draft to the conversation history', async () => {
    setupRawStdin(toRawInputs(['hello', '/go', 'revise this draft', '/go']));
    const { provider, capture } = createScenarioProvider([
      { content: 'Initial assistant response' },
      { content: 'First generated order' },
      { content: 'Revised assistant response' },
      { content: 'Second generated order' },
    ]);
    const selectGoAction = vi.fn()
      .mockResolvedValueOnce('continue')
      .mockResolvedValueOnce('execute');
    const ctx = createSessionContext({
      provider: provider as SessionContext['provider'],
    });

    const result = await runConversationLoop(
      '/test',
      ctx,
      { ...defaultStrategy, selectGoAction },
      undefined,
      undefined,
    );

    expect(result.action).toBe('execute');
    expect(result.task).toBe('Second generated order');
    expect(capture.prompts[3]).toContain('First generated order');
  });

  it('should report missing stored images in regular input and continue without calling AI', async () => {
    setupRawStdin(toRawInputs(['inspect [Image #1]', '/cancel']));
    const missingAttachment = createMissingImageAttachment();
    const { provider, capture } = createScenarioProvider([], { supportsNativeImageInput: true });
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'codex' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, {
      attachments: [missingAttachment],
    });

    expect(capture.callCount).toBe(0);
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('missing-image.png'));
    expect(result.action).toBe('cancel');
  });

  it('should report missing stored images in /go summary and continue without calling AI', async () => {
    setupRawStdin(toRawInputs(['/go inspect [Image #1]', '/cancel']));
    const missingAttachment = createMissingImageAttachment();
    const { provider, capture } = createScenarioProvider([], { supportsNativeImageInput: true });
    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'codex' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, {
      attachments: [missingAttachment],
    });

    expect(capture.callCount).toBe(0);
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('missing-image.png'));
    expect(result.action).toBe('cancel');
  });

  it('should include assistant init context only in the first regular AI prompt', async () => {
    setupRawStdin(toRawInputs(['hello', 'follow up', '/cancel']));

    const { provider, capture } = createScenarioProvider([
      { content: 'AI response' },
      { content: 'Second AI response' },
    ]);

    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    const result = await runConversationLoop(
      '/test',
      ctx,
      {
        ...defaultStrategy,
        initialPromptContext: '## Assistant Init Context\nconfigured project context',
      },
      undefined,
      undefined,
    );

    expect(capture.callCount).toBe(2);
    expect(result.action).toBe('cancel');
  });

  it('should include assistant init context in summary prompts', async () => {
    setupRawStdin(toRawInputs(['/go']));

    const { provider, capture } = createScenarioProvider([
      { content: 'Summarized task.' },
    ]);

    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    const result = await runConversationLoop(
      '/test',
      ctx,
      {
        ...defaultStrategy,
        summaryPromptContext: '## Assistant Init Context\nconfigured project context',
      },
      undefined,
      {
        userMessage: 'Implement explicit assistant init files',
      },
    );

    expect(capture.callCount).toBe(1);
    expect(result).toEqual({
      action: 'execute',
      task: 'Summarized task.',
    });
  });

  it('should not allow /go with assistant init context only', async () => {
    setupRawStdin(toRawInputs(['/go', '/cancel']));
    const { provider, capture } = createScenarioProvider([]);

    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'mock' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    const result = await runConversationLoop(
      '/test',
      ctx,
      {
        ...defaultStrategy,
        initialPromptContext: '## Assistant Init Context\nconfigured project context',
        summaryPromptContext: '## Assistant Init Context\nconfigured project context',
      },
      undefined,
      undefined,
    );

    expect(capture.callCount).toBe(0);
    expect(mockLogInfo).toHaveBeenCalled();
    expect(result.action).toBe('cancel');
  });
});

describe('conversation logging', () => {
  it('should log only non-sensitive metadata for initial input and session state', async () => {
    setupRawStdin(toRawInputs(['/cancel']));
    setupProvider([]);

    const ctx = createSessionContext({ sessionId: 'sensitive-session-id' });

    const result = await runConversationLoop(
      '/test',
      ctx,
      defaultStrategy,
      undefined,
      { sourceContext: 'secret prefilled input' },
    );

    expect(result).toEqual({ action: 'cancel', task: '' });
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Loaded initial input as source context without auto-submitting to AI',
      {
        hasInitialInput: true,
        initialInputLength: 'secret prefilled input'.length,
        hasSession: true,
      },
    );
    expect(mockLogger.debug).not.toHaveBeenCalledWith(
      'Loaded initial input as source context without auto-submitting to AI',
      expect.objectContaining({
        initialInput: 'secret prefilled input',
      }),
    );
    expect(mockLogger.debug).not.toHaveBeenCalledWith(
      'Sending to AI',
      expect.objectContaining({
        sessionId: 'sensitive-session-id',
      }),
    );
  });
});
