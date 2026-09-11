/**
 * Tests for /retry slash command in the conversation loop.
 *
 * Verifies:
 * - /retry and /replay are ordinary text in task Retry mode
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
import { selectOption } from '../shared/prompt/index.js';

// --- Mocks (infrastructure only) ---

vi.mock('../infra/fs/session.js', () => ({
  loadNdjsonLog: vi.fn(),
}));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'mock', language: 'en' })),
  getBuiltinWorkflowsEnabled: vi.fn().mockReturnValue(true),
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
  selectOption: vi.fn().mockResolvedValue('save_task'),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn((key: string, lang: string) => {
    if (key === 'orderRevision.attachmentsHeading') {
      return lang === 'ja' ? '添付画像' : 'Attachments';
    }
    return 'Mock label';
  }),
  getLabelObject: vi.fn(() => ({
    intro: 'Retry intro',
    resume: 'Resume',
    noConversation: 'No conversation',
    summarizeFailed: 'Summarize failed',
    continuePrompt: 'Continue?',
    proposed: 'Proposed:',
    actionPrompt: 'What next?',
    cancelled: 'Cancelled',
    retryNoOrder: 'No previous order found.',
    actions: { execute: 'Execute', saveTask: 'Save', continue: 'Continue' },
  })),
}));

// --- Imports (after mocks) ---

import { getProvider } from '../infra/providers/index.js';
import { runDirectRetryMode, runTaskRetryMode, type RetryContext } from '../features/interactive/retryMode.js';

const mockGetProvider = vi.mocked(getProvider);

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
      failedStep: 'implement',
      error: 'Some error',
      lastMessage: '',
      retryNote: '',
    },
    subject: {
      kind: 'branch',
      value: 'takt/test-task',
    },
    workflowContext: {
      name: 'default',
      description: '',
      workflowStructure: '',
      stepPreviews: [],
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

  it('should not route previous order content to execution when /retry is typed', async () => {
    const orderContent = '# Task Order\n\nImplement feature X with tests.';
    setupRawStdin(toRawInputs(['/retry', '/cancel']));
    const capture = setupProvider(['The text mentions a retired command.']);

    const retryContext = buildRetryContext({ previousOrderContent: orderContent });
    const result = await runTaskRetryMode(tmpDir, retryContext);

    expect(result).toMatchObject({ action: 'cancel', task: '' });
    expect(capture.callCount).toBe(1);
    expect(vi.mocked(selectOption)).not.toHaveBeenCalled();
  });

  it('should not route previous order content to execution when /replay is typed', async () => {
    setupRawStdin(toRawInputs(['/replay', '/cancel']));
    const capture = setupProvider(['The text mentions another retired command.']);

    const retryContext = buildRetryContext({ previousOrderContent: '# Previous order' });
    const result = await runTaskRetryMode(tmpDir, retryContext);

    expect(result).toMatchObject({ action: 'cancel', task: '' });
    expect(capture.callCount).toBe(1);
    expect(vi.mocked(selectOption)).not.toHaveBeenCalled();
  });

  it('should keep /go in prose, quoted text, and a closed code fence out of command handling', async () => {
    setupRawStdin(toRawInputs([
      '説明 /go の意味',
      '`/go`',
      '```text\n/go\n```',
      '/cancel',
    ]));
    const capture = setupProvider([
      'prose response',
      'quoted response',
      'code response',
    ]);

    const result = await runTaskRetryMode(tmpDir, buildRetryContext());

    expect(result).toMatchObject({ action: 'cancel', task: '' });
    expect(capture.callCount).toBe(3);
    expect(vi.mocked(selectOption)).not.toHaveBeenCalled();
  });

  it('should not execute a command this mode disabled in order revision retry mode', async () => {
    // Neither is on the mode's list, so both lines are ordinary text.
    setupRawStdin(toRawInputs(['/accept', '/setup run it', '/go']));
    setupProvider([
      'Assistant response to accept text',
      'Assistant response to setup text',
      'Revised retry order',
    ]);

    const result = await runTaskRetryMode(tmpDir, buildRetryContext());

    expect(result.action).toBe('save_task');
    expect(result.source).toBe('go');
    expect(result.task).toBe('Revised retry order');
  });

  it('should keep direct run retry mode separate from task Retry mode', async () => {
    vi.mocked(selectOption).mockResolvedValueOnce('execute');
    const orderContent = '# Direct Order\n\nFix the failed direct run.';
    setupRawStdin(toRawInputs(['/retry']));
    setupProvider([]);

    const retryContext = buildRetryContext({
      subject: {
        kind: 'run',
        value: '20260524-direct-failed',
      },
      previousOrderContent: orderContent,
    });
    const result = await runDirectRetryMode(tmpDir, retryContext);

    expect(result.action).toBe('execute');
    expect(result.task).toBe(orderContent);
    const options = vi.mocked(selectOption).mock.calls[0]?.[1] as Array<{ value: string }>;
    expect(options.map((option) => option.value)).toEqual(['execute', 'continue']);
  });

});
