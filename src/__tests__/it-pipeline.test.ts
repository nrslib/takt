/**
 * Pipeline integration tests.
 *
 * Uses mock provider + scenario queue for end-to-end testing
 * of the pipeline execution flow. Git operations are skipped via --skip-git.
 *
 * Mocked: git operations (child_process), GitHub API, UI output, notifications, session
 * Not mocked: executeTask, executePiece, PieceEngine, runAgent, rule evaluation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';

// --- Mocks ---

// Safety net: prevent callAiJudge from calling real Claude CLI.
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

// Git operations (even with --skip-git, some imports need to be available)
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../infra/github/issue.js', () => ({
  fetchIssue: vi.fn(),
  formatIssueAsTask: vi.fn(),
  checkGhCli: vi.fn(),
}));

vi.mock('../infra/github/pr.js', () => ({
  createPullRequest: vi.fn(),
  pushBranch: vi.fn(),
  buildPrBody: vi.fn().mockReturnValue('PR body'),
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

// --- Test helpers ---

/** Create a minimal test piece YAML + agent files in a temp directory */
function createTestPieceDir(): { dir: string; piecePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-pipeline-'));

  // Create .takt/runs structure
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'reports'), { recursive: true });

  // Create persona prompt files
  const personasDir = join(dir, 'personas');
  mkdirSync(personasDir, { recursive: true });
  writeFileSync(join(personasDir, 'planner.md'), 'You are a planner. Analyze the task.');
  writeFileSync(join(personasDir, 'coder.md'), 'You are a coder. Implement the task.');
  writeFileSync(join(personasDir, 'reviewer.md'), 'You are a reviewer. Review the code.');

  // Create a simple piece YAML
  const pieceYaml = `
name: it-simple
description: Integration test piece
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

describe('Pipeline Integration Tests', () => {
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

  it('should complete pipeline with piece path + skip-git + mock scenario', async () => {
    // Scenario: plan -> implement -> review -> COMPLETE
    // persona field must match extractPersonaName(movement.persona), i.e., the .md filename without extension
    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:1]\n\nPlan completed. Requirements are clear.' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nImplementation complete.' },
      { persona: 'reviewer', status: 'done', content: '[REVIEW:1]\n\nAll checks passed.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Add a hello world function',
      piece: piecePath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
  });

  it('should complete pipeline with piece name + skip-git + mock scenario', async () => {
    // Use builtin 'minimal' piece
    // persona field: extractPersonaName result (from .md filename)
    // tag in content: [MOVEMENT_NAME:N] where MOVEMENT_NAME is the movement name uppercased
    setMockScenario([
      { persona: 'coder', status: 'done', content: 'Implementation complete' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      { persona: 'supervisor', status: 'done', content: 'All checks passed' },
    ]);

    const exitCode = await executePipeline({
      task: 'Add a hello world function',
      piece: 'minimal',
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
  });

  it('should return EXIT_PIECE_FAILED for non-existent piece', async () => {
    const exitCode = await executePipeline({
      task: 'Test task',
      piece: 'non-existent-piece-xyz',
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    // executeTask returns false when piece not found → executePipeline returns EXIT_PIECE_FAILED (3)
    expect(exitCode).toBe(3);
  });

  it('should handle ABORT transition from piece', async () => {
    // Scenario: plan returns second rule -> ABORT
    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:2]\n\nRequirements unclear, insufficient info.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Vague task with no details',
      piece: piecePath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    // ABORT means piece failed -> EXIT_PIECE_FAILED (3)
    expect(exitCode).toBe(3);
  });

  it('should handle review reject → implement → review loop', async () => {
    setMockScenario([
      // First pass
      { persona: 'planner', status: 'done', content: '[PLAN:1]\n\nRequirements are clear.' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      { persona: 'reviewer', status: 'done', content: '[REVIEW:2]\n\nIssues found.' },
      // Fix loop
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nFixed.' },
      { persona: 'reviewer', status: 'done', content: '[REVIEW:1]\n\nAll checks passed.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Task needing a fix',
      piece: piecePath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
  });
});
