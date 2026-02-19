/**
 * Tests for /retry slash command in the conversation loop.
 *
 * Verifies:
 * - /retry with previousOrderContent returns execute action with order content
 * - /retry without previousOrderContent shows error and continues loop
 * - /retry in retry mode with order.md context in system prompt
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  setupRawStdin,
  restoreStdin,
  toRawInputs,
  createMockProvider,
  type MockProviderCapture,
} from './helpers/stdinSimulator.js';

// --- Mocks (infrastructure only) ---

vi.mock('../infra/fs/session.js', () => ({
  loadNdjsonLog: vi.fn(),
}));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'mock', language: 'en' })),
  getBuiltinPiecesEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
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

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn((_key: string, _lang: string) => 'Mock label'),
  getLabelObject: vi.fn(() => ({
    intro: 'Retry intro',
    resume: 'Resume',
    noConversation: 'No conversation',
    summarizeFailed: 'Summarize failed',
    continuePrompt: 'Continue?',
    proposed: 'Proposed:',
    actionPrompt: 'What next?',
    playNoTask: 'No task',
    cancelled: 'Cancelled',
    retryNoOrder: 'No previous order found.',
    actions: { execute: 'Execute', saveTask: 'Save', continue: 'Continue' },
  })),
}));

// --- Imports (after mocks) ---

import { getProvider } from '../infra/providers/index.js';
import { runRetryMode, type RetryContext } from '../features/interactive/retryMode.js';
import { info } from '../shared/ui/index.js';

const mockGetProvider = vi.mocked(getProvider);
const mockInfo = vi.mocked(info);

function createTmpDir(): string {
  const dir = join(tmpdir(), `takt-retry-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function setupProvider(responses: string[]): MockProviderCapture {
  const { provider, capture } = createMockProvider(responses);
  mockGetProvider.mockReturnValue(provider);
  return capture;
}

function buildRetryContext(overrides?: Partial<RetryContext>): RetryContext {
  return {
    failure: {
      taskName: 'test-task',
      taskContent: 'Test task content',
      createdAt: '2026-02-15T10:00:00Z',
      failedMovement: 'implement',
      error: 'Some error',
      lastMessage: '',
      retryNote: '',
    },
    branchName: 'takt/test-task',
    pieceContext: {
      name: 'default',
      description: '',
      pieceStructure: '',
      movementPreviews: [],
    },
    run: null,
    previousOrderContent: null,
    ...overrides,
  };
}

// --- Tests ---

describe('/retry slash command', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreStdin();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should execute with previous order content when /retry is used', async () => {
    const orderContent = '# Task Order\n\nImplement feature X with tests.';
    setupRawStdin(toRawInputs(['/retry']));
    setupProvider([]);

    const retryContext = buildRetryContext({ previousOrderContent: orderContent });
    const result = await runRetryMode(tmpDir, retryContext, orderContent);

    expect(result.action).toBe('execute');
    expect(result.task).toBe(orderContent);
  });

  it('should show error and continue when /retry is used without order', async () => {
    setupRawStdin(toRawInputs(['/retry', '/cancel']));
    setupProvider([]);

    const retryContext = buildRetryContext({ previousOrderContent: null });
    const result = await runRetryMode(tmpDir, retryContext, null);

    expect(mockInfo).toHaveBeenCalledWith('No previous order found.');
    expect(result.action).toBe('cancel');
  });

  it('should inject order.md content into retry system prompt', async () => {
    const orderContent = '# Build login page\n\nWith OAuth2 support.';
    setupRawStdin(toRawInputs(['check the order', '/cancel']));
    const capture = setupProvider(['I see the order content.']);

    const retryContext = buildRetryContext({ previousOrderContent: orderContent });
    await runRetryMode(tmpDir, retryContext, orderContent);

    expect(capture.systemPrompts.length).toBeGreaterThan(0);
    const systemPrompt = capture.systemPrompts[0]!;
    expect(systemPrompt).toContain('Previous Order');
    expect(systemPrompt).toContain(orderContent);
  });

  it('should not include order section when no order content', async () => {
    setupRawStdin(toRawInputs(['check the order', '/cancel']));
    const capture = setupProvider(['No order found.']);

    const retryContext = buildRetryContext({ previousOrderContent: null });
    await runRetryMode(tmpDir, retryContext, null);

    expect(capture.systemPrompts.length).toBeGreaterThan(0);
    const systemPrompt = capture.systemPrompts[0]!;
    expect(systemPrompt).not.toContain('Previous Order');
  });
});
