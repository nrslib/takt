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
import { detectRuleIndex } from '../shared/utils/ruleIndex.js';
import { callAiJudge } from '../agents/ai-judge.js';

// --- Mocks ---

vi.mock('../agents/ai-judge.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../agents/ai-judge.js')>();
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
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
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

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: vi.fn((_cwd: string, key: string) => {
    if (key === 'language') return 'en';
    if (key === 'enableBuiltinPieces') return true;
    if (key === 'disabledBuiltins') return [];
    return undefined;
  }),
  resolveConfigValues: vi.fn((_cwd: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === 'language') result[key] = 'en';
      if (key === 'enableBuiltinPieces') result[key] = true;
      if (key === 'disabledBuiltins') result[key] = [];
    }
    return result;
  }),
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

describe('Piece Patterns IT: default-mini piece', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should complete: plan → implement → reviewers (parallel: ai_review + supervise) → COMPLETE', async () => {
    const config = loadPiece('default-mini', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { persona: 'planner', status: 'done', content: 'Requirements are clear and implementation is possible.' },
      { persona: 'coder', status: 'done', content: 'Implementation complete.' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues.' },
      { persona: 'supervisor', status: 'done', content: 'All checks passed.' },
    ]);

    const engine = createEngine(config!, testDir, 'Test task');
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(3);
  });

  it('should ABORT when implement cannot proceed', async () => {
    const config = loadPiece('default-mini', testDir);

    setMockScenario([
      { persona: 'planner', status: 'done', content: 'Requirements are clear and implementation is possible.' },
      { persona: 'coder', status: 'done', content: 'Cannot proceed, insufficient info.' },
    ]);

    const engine = createEngine(config!, testDir, 'Vague task');
    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(2);
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
      { persona: 'planner', status: 'done', content: 'Requirements are clear and implementable' },
      { persona: 'architect-planner', status: 'done', content: 'Design complete' },
      { persona: 'coder', status: 'done', content: 'Implementation complete' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      // Parallel reviewers: both approved
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      // Supervisor
      { persona: 'supervisor', status: 'done', content: 'All checks passed' },
    ]);

    const engine = createEngine(config!, testDir, 'Test task');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });

  it('should route to fix when any("needs_fix") in parallel review step', async () => {
    const config = loadPiece('default', testDir);

    setMockScenario([
      { persona: 'planner', status: 'done', content: 'Requirements are clear and implementable' },
      { persona: 'architect-planner', status: 'done', content: 'Design complete' },
      { persona: 'coder', status: 'done', content: 'Implementation complete' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      // Parallel: arch approved, qa needs_fix
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'needs_fix' },
      // Fix step
      { persona: 'coder', status: 'done', content: 'Fix complete' },
      // AI review after fix
      { persona: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      // Re-review: both approved
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      // Supervisor
      { persona: 'supervisor', status: 'done', content: 'All checks passed' },
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
      { persona: 'research-planner', status: 'done', content: '[PLAN:1]\n\nPlanning is complete.' },
      { persona: 'research-digger', status: 'done', content: '[DIG:1]\n\nResearch is complete.' },
      { persona: 'research-supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAdequate.' },
    ]);

    const engine = createEngine(config!, testDir, 'Research topic X');
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(3);
  });

  it('should loop: plan → dig → supervise (insufficient) → plan → dig → supervise → COMPLETE', async () => {
    const config = loadPiece('research', testDir);

    setMockScenario([
      { persona: 'research-planner', status: 'done', content: '[PLAN:1]\n\nPlanning is complete.' },
      { persona: 'research-digger', status: 'done', content: '[DIG:1]\n\nResearch is complete.' },
      { persona: 'research-supervisor', status: 'done', content: '[SUPERVISE:2]\n\nInsufficient.' },
      // Second pass
      { persona: 'research-planner', status: 'done', content: '[PLAN:1]\n\nRevised plan.' },
      { persona: 'research-digger', status: 'done', content: '[DIG:1]\n\nMore research.' },
      { persona: 'research-supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAdequate now.' },
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
      { persona: 'melchior', status: 'done', content: '[MELCHIOR:1]\n\nJudgment completed.' },
      { persona: 'balthasar', status: 'done', content: '[BALTHASAR:1]\n\nJudgment completed.' },
      { persona: 'casper', status: 'done', content: '[CASPER:1]\n\nFinal judgment completed.' },
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
      { persona: 'planner', status: 'done', content: '[PLAN:1]\n\nReview scope is clear.' },
      // Parallel reviewers: all approved
      { persona: 'architecture-reviewer', status: 'done', content: '[ARCH-REVIEW:1]\n\napproved' },
      { persona: 'security-reviewer', status: 'done', content: '[SECURITY-REVIEW:1]\n\napproved' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: '[AI-REVIEW:1]\n\napproved' },
      // Supervisor: approved (local review, no PR)
      { persona: 'supervisor', status: 'done', content: '[SUPERVISE:2]\n\napproved' },
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
      { persona: 'planner', status: 'done', content: '[PLAN:1]\n\nClear.' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: '[AI_REVIEW:1]\n\nNo issues.' },
      // 4 parallel reviewers
      { persona: 'architecture-reviewer', status: 'done', content: '[ARCH-REVIEW:1]\n\napproved' },
      { persona: 'frontend-reviewer', status: 'done', content: '[FRONTEND-REVIEW:1]\n\napproved' },
      { persona: 'security-reviewer', status: 'done', content: '[SECURITY-REVIEW:1]\n\napproved' },
      { persona: 'qa-reviewer', status: 'done', content: '[QA-REVIEW:1]\n\napproved' },
      // Supervisor
      { persona: 'expert-supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll validations pass.' },
    ]);

    const engine = createEngine(config!, testDir, 'Expert review task');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });
});
