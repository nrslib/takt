/**
 * E2E test: Run session loading → interactive instruct mode → prompt injection.
 *
 * Simulates the full interactive flow:
 * 1. Create .takt/runs/ fixtures on real file system
 * 2. Load run session with real listRecentRuns / loadRunSessionContext
 * 3. Run instruct mode with stdin simulation (user types message → /go)
 * 4. Mock provider captures the system prompt sent to AI
 * 5. Verify run session data appears in the system prompt
 *
 * Real: listRecentRuns, loadRunSessionContext, formatRunSessionForPrompt,
 *       loadTemplate, runConversationLoop (actual conversation loop)
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

// --- Mocks (infrastructure only, not core logic) ---

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
    intro: 'Instruct intro',
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
  listRecentRuns,
  loadRunSessionContext,
} from '../features/interactive/runSessionReader.js';
import { runInstructMode } from '../features/tasks/list/instructMode.js';

const mockGetProvider = vi.mocked(getProvider);
const mockLoadNdjsonLog = vi.mocked(loadNdjsonLog);

// --- Fixture helpers ---

function createTmpDir(): string {
  const dir = join(tmpdir(), `takt-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createRunFixture(
  cwd: string,
  slug: string,
  overrides?: {
    meta?: Record<string, unknown>;
    reports?: Array<{ name: string; content: string }>;
    emptyMeta?: boolean;
    corruptMeta?: boolean;
  },
): void {
  const runDir = join(cwd, '.takt', 'runs', slug);
  mkdirSync(join(runDir, 'logs'), { recursive: true });
  mkdirSync(join(runDir, 'reports'), { recursive: true });

  if (overrides?.emptyMeta) {
    writeFileSync(join(runDir, 'meta.json'), '', 'utf-8');
  } else if (overrides?.corruptMeta) {
    writeFileSync(join(runDir, 'meta.json'), '{ broken json', 'utf-8');
  } else {
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
  }

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

describe('E2E: Run session → instruct mode with interactive flow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreStdin();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should inject run session data into system prompt during interactive conversation', async () => {
    // Fixture: run with movement logs and reports
    createRunFixture(tmpDir, 'run-auth', {
      meta: { task: 'Implement JWT auth' },
      reports: [
        { name: '00-plan.md', content: '# Plan\n\nJWT auth with refresh tokens.' },
      ],
    });
    setupMockNdjsonLog([
      { step: 'plan', persona: 'architect', status: 'completed', content: 'Planned JWT auth flow' },
      { step: 'implement', persona: 'coder', status: 'completed', content: 'Created auth middleware' },
    ]);

    // Load run session (real code)
    const context = loadRunSessionContext(tmpDir, 'run-auth');

    // Simulate: user types "fix the token expiry" → /go → AI summarizes → user selects execute
    setupRawStdin(toRawInputs(['fix the token expiry', '/go']));
    const capture = setupProvider(['Sure, I can help with that.', 'Fix token expiry handling in auth middleware.']);

    const result = await runInstructMode(
      tmpDir,
      '## Branch: takt/fix-auth\n',
      'takt/fix-auth',
      'fix-auth',
      'Implement JWT auth',
      '',
      { name: 'default', description: '', pieceStructure: '', movementPreviews: [] },
      context,
    );

    // Verify: system prompt contains run session data
    expect(capture.systemPrompts.length).toBeGreaterThan(0);
    const systemPrompt = capture.systemPrompts[0]!;
    expect(systemPrompt).toContain('Previous Run Reference');
    expect(systemPrompt).toContain('Implement JWT auth');
    expect(systemPrompt).toContain('Planned JWT auth flow');
    expect(systemPrompt).toContain('Created auth middleware');
    expect(systemPrompt).toContain('00-plan.md');
    expect(systemPrompt).toContain('JWT auth with refresh tokens');

    // Verify: interactive flow completed with execute action
    expect(result.action).toBe('execute');
    expect(result.task).toBe('Fix token expiry handling in auth middleware.');

    // Verify: AI was called twice (user message + /go summary)
    expect(capture.callCount).toBe(2);
  });

  it('should produce system prompt without run section when no context', async () => {
    setupRawStdin(toRawInputs(['/cancel']));
    setupProvider([]);

    const result = await runInstructMode(tmpDir, '', 'takt/fix', 'fix', '', '', undefined, undefined);

    expect(result.action).toBe('cancel');
  });

  it('should cancel cleanly mid-conversation with run session', async () => {
    createRunFixture(tmpDir, 'run-1');
    setupMockNdjsonLog([]);

    const context = loadRunSessionContext(tmpDir, 'run-1');

    setupRawStdin(toRawInputs(['some thought', '/cancel']));
    const capture = setupProvider(['I understand.']);

    const result = await runInstructMode(
      tmpDir, '', 'takt/branch', 'branch', '', '', undefined, context,
    );

    expect(result.action).toBe('cancel');
    // AI was called once for "some thought", then /cancel exits
    expect(capture.callCount).toBe(1);
  });

  it('should skip empty and corrupt meta.json in listRecentRuns', () => {
    createRunFixture(tmpDir, 'valid-run');
    createRunFixture(tmpDir, 'empty-meta', { emptyMeta: true });
    createRunFixture(tmpDir, 'corrupt-meta', { corruptMeta: true });

    const runs = listRecentRuns(tmpDir);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.slug).toBe('valid-run');
  });

  it('should sort runs by startTime descending', () => {
    createRunFixture(tmpDir, 'old', { meta: { startTime: '2026-01-01T00:00:00Z' } });
    createRunFixture(tmpDir, 'new', { meta: { startTime: '2026-02-15T00:00:00Z' } });

    const runs = listRecentRuns(tmpDir);
    expect(runs[0]!.slug).toBe('new');
    expect(runs[1]!.slug).toBe('old');
  });

  it('should truncate long movement content to 500 chars', () => {
    createRunFixture(tmpDir, 'long');
    setupMockNdjsonLog([
      { step: 'implement', persona: 'coder', status: 'completed', content: 'X'.repeat(800) },
    ]);

    const context = loadRunSessionContext(tmpDir, 'long');
    expect(context.movementLogs[0]!.content.length).toBe(501);
    expect(context.movementLogs[0]!.content.endsWith('…')).toBe(true);
  });
});
