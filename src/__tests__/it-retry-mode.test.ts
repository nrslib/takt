/**
 * E2E test: Retry mode with failure context and run session injection.
 *
 * Simulates the retry assistant flow:
 * 1. Create .takt/runs/ fixtures (logs, reports)
 * 2. Build RetryContext with failure info + run session
 * 3. Run retry mode with stdin simulation (user types message → /go)
 * 4. Mock provider captures the system prompt sent to AI
 * 5. Verify failure info AND run session data appear in the system prompt
 *
 * Real: buildRetryTemplateVars, loadTemplate, runConversationLoop,
 *       loadRunSessionContext, formatRunSessionForPrompt, getRunPaths
 * Mocked: provider (captures system prompt), config, UI, session persistence
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
    actions: { execute: 'Execute', saveTask: 'Save', continue: 'Continue' },
  })),
}));

// --- Imports (after mocks) ---

import { getProvider } from '../infra/providers/index.js';
import { loadNdjsonLog } from '../infra/fs/session.js';
import {
  loadRunSessionContext,
  formatRunSessionForPrompt,
  getRunPaths,
} from '../features/interactive/runSessionReader.js';
import { runRetryMode, type RetryContext } from '../features/interactive/retryMode.js';

const mockGetProvider = vi.mocked(getProvider);
const mockLoadNdjsonLog = vi.mocked(loadNdjsonLog);

// --- Fixture helpers ---

function createTmpDir(): string {
  const dir = join(tmpdir(), `takt-retry-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createRunFixture(
  cwd: string,
  slug: string,
  overrides?: {
    meta?: Record<string, unknown>;
    reports?: Array<{ name: string; content: string }>;
  },
): void {
  const runDir = join(cwd, '.takt', 'runs', slug);
  mkdirSync(join(runDir, 'logs'), { recursive: true });
  mkdirSync(join(runDir, 'reports'), { recursive: true });

  const meta = {
    task: `Task for ${slug}`,
    piece: 'default',
    status: 'completed',
    startTime: '2026-02-01T00:00:00.000Z',
    logsDirectory: `.takt/runs/${slug}/logs`,
    reportDirectory: `.takt/runs/${slug}/reports`,
    runSlug: slug,
    ...overrides?.meta,
  };
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify(meta), 'utf-8');
  writeFileSync(join(runDir, 'logs', 'session-001.jsonl'), '{}', 'utf-8');

  for (const report of overrides?.reports ?? []) {
    writeFileSync(join(runDir, 'reports', report.name), report.content, 'utf-8');
  }
}

function setupMockNdjsonLog(history: Array<{ step: string; persona: string; status: string; content: string }>): void {
  mockLoadNdjsonLog.mockReturnValue({
    task: 'mock',
    projectDir: '',
    pieceName: 'default',
    iterations: history.length,
    startTime: '2026-02-01T00:00:00.000Z',
    status: 'completed',
    history: history.map((h) => ({
      ...h,
      instruction: '',
      timestamp: '2026-02-01T00:00:00.000Z',
    })),
  });
}

function setupProvider(responses: string[]): MockProviderCapture {
  const { provider, capture } = createMockProvider(responses);
  mockGetProvider.mockReturnValue(provider);
  return capture;
}

// --- Tests ---

describe('E2E: Retry mode with failure context injection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreStdin();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should inject failure info into system prompt', async () => {
    setupRawStdin(toRawInputs(['what went wrong?', '/go']));
    const capture = setupProvider([
      'The review step failed due to a timeout.',
      'Fix review timeout by increasing the limit.',
    ]);

    const retryContext: RetryContext = {
      failure: {
        taskName: 'implement-auth',
        createdAt: '2026-02-15T10:00:00Z',
        failedMovement: 'review',
        error: 'Timeout after 300s',
        lastMessage: 'Agent stopped responding',
        retryNote: '',
      },
      branchName: 'takt/implement-auth',
      pieceContext: {
        name: 'default',
        description: '',
        pieceStructure: '',
        movementPreviews: [],
      },
      run: null,
    };

    const result = await runRetryMode(tmpDir, retryContext);

    // Verify: system prompt contains failure information
    expect(capture.systemPrompts.length).toBeGreaterThan(0);
    const systemPrompt = capture.systemPrompts[0]!;
    expect(systemPrompt).toContain('Retry Assistant');
    expect(systemPrompt).toContain('implement-auth');
    expect(systemPrompt).toContain('takt/implement-auth');
    expect(systemPrompt).toContain('review');
    expect(systemPrompt).toContain('Timeout after 300s');
    expect(systemPrompt).toContain('Agent stopped responding');

    // Verify: flow completed
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Fix review timeout by increasing the limit.');
    expect(capture.callCount).toBe(2);
  });

  it('should inject failure info AND run session data into system prompt', async () => {
    // Create run fixture with logs and reports
    createRunFixture(tmpDir, 'run-failed', {
      meta: { task: 'Build login page', status: 'failed' },
      reports: [
        { name: '00-plan.md', content: '# Plan\n\nLogin form with OAuth2.' },
      ],
    });
    setupMockNdjsonLog([
      { step: 'plan', persona: 'architect', status: 'completed', content: 'Planned OAuth2 login flow' },
      { step: 'implement', persona: 'coder', status: 'failed', content: 'Failed at CSS compilation' },
    ]);

    // Load real run session data
    const sessionContext = loadRunSessionContext(tmpDir, 'run-failed');
    const formatted = formatRunSessionForPrompt(sessionContext);
    const paths = getRunPaths(tmpDir, 'run-failed');

    setupRawStdin(toRawInputs(['fix the CSS issue', '/go']));
    const capture = setupProvider([
      'The CSS compilation error is likely due to missing imports.',
      'Fix CSS imports in login component.',
    ]);

    const retryContext: RetryContext = {
      failure: {
        taskName: 'build-login',
        createdAt: '2026-02-15T14:00:00Z',
        failedMovement: 'implement',
        error: 'CSS compilation failed',
        lastMessage: 'PostCSS error: unknown property',
        retryNote: '',
      },
      branchName: 'takt/build-login',
      pieceContext: {
        name: 'default',
        description: '',
        pieceStructure: '',
        movementPreviews: [],
      },
      run: {
        logsDir: paths.logsDir,
        reportsDir: paths.reportsDir,
        task: formatted.runTask,
        piece: formatted.runPiece,
        status: formatted.runStatus,
        movementLogs: formatted.runMovementLogs,
        reports: formatted.runReports,
      },
    };

    const result = await runRetryMode(tmpDir, retryContext);

    // Verify: system prompt contains BOTH failure info and run session data
    const systemPrompt = capture.systemPrompts[0]!;

    // Failure info
    expect(systemPrompt).toContain('build-login');
    expect(systemPrompt).toContain('CSS compilation failed');
    expect(systemPrompt).toContain('PostCSS error: unknown property');
    expect(systemPrompt).toContain('implement');

    // Run session data
    expect(systemPrompt).toContain('Previous Run Data');
    expect(systemPrompt).toContain('Build login page');
    expect(systemPrompt).toContain('Planned OAuth2 login flow');
    expect(systemPrompt).toContain('Failed at CSS compilation');
    expect(systemPrompt).toContain('00-plan.md');
    expect(systemPrompt).toContain('Login form with OAuth2');

    // Run paths (AI can use Read tool)
    expect(systemPrompt).toContain(paths.logsDir);
    expect(systemPrompt).toContain(paths.reportsDir);

    // Flow completed
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Fix CSS imports in login component.');
  });

  it('should include existing retry note in system prompt', async () => {
    setupRawStdin(toRawInputs(['what should I do?', '/go']));
    const capture = setupProvider([
      'Based on the previous attempt, the mocks are still incomplete.',
      'Add complete mocks for all API endpoints.',
    ]);

    const retryContext: RetryContext = {
      failure: {
        taskName: 'fix-tests',
        createdAt: '2026-02-15T16:00:00Z',
        failedMovement: '',
        error: 'Test suite failed',
        lastMessage: '',
        retryNote: 'Previous attempt: added missing mocks but still failing',
      },
      branchName: 'takt/fix-tests',
      pieceContext: {
        name: 'default',
        description: '',
        pieceStructure: '',
        movementPreviews: [],
      },
      run: null,
    };

    await runRetryMode(tmpDir, retryContext);

    const systemPrompt = capture.systemPrompts[0]!;
    expect(systemPrompt).toContain('Existing Retry Note');
    expect(systemPrompt).toContain('Previous attempt: added missing mocks but still failing');

    // absent fields should NOT appear as sections
    expect(systemPrompt).not.toContain('Failed movement');
    expect(systemPrompt).not.toContain('Last Message');
  });

  it('should cancel cleanly and not crash', async () => {
    setupRawStdin(toRawInputs(['/cancel']));
    setupProvider([]);

    const retryContext: RetryContext = {
      failure: {
        taskName: 'some-task',
        createdAt: '2026-02-15T12:00:00Z',
        failedMovement: 'plan',
        error: 'Unknown error',
        lastMessage: '',
        retryNote: '',
      },
      branchName: 'takt/some-task',
      pieceContext: {
        name: 'default',
        description: '',
        pieceStructure: '',
        movementPreviews: [],
      },
      run: null,
    };

    const result = await runRetryMode(tmpDir, retryContext);

    expect(result.action).toBe('cancel');
    expect(result.task).toBe('');
  });

  it('should handle conversation before /go with failure context', async () => {
    setupRawStdin(toRawInputs([
      'what was the error?',
      'can you suggest a fix?',
      '/go',
    ]));
    const capture = setupProvider([
      'The error was a timeout in the review step.',
      'You could increase the timeout limit or optimize the review.',
      'Increase review timeout to 600s and add retry logic.',
    ]);

    const retryContext: RetryContext = {
      failure: {
        taskName: 'optimize-review',
        createdAt: '2026-02-15T18:00:00Z',
        failedMovement: 'review',
        error: 'Timeout',
        lastMessage: '',
        retryNote: '',
      },
      branchName: 'takt/optimize-review',
      pieceContext: {
        name: 'default',
        description: '',
        pieceStructure: '',
        movementPreviews: [],
      },
      run: null,
    };

    const result = await runRetryMode(tmpDir, retryContext);

    expect(result.action).toBe('execute');
    expect(result.task).toBe('Increase review timeout to 600s and add retry logic.');
    expect(capture.callCount).toBe(3);
  });
});
