/**
 * Pipeline execution mode integration tests.
 *
 * Tests various --pipeline mode option combinations including:
 * - --task, --issue, --skip-git, --auto-pr, --piece (name/path), --provider, --model
 * - Exit codes for different failure scenarios
 *
 * Mocked: git (child_process), GitHub API, UI, notifications, session, phase-runner, config
 * Not mocked: executePipeline, executeTask, PieceEngine, runAgent, rule evaluation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';

// --- Mocks ---

const {
  mockFetchIssue,
  mockFormatIssueAsTask,
  mockCheckGhCli,
  mockCreatePullRequest,
  mockPushBranch,
} = vi.hoisted(() => ({
  mockFetchIssue: vi.fn(),
  mockFormatIssueAsTask: vi.fn(),
  mockCheckGhCli: vi.fn(),
  mockCreatePullRequest: vi.fn(),
  mockPushBranch: vi.fn(),
}));

vi.mock('../infra/claude/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/claude/client.js')>();
  return {
    ...original,
    callAiJudge: vi.fn().mockImplementation(async (content: string, conditions: { index: number; text: string }[]) => {
      // Simple text matching: return index of first condition whose text appears in content
      for (let i = 0; i < conditions.length; i++) {
        if (content.includes(conditions[i]!.text)) {
          return i;
        }
      }
      return -1;
    }),
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../infra/github/issue.js', () => ({
  fetchIssue: mockFetchIssue,
  formatIssueAsTask: mockFormatIssueAsTask,
  checkGhCli: mockCheckGhCli,
}));

vi.mock('../infra/github/pr.js', () => ({
  createPullRequest: mockCreatePullRequest,
  pushBranch: mockPushBranch,
  buildPrBody: vi.fn().mockReturnValue('PR body'),
}));

vi.mock('../infra/task/git.js', () => ({
  stageAndCommit: vi.fn().mockReturnValue('abc1234'),
  getCurrentBranch: vi.fn().mockReturnValue('main'),
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
    createHandler: () => vi.fn(),
    flush: vi.fn(),
  })),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateSessionId: vi.fn().mockReturnValue('test-session-id'),
  createSessionLog: vi.fn().mockReturnValue({
    startTime: new Date().toISOString(),
    iterations: 0,
  }),
  finalizeSessionLog: vi.fn().mockImplementation((log, status) => ({ ...log, status })),
  initNdjsonLog: vi.fn().mockReturnValue('/tmp/test.ndjson'),
  appendNdjsonLine: vi.fn(),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/config/paths.js')>();
  return {
    ...original,
    loadPersonaSessions: vi.fn().mockReturnValue({}),
    updatePersonaSession: vi.fn(),
    loadWorktreeSessions: vi.fn().mockReturnValue({}),
    updateWorktreeSession: vi.fn(),
    getCurrentPiece: vi.fn().mockReturnValue('default'),
    getProjectConfigDir: vi.fn().mockImplementation((cwd: string) => join(cwd, '.takt')),
  };
});

vi.mock('../infra/config/global/globalConfig.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/config/global/globalConfig.js')>();
  return {
    ...original,
    loadGlobalConfig: vi.fn().mockReturnValue({}),
    getLanguage: vi.fn().mockReturnValue('en'),
    getDisabledBuiltins: vi.fn().mockReturnValue([]),
  };
});

vi.mock('../infra/config/project/projectConfig.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/config/project/projectConfig.js')>();
  return {
    ...original,
    loadProjectConfig: vi.fn().mockReturnValue({}),
  };
});

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn().mockReturnValue(true),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn().mockResolvedValue('stop'),
  promptInput: vi.fn().mockResolvedValue(null),
}));

vi.mock('../core/piece/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue(''),
}));

// --- Imports (after mocks) ---

import { executePipeline } from '../features/pipeline/index.js';
import {
  EXIT_ISSUE_FETCH_FAILED,
  EXIT_PIECE_FAILED,
  EXIT_PR_CREATION_FAILED,
} from '../shared/exitCodes.js';

// --- Test helpers ---

function createTestPieceDir(): { dir: string; piecePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-pm-'));
  mkdirSync(join(dir, '.takt', 'reports', 'test-report-dir'), { recursive: true });

  const personasDir = join(dir, 'personas');
  mkdirSync(personasDir, { recursive: true });
  writeFileSync(join(personasDir, 'planner.md'), 'You are a planner.');
  writeFileSync(join(personasDir, 'coder.md'), 'You are a coder.');
  writeFileSync(join(personasDir, 'reviewer.md'), 'You are a reviewer.');

  const pieceYaml = `
name: it-pipeline
description: Pipeline test piece
max_iterations: 10
initial_movement: plan

movements:
  - name: plan
    persona: ./personas/planner.md
    rules:
      - condition: Requirements are clear
        next: implement
      - condition: Requirements unclear
        next: ABORT
    instruction: "{task}"

  - name: implement
    persona: ./personas/coder.md
    rules:
      - condition: Implementation complete
        next: review
      - condition: Cannot proceed
        next: plan
    instruction: "{task}"

  - name: review
    persona: ./personas/reviewer.md
    rules:
      - condition: All checks passed
        next: COMPLETE
      - condition: Issues found
        next: implement
    instruction: "{task}"
`;

  const piecePath = join(dir, 'piece.yaml');
  writeFileSync(piecePath, pieceYaml);

  return { dir, piecePath };
}

function happyScenario(): void {
  setMockScenario([
    { persona: 'planner', status: 'done', content: '[PLAN:1]\n\nRequirements are clear.' },
    { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nImplementation complete.' },
    { persona: 'reviewer', status: 'done', content: '[REVIEW:1]\n\nAll checks passed.' },
  ]);
}

describe('Pipeline Modes IT: --task + --piece path', () => {
  let testDir: string;
  let piecePath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const setup = createTestPieceDir();
    testDir = setup.dir;
    piecePath = setup.piecePath;
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return exit code 0 on successful pipeline', async () => {
    happyScenario();

    const exitCode = await executePipeline({
      task: 'Add a feature',
      piece: piecePath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
  });

  it('should return EXIT_PIECE_FAILED (3) on ABORT', async () => {
    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:2]\n\nRequirements unclear.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Vague task',
      piece: piecePath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(EXIT_PIECE_FAILED);
  });
});

describe('Pipeline Modes IT: --task + --piece name (builtin)', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const setup = createTestPieceDir();
    testDir = setup.dir;
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load and execute builtin minimal piece by name', async () => {
    setMockScenario([
      { persona: 'coder', status: 'done', content: 'Implementation complete' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      { persona: 'supervisor', status: 'done', content: 'All checks passed' },
    ]);

    const exitCode = await executePipeline({
      task: 'Add a feature',
      piece: 'minimal',
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
  });

  it('should return EXIT_PIECE_FAILED for non-existent piece name', async () => {
    const exitCode = await executePipeline({
      task: 'Test task',
      piece: 'non-existent-piece-xyz',
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(EXIT_PIECE_FAILED);
  });
});

describe('Pipeline Modes IT: --issue', () => {
  let testDir: string;
  let piecePath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const setup = createTestPieceDir();
    testDir = setup.dir;
    piecePath = setup.piecePath;
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should fetch issue and execute piece', async () => {
    mockCheckGhCli.mockReturnValue({ available: true });
    mockFetchIssue.mockReturnValue({
      number: 42,
      title: 'Fix the bug',
      body: 'Details here',
    });
    mockFormatIssueAsTask.mockReturnValue('Fix the bug\n\nDetails here');
    happyScenario();

    const exitCode = await executePipeline({
      issueNumber: 42,
      piece: piecePath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
    expect(mockFetchIssue).toHaveBeenCalledWith(42);
  });

  it('should return EXIT_ISSUE_FETCH_FAILED when gh CLI unavailable', async () => {
    mockCheckGhCli.mockReturnValue({ available: false, error: 'gh not found' });

    const exitCode = await executePipeline({
      issueNumber: 42,
      piece: piecePath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(EXIT_ISSUE_FETCH_FAILED);
  });

  it('should return EXIT_ISSUE_FETCH_FAILED when issue fetch throws', async () => {
    mockCheckGhCli.mockReturnValue({ available: true });
    mockFetchIssue.mockImplementation(() => {
      throw new Error('Issue not found');
    });

    const exitCode = await executePipeline({
      issueNumber: 999,
      piece: piecePath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(EXIT_ISSUE_FETCH_FAILED);
  });

  it('should return EXIT_ISSUE_FETCH_FAILED when neither --issue nor --task specified', async () => {
    const exitCode = await executePipeline({
      piece: piecePath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(EXIT_ISSUE_FETCH_FAILED);
  });
});

describe('Pipeline Modes IT: --auto-pr', () => {
  let testDir: string;
  let piecePath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const setup = createTestPieceDir();
    testDir = setup.dir;
    piecePath = setup.piecePath;
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should create PR on success when --auto-pr is set (without --skip-git)', async () => {
    happyScenario();
    mockCreatePullRequest.mockReturnValue({ success: true, url: 'https://github.com/test/pr/1' });

    const exitCode = await executePipeline({
      task: 'Add a feature',
      piece: piecePath,
      autoPr: true,
      skipGit: false,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
    expect(mockCreatePullRequest).toHaveBeenCalled();
  });

  it('should return EXIT_PR_CREATION_FAILED when PR creation fails', async () => {
    happyScenario();
    mockCreatePullRequest.mockReturnValue({ success: false, error: 'Rate limited' });

    const exitCode = await executePipeline({
      task: 'Add a feature',
      piece: piecePath,
      autoPr: true,
      skipGit: false,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(EXIT_PR_CREATION_FAILED);
  });

  it('should skip PR creation when --auto-pr and --skip-git are both set', async () => {
    happyScenario();

    const exitCode = await executePipeline({
      task: 'Add a feature',
      piece: piecePath,
      autoPr: true,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });
});

describe('Pipeline Modes IT: --provider and --model overrides', () => {
  let testDir: string;
  let piecePath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const setup = createTestPieceDir();
    testDir = setup.dir;
    piecePath = setup.piecePath;
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should pass provider override to piece execution', async () => {
    happyScenario();

    const exitCode = await executePipeline({
      task: 'Test task',
      piece: piecePath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
  });

  it('should pass model override to piece execution', async () => {
    happyScenario();

    const exitCode = await executePipeline({
      task: 'Test task',
      piece: piecePath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
      model: 'opus',
    });

    expect(exitCode).toBe(0);
  });
});

describe('Pipeline Modes IT: review → fix loop', () => {
  let testDir: string;
  let piecePath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const setup = createTestPieceDir();
    testDir = setup.dir;
    piecePath = setup.piecePath;
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should handle review → implement → review loop', async () => {
    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:1]\n\nClear.' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      // First review: issues found → back to implement
      { persona: 'reviewer', status: 'done', content: '[REVIEW:2]\n\nIssues found.' },
      // Fix
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nFixed.' },
      // Second review: passed
      { persona: 'reviewer', status: 'done', content: '[REVIEW:1]\n\nAll checks passed.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Task with fix loop',
      piece: piecePath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
  });
});
