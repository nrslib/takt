/**
 * Tests: session loading behavior in executePiece().
 *
 * Normal runs pass empty sessions to PieceEngine;
 * retry runs (startMovement / retryNote) load persisted sessions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PieceConfig } from '../core/models/index.js';

const { MockPieceEngine, mockLoadPersonaSessions, mockLoadWorktreeSessions } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');

  const mockLoadPersonaSessions = vi.fn().mockReturnValue({ coder: 'saved-session-id' });
  const mockLoadWorktreeSessions = vi.fn().mockReturnValue({ coder: 'worktree-session-id' });

  class MockPieceEngine extends EE {
    static lastInstance: MockPieceEngine;
    readonly receivedOptions: Record<string, unknown>;

    constructor(config: PieceConfig, _cwd: string, _task: string, options: Record<string, unknown>) {
      super();
      this.receivedOptions = options;
      MockPieceEngine.lastInstance = this;
    }

    abort(): void {}

    async run(): Promise<{ status: string; iteration: number }> {
      this.emit('piece:complete', { status: 'completed', iteration: 1 });
      return { status: 'completed', iteration: 1 };
    }
  }

  return { MockPieceEngine, mockLoadPersonaSessions, mockLoadWorktreeSessions };
});

vi.mock('../core/piece/index.js', () => ({
  PieceEngine: MockPieceEngine,
}));

vi.mock('../infra/claude/index.js', () => ({
  detectRuleIndex: vi.fn(),
  interruptAllQueries: vi.fn(),
}));

vi.mock('../agents/ai-judge.js', () => ({
  callAiJudge: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  loadPersonaSessions: mockLoadPersonaSessions,
  updatePersonaSession: vi.fn(),
  loadWorktreeSessions: mockLoadWorktreeSessions,
  updateWorktreeSession: vi.fn(),
  loadGlobalConfig: vi.fn().mockReturnValue({ provider: 'claude' }),
  saveSessionState: vi.fn(),
  ensureDir: vi.fn(),
  writeFileAtomic: vi.fn(),
}));

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn().mockReturnValue(true),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
  StreamDisplay: vi.fn().mockImplementation(() => ({
    createHandler: vi.fn().mockReturnValue(vi.fn()),
    flush: vi.fn(),
  })),
}));

vi.mock('../infra/fs/index.js', () => ({
  generateSessionId: vi.fn().mockReturnValue('test-session-id'),
  createSessionLog: vi.fn().mockReturnValue({
    startTime: new Date().toISOString(),
    iterations: 0,
  }),
  finalizeSessionLog: vi.fn().mockImplementation((log, status) => ({
    ...log,
    status,
    endTime: new Date().toISOString(),
  })),
  initNdjsonLog: vi.fn().mockReturnValue('/tmp/test-log.jsonl'),
  appendNdjsonLine: vi.fn(),
}));

vi.mock('../shared/utils/index.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  preventSleep: vi.fn(),
  isDebugEnabled: vi.fn().mockReturnValue(false),
  writePromptLog: vi.fn(),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  isValidReportDirName: vi.fn().mockReturnValue(true),
  playWarningSound: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(),
  promptInput: vi.fn(),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn().mockImplementation((key: string) => key),
}));

vi.mock('../shared/exitCodes.js', () => ({
  EXIT_SIGINT: 130,
}));

import { executePiece } from '../features/tasks/execute/pieceExecution.js';

function makeConfig(): PieceConfig {
  return {
    name: 'test-piece',
    maxMovements: 5,
    initialMovement: 'implement',
    movements: [
      {
        name: 'implement',
        persona: '../agents/coder.md',
        personaDisplayName: 'coder',
        instructionTemplate: 'Implement task',
        passPreviousResponse: true,
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
  };
}

describe('executePiece session loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadPersonaSessions.mockReturnValue({ coder: 'saved-session-id' });
    mockLoadWorktreeSessions.mockReturnValue({ coder: 'worktree-session-id' });
  });

  it('should pass empty initialSessions on normal run', async () => {
    // Given: normal execution (no startMovement, no retryNote)
    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    // Then: PieceEngine receives empty sessions
    expect(mockLoadPersonaSessions).not.toHaveBeenCalled();
    expect(mockLoadWorktreeSessions).not.toHaveBeenCalled();
    expect(MockPieceEngine.lastInstance.receivedOptions.initialSessions).toEqual({});
  });

  it('should load persisted sessions when startMovement is set (retry)', async () => {
    // Given: retry execution with startMovement
    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      startMovement: 'implement',
    });

    // Then: loadPersonaSessions is called to load saved sessions
    expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/tmp/project', 'claude');
  });

  it('should load persisted sessions when retryNote is set (retry)', async () => {
    // Given: retry execution with retryNote
    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      retryNote: 'Fix the failing test',
    });

    // Then: loadPersonaSessions is called to load saved sessions
    expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/tmp/project', 'claude');
  });

  it('should load worktree sessions on retry when cwd differs from projectCwd', async () => {
    // Given: retry execution in a worktree (cwd !== projectCwd)
    await executePiece(makeConfig(), 'task', '/tmp/worktree', {
      projectCwd: '/tmp/project',
      startMovement: 'implement',
    });

    // Then: loadWorktreeSessions is called instead of loadPersonaSessions
    expect(mockLoadWorktreeSessions).toHaveBeenCalledWith('/tmp/project', '/tmp/worktree', 'claude');
    expect(mockLoadPersonaSessions).not.toHaveBeenCalled();
  });

  it('should not load sessions for worktree normal run', async () => {
    // Given: normal execution in a worktree (no retry)
    await executePiece(makeConfig(), 'task', '/tmp/worktree', {
      projectCwd: '/tmp/project',
    });

    // Then: neither session loader is called
    expect(mockLoadPersonaSessions).not.toHaveBeenCalled();
    expect(mockLoadWorktreeSessions).not.toHaveBeenCalled();
  });

  it('should load sessions when both startMovement and retryNote are set', async () => {
    // Given: retry with both flags
    await executePiece(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      startMovement: 'implement',
      retryNote: 'Fix issue',
    });

    // Then: sessions are loaded
    expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/tmp/project', 'claude');
  });
});
