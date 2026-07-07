/**
 * Tests for /resume command and initializeSession changes.
 *
 * Verifies:
 * - initializeSession returns sessionId: undefined (no implicit auto-load)
 * - /resume command calls selectRecentSession and updates sessionId
 * - /resume with cancel does not change sessionId
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  mockResolveAssistantConfigLayers: vi.fn(() => ({
    local: { provider: 'mock' },
    global: {},
  })),
}));

// --- Infrastructure mocks ---

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'mock', language: 'en' })),
  getBuiltinWorkflowsEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValues: vi.fn(() => ({ language: 'en', provider: 'mock', model: undefined })),
  loadSessionState: vi.fn(() => null),
  clearSessionState: vi.fn(),
}));

vi.mock('../features/interactive/assistantConfig.js', () => ({
  resolveAssistantConfigLayers: (...args: unknown[]) => mockResolveAssistantConfigLayers(...args),
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
  loadSessionState: vi.fn(() => null),
  clearSessionState: vi.fn(),
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
    playNoTask: 'No task for /play',
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
import { initializeSession } from '../features/interactive/sessionInitialization.js';

const mockGetProvider = vi.mocked(getProvider);
const mockSelectOption = vi.mocked(selectOption);
const mockLogInfo = vi.mocked(logInfo);
const mockLogError = vi.mocked(logError);
const attachmentSessionDirs = new Set<string>();

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
  for (const sessionDir of attachmentSessionDirs) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  attachmentSessionDirs.clear();
});

function createOscImagePaste(): string {
  const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  return `\x1B]1337;File=inline=1;name=reference.png;size=${imageData.length}:${imageData.toString('base64')}\x07`;
}

function createInvalidSizeOscImagePaste(): string {
  const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  return `\x1B]1337;File=inline=1;name=reference.png;size=${imageData.length + 1}:${imageData.toString('base64')}\x07`;
}

function trackAttachmentSession(tempPath: string): void {
  attachmentSessionDirs.add(path.dirname(path.dirname(tempPath)));
}

function createIsolatedTmpRoot(prefix: string): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  attachmentSessionDirs.add(tmpRoot);
  return tmpRoot;
}

function listTaktTempSessionDirs(): Set<string> {
  const taktTempRoot = path.join(os.tmpdir(), 'takt');
  if (!fs.existsSync(taktTempRoot)) {
    return new Set();
  }
  return new Set(
    fs.readdirSync(taktTempRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(taktTempRoot, entry.name)),
  );
}

function expectNoNewTaktTempSessionDirs(previous: Set<string>): void {
  const leaked = [...listTaktTempSessionDirs()].filter((sessionDir) => !previous.has(sessionDir));
  expect(leaked).toEqual([]);
}

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
    expect(mockLogInfo).toHaveBeenCalledWith(
      'Provider "mock" does not support native image input; image paths were added to the prompt.',
    );
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
    expect(mockLogInfo).toHaveBeenCalledWith(
      'Provider "mock" does not support native image input; image paths were added to the prompt.',
    );
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
    expect(mockLogInfo).not.toHaveBeenCalledWith(
      'Provider "codex" does not support native image input; image paths were added to the prompt.',
    );
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
    expect(mockLogInfo).toHaveBeenCalledWith('Mock label');

    // Then: cancelled at the end
    expect(result.action).toBe('cancel');
  });

  it('should not change sessionId when user cancels session selection', async () => {
    // Given: /resume → cancel selection → /cancel
    setupRawStdin(toRawInputs(['/resume', '/cancel']));
    setupProvider([]);
    mockSelectRecentSession.mockResolvedValue(null);

    const ctx = createSessionContext();

    // When
    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined);

    // Then: selectRecentSession called but returned null
    expect(mockSelectRecentSession).toHaveBeenCalledWith('/test', 'en');

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

    expect(mockLogInfo).toHaveBeenCalledWith('/retry is not available in this mode.');
    expect(result.action).toBe('cancel');
  });

  it('should complete /r to /resume when retry and replay are unavailable', async () => {
    // Given: /r → Tab → Enter completes to /resume, then /cancel exits
    setupRawStdin(toRawInputs(['/r\t', '/cancel']));
    setupProvider([]);

    const ctx = createSessionContext();

    // When
    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined);

    // Then
    expect(mockSelectRecentSession).toHaveBeenCalledWith('/test', 'en');
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
    expect(mockLogInfo).toHaveBeenCalledWith('No previous order found.');
    expect(mockSelectRecentSession).not.toHaveBeenCalled();
    expect(result.action).toBe('cancel');
  });
});

// =================================================================
// /go command: summary AI session isolation
// =================================================================
describe('/go command', () => {
  it('should pass sessionId as undefined to summary AI even when conversation has an active session', async () => {
    // Given: send message (AI responds with sessionId) → /go triggers summary
    setupRawStdin(toRawInputs(['hello', '/go']));

    const { provider, capture } = createScenarioProvider([
      // Call 0: user message → AI responds and sets sessionId
      { content: 'AI response', sessionId: 'session-abc' },
      // Call 1: /go summary → should NOT inherit sessionId
      { content: '## Fix broken title\nDetails here' },
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
    expect(result.action).toBe('execute');
  });

  it('should return pasted image attachments after image input and /go', async () => {
    setupRawStdin([
      `use ${createOscImagePaste()} please\r`,
      '/go\r',
    ]);

    const { provider, capture } = createScenarioProvider([
      { content: 'AI response using [Image #1].' },
      { content: 'Generated task using [Image #1].' },
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

    expect(capture.callCount).toBe(2);
    expect(capture.imageAttachments[0]).toBeUndefined();
    expect(capture.imageAttachments[1]).toBeUndefined();
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Generated task using [Image #1].');
    expect(result.attachments?.[0]?.fileName).toBe('image-1.png');
    expect(result.attachments?.[0]).not.toHaveProperty('relativePath');
    expect(result.attachments?.[0]?.tempPath).toBeDefined();
    trackAttachmentSession(result.attachments![0]!.tempPath);
    expect(fs.existsSync(result.attachments![0]!.tempPath)).toBe(true);
  });

  it('should cleanup pasted image session directory when input processing throws after image paste', async () => {
    const tmpRoot = createIsolatedTmpRoot('takt-conversation-cleanup-');
    const originalTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = tmpRoot;
    const previousSessionDirs = listTaktTempSessionDirs();
    setupRawStdin([
      `use ${createOscImagePaste()} ${createInvalidSizeOscImagePaste()}\r`,
    ]);
    const ctx = createSessionContext();

    try {
      await expect(
        runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined),
      ).rejects.toThrow('Pasted inline image data does not match its declared size.');

      expectNoNewTaktTempSessionDirs(previousSessionDirs);
    } finally {
      if (originalTmpDir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpDir;
      }
    }
  });

  it('should pass image attachment bodies only to native image providers', async () => {
    setupRawStdin([
      `use ${createOscImagePaste()} please\r`,
      '/go\r',
    ]);

    const { provider, capture } = createScenarioProvider([
      { content: 'AI response using [Image #1].' },
      { content: 'Generated task using [Image #1].' },
    ], { supportsNativeImageInput: true });

    const ctx: SessionContext = {
      provider: provider as SessionContext['provider'],
      providerType: 'codex' as SessionContext['providerType'],
      model: undefined,
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };

    const result = await runConversationLoop('/test', ctx, defaultStrategy, undefined, undefined);

    expect(capture.callCount).toBe(2);
    expect(capture.imageAttachments[0]?.[0]?.placeholder).toBe('[Image #1]');
    expect(capture.imageAttachments[0]?.[0]?.path).toBeDefined();
    expect(capture.imageAttachments[1]?.[0]?.placeholder).toBe('[Image #1]');
    expect(result.action).toBe('execute');
    trackAttachmentSession(result.attachments![0]!.tempPath);
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

  it('should not create formal task assets when image input is cancelled', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-cancel-image-test-'));
    try {
      setupRawStdin([
        `use ${createOscImagePaste()} please\r`,
        '/cancel\r',
      ]);

      setupProvider(['AI response using [Image #1].']);
      const ctx = createSessionContext();

      const result = await runConversationLoop(projectRoot, ctx, defaultStrategy, undefined, undefined);

      expect(result.action).toBe('cancel');
      expect(result.attachments?.[0]?.fileName).toBe('image-1.png');
      expect(result.attachments?.[0]?.tempPath).toBeDefined();
      trackAttachmentSession(result.attachments![0]!.tempPath);
      expect(fs.existsSync(path.join(projectRoot, '.takt', 'tasks'))).toBe(false);
      expect(fs.existsSync(path.join(projectRoot, '.takt', 'runs'))).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
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
    expect(mockLogInfo).toHaveBeenCalledWith('No conversation');
    expect(result.action).toBe('cancel');
  });
});

describe('conversation logging', () => {
  it('should log only non-sensitive metadata for initial input, session state, and play task', async () => {
    setupRawStdin(toRawInputs(['/play secret implementation details']));
    setupProvider([]);

    const ctx = createSessionContext({ sessionId: 'sensitive-session-id' });

    const result = await runConversationLoop(
      '/test',
      ctx,
      defaultStrategy,
      undefined,
      { sourceContext: 'secret prefilled input' },
    );

    expect(result).toEqual({
      action: 'execute',
      task: 'secret implementation details',
    });
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Loaded initial input as source context without auto-submitting to AI',
      {
        hasInitialInput: true,
        initialInputLength: 'secret prefilled input'.length,
        hasSession: true,
      },
    );
    expect(mockLogger.info).toHaveBeenCalledWith('Play command', {
      hasTaskText: true,
      taskLength: 'secret implementation details'.length,
    });
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
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      'Play command',
      expect.objectContaining({
        task: 'secret implementation details',
      }),
    );
  });
});
