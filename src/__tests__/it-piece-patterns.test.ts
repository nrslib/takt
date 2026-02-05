/**
 * Piece patterns integration tests.
 *
 * Tests that all builtin piece definitions can be loaded and execute
 * the expected step transitions using PieceEngine + MockProvider + ScenarioQueue.
 *
 * Mocked: UI, session, phase-runner, notifications, config, callAiJudge
 * Not mocked: PieceEngine, runAgent, detectMatchedRule, rule-evaluator
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';
import { callAiJudge, detectRuleIndex } from '../infra/claude/index.js';

// --- Mocks ---

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

vi.mock('../core/piece/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue(''),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  generateSessionId: vi.fn().mockReturnValue('test-session-id'),
}));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn().mockReturnValue({}),
  getLanguage: vi.fn().mockReturnValue('en'),
  getDisabledBuiltins: vi.fn().mockReturnValue([]),
  getBuiltinPiecesEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/config/project/projectConfig.js', () => ({
  loadProjectConfig: vi.fn().mockReturnValue({}),
}));

// --- Imports (after mocks) ---

import { PieceEngine } from '../core/piece/index.js';
import { loadPiece } from '../infra/config/index.js';
import type { PieceConfig } from '../core/models/index.js';

// --- Test helpers ---

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-wfp-'));
  mkdirSync(join(dir, '.takt', 'reports', 'test-report-dir'), { recursive: true });
  return dir;
}

function createEngine(config: PieceConfig, dir: string, task: string): PieceEngine {
  return new PieceEngine(config, dir, task, {
    projectCwd: dir,
    provider: 'mock',
    detectRuleIndex,
    callAiJudge,
  });
}

describe('Piece Patterns IT: minimal piece', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should complete: implement → reviewers (parallel: ai_review + supervise) → COMPLETE', async () => {
    const config = loadPiece('minimal', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { agent: 'coder', status: 'done', content: 'Implementation complete.' },
      { agent: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues.' },
      { agent: 'supervisor', status: 'done', content: 'All checks passed.' },
    ]);

    const engine = createEngine(config!, testDir, 'Test task');
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(2);
  });

  it('should ABORT when implement cannot proceed', async () => {
    const config = loadPiece('minimal', testDir);

    setMockScenario([
      { agent: 'coder', status: 'done', content: 'Cannot proceed, insufficient info.' },
    ]);

    const engine = createEngine(config!, testDir, 'Vague task');
    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(1);
  });

});

describe('Piece Patterns IT: default piece (parallel reviewers)', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should complete with all("approved") in parallel review step', async () => {
    const config = loadPiece('default', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { agent: 'planner', status: 'done', content: 'Requirements are clear and implementable' },
      { agent: 'architect', status: 'done', content: 'Design complete' },
      { agent: 'coder', status: 'done', content: 'Implementation complete' },
      { agent: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      // Parallel reviewers: both approved
      { agent: 'architecture-reviewer', status: 'done', content: 'approved' },
      { agent: 'qa-reviewer', status: 'done', content: 'approved' },
      // Supervisor
      { agent: 'supervisor', status: 'done', content: 'All checks passed' },
    ]);

    const engine = createEngine(config!, testDir, 'Test task');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });

  it('should route to fix when any("needs_fix") in parallel review step', async () => {
    const config = loadPiece('default', testDir);

    setMockScenario([
      { agent: 'planner', status: 'done', content: 'Requirements are clear and implementable' },
      { agent: 'architect', status: 'done', content: 'Design complete' },
      { agent: 'coder', status: 'done', content: 'Implementation complete' },
      { agent: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      // Parallel: arch approved, qa needs_fix
      { agent: 'architecture-reviewer', status: 'done', content: 'approved' },
      { agent: 'qa-reviewer', status: 'done', content: 'needs_fix' },
      // Fix step
      { agent: 'coder', status: 'done', content: 'Fix complete' },
      // AI review after fix
      { agent: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      // Re-review: both approved
      { agent: 'architecture-reviewer', status: 'done', content: 'approved' },
      { agent: 'qa-reviewer', status: 'done', content: 'approved' },
      // Supervisor
      { agent: 'supervisor', status: 'done', content: 'All checks passed' },
    ]);

    const engine = createEngine(config!, testDir, 'Task needing QA fix');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });
});

describe('Piece Patterns IT: research piece', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should complete: plan → dig → supervise → COMPLETE', async () => {
    const config = loadPiece('research', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { agent: 'research/planner', status: 'done', content: '[PLAN:1]\n\nPlanning is complete.' },
      { agent: 'research/digger', status: 'done', content: '[DIG:1]\n\nResearch is complete.' },
      { agent: 'research/supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAdequate.' },
    ]);

    const engine = createEngine(config!, testDir, 'Research topic X');
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(3);
  });

  it('should loop: plan → dig → supervise (insufficient) → plan → dig → supervise → COMPLETE', async () => {
    const config = loadPiece('research', testDir);

    setMockScenario([
      { agent: 'research/planner', status: 'done', content: '[PLAN:1]\n\nPlanning is complete.' },
      { agent: 'research/digger', status: 'done', content: '[DIG:1]\n\nResearch is complete.' },
      { agent: 'research/supervisor', status: 'done', content: '[SUPERVISE:2]\n\nInsufficient.' },
      // Second pass
      { agent: 'research/planner', status: 'done', content: '[PLAN:1]\n\nRevised plan.' },
      { agent: 'research/digger', status: 'done', content: '[DIG:1]\n\nMore research.' },
      { agent: 'research/supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAdequate now.' },
    ]);

    const engine = createEngine(config!, testDir, 'Research topic X');
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(6);
  });
});

describe('Piece Patterns IT: magi piece', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should complete: melchior → balthasar → casper → COMPLETE', async () => {
    const config = loadPiece('magi', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { agent: 'magi/melchior', status: 'done', content: '[MELCHIOR:1]\n\nJudgment completed.' },
      { agent: 'magi/balthasar', status: 'done', content: '[BALTHASAR:1]\n\nJudgment completed.' },
      { agent: 'magi/casper', status: 'done', content: '[CASPER:1]\n\nFinal judgment completed.' },
    ]);

    const engine = createEngine(config!, testDir, 'Deliberation topic');
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(3);
  });
});

describe('Piece Patterns IT: review-only piece', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should complete: plan → reviewers (all approved) → supervise → COMPLETE', async () => {
    const config = loadPiece('review-only', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { agent: 'planner', status: 'done', content: '[PLAN:1]\n\nReview scope is clear.' },
      // Parallel reviewers: all approved
      { agent: 'architecture-reviewer', status: 'done', content: '[ARCH-REVIEW:1]\n\napproved' },
      { agent: 'security-reviewer', status: 'done', content: '[SECURITY-REVIEW:1]\n\napproved' },
      { agent: 'ai-antipattern-reviewer', status: 'done', content: '[AI-REVIEW:1]\n\napproved' },
      // Supervisor: approved (local review, no PR)
      { agent: 'supervisor', status: 'done', content: '[SUPERVISE:2]\n\napproved' },
    ]);

    const engine = createEngine(config!, testDir, 'Review the codebase');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });

  it('should verify no movements have edit: true', () => {
    const config = loadPiece('review-only', testDir);
    expect(config).not.toBeNull();

    for (const movement of config!.movements) {
      expect(movement.edit).not.toBe(true);
      if (movement.parallel) {
        for (const subMovement of movement.parallel) {
          expect(subMovement.edit).not.toBe(true);
        }
      }
    }
  });
});

describe('Piece Patterns IT: expert piece (4 parallel reviewers)', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should complete with all("approved") in 4-parallel review', async () => {
    const config = loadPiece('expert', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { agent: 'planner', status: 'done', content: '[PLAN:1]\n\nClear.' },
      { agent: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      { agent: 'ai-antipattern-reviewer', status: 'done', content: '[AI_REVIEW:1]\n\nNo issues.' },
      // 4 parallel reviewers
      { agent: 'architecture-reviewer', status: 'done', content: '[ARCH-REVIEW:1]\n\napproved' },
      { agent: 'expert/frontend-reviewer', status: 'done', content: '[FRONTEND-REVIEW:1]\n\napproved' },
      { agent: 'expert/security-reviewer', status: 'done', content: '[SECURITY-REVIEW:1]\n\napproved' },
      { agent: 'expert/qa-reviewer', status: 'done', content: '[QA-REVIEW:1]\n\napproved' },
      // Supervisor
      { agent: 'expert/supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll validations pass.' },
    ]);

    const engine = createEngine(config!, testDir, 'Expert review task');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });
});
