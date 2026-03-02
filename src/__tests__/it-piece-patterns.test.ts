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

describe('Piece Patterns IT: default piece (happy path)', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should complete: plan → write_tests → implement → ai_review → reviewers (parallel: arch-review + supervise) → COMPLETE', async () => {
    const config = loadPiece('default', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { persona: 'planner', status: 'done', content: 'Requirements are clear and implementable' },
      { persona: 'coder', status: 'done', content: 'Tests written successfully' },
      { persona: 'coder', status: 'done', content: 'Implementation complete' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'supervisor', status: 'done', content: 'All checks passed' },
    ]);

    const engine = createEngine(config!, testDir, 'Test task');
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(5);
  });

  it('should route implement → ai_review even when implement cannot proceed', async () => {
    const config = loadPiece('default', testDir);

    setMockScenario([
      { persona: 'planner', status: 'done', content: 'Requirements are clear and implementable' },
      { persona: 'coder', status: 'done', content: 'Tests written successfully' },
      { persona: 'coder', status: 'done', content: 'Cannot proceed, insufficient info' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'supervisor', status: 'done', content: 'All checks passed' },
    ]);

    const engine = createEngine(config!, testDir, 'Vague task');
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(5);
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
      { persona: 'coder', status: 'done', content: 'Tests written successfully' },
      { persona: 'coder', status: 'done', content: 'Implementation complete' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      // Parallel reviewers: all approved
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      { persona: 'testing-reviewer', status: 'done', content: 'approved' },
      // Supervisor
      { persona: 'supervisor', status: 'done', content: 'All checks passed' },
    ]);

    const engine = createEngine(config!, testDir, 'Test task');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });

  it('should continue to implement when tests cannot be written because target is not implemented', async () => {
    const config = loadPiece('default', testDir);

    setMockScenario([
      { persona: 'planner', status: 'done', content: 'Requirements are clear and implementable' },
      { persona: 'coder', status: 'done', content: 'Cannot proceed because the test target is not implemented yet, so skip test writing' },
      { persona: 'coder', status: 'done', content: 'Implementation complete' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      { persona: 'testing-reviewer', status: 'done', content: 'approved' },
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
      { persona: 'coder', status: 'done', content: 'Tests written successfully' },
      { persona: 'coder', status: 'done', content: 'Implementation complete' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      // Parallel: arch approved, qa needs_fix, testing approved
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'needs_fix' },
      { persona: 'testing-reviewer', status: 'done', content: 'approved' },
      // Fix step
      { persona: 'coder', status: 'done', content: 'Fix complete' },
      // Re-review: all approved
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      { persona: 'testing-reviewer', status: 'done', content: 'approved' },
      // Supervisor
      { persona: 'supervisor', status: 'done', content: 'All checks passed' },
    ]);

    const engine = createEngine(config!, testDir, 'Task needing QA fix');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });
});

describe('Piece Patterns IT: default piece (write_tests skip path)', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should continue to implement when tests cannot be written because target is not implemented', async () => {
    const config = loadPiece('default', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { persona: 'planner', status: 'done', content: 'Requirements are clear and implementable' },
      { persona: 'coder', status: 'done', content: 'Cannot proceed because the test target is not implemented yet, so skip test writing' },
      { persona: 'coder', status: 'done', content: 'Implementation complete' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'supervisor', status: 'done', content: 'All checks passed' },
    ]);

    const engine = createEngine(config!, testDir, 'Test task');
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

describe('Piece Patterns IT: review piece', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should complete: gather → reviewers (all approved) → supervise → COMPLETE', async () => {
    const config = loadPiece('review', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { persona: 'planner', status: 'done', content: '[GATHER:1]\n\nPR info gathered.' },
      // Parallel reviewers: all approved (5 reviewers)
      { persona: 'architecture-reviewer', status: 'done', content: '[ARCH-REVIEW:1]\n\napproved' },
      { persona: 'security-reviewer', status: 'done', content: '[SECURITY-REVIEW:1]\n\napproved' },
      { persona: 'qa-reviewer', status: 'done', content: '[QA-REVIEW:1]\n\napproved' },
      { persona: 'testing-reviewer', status: 'done', content: '[TESTING-REVIEW:1]\n\napproved' },
      { persona: 'requirements-reviewer', status: 'done', content: '[REQUIREMENTS-REVIEW:1]\n\napproved' },
      // Supervisor: synthesis complete
      { persona: 'supervisor', status: 'done', content: '[SUPERVISE:1]\n\nReview synthesis complete' },
    ]);

    const engine = createEngine(config!, testDir, 'Review PR #42');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });

  it('should verify no movements have edit: true', () => {
    const config = loadPiece('review', testDir);
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

describe('Piece Patterns IT: dual piece (4 parallel reviewers)', () => {
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
    const config = loadPiece('dual', testDir);
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
      { persona: 'dual-supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll validations pass.' },
    ]);

    const engine = createEngine(config!, testDir, 'Dual review task');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });
});

describe('Piece Patterns IT: review-fix piece', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('happy path: gather → reviewers (all approved) → supervise → COMPLETE', async () => {
    const config = loadPiece('review-fix', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { persona: 'planner', status: 'done', content: '[GATHER:1]\n\nReview target gathered.' },
      // 5 parallel reviewers: all approved
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'security-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      { persona: 'testing-reviewer', status: 'done', content: 'approved' },
      { persona: 'requirements-reviewer', status: 'done', content: 'approved' },
      // Supervisor: ready to merge
      { persona: 'supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll validations complete, ready to merge.' },
    ]);

    const engine = createEngine(config!, testDir, 'Review PR #1');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });

  it('fix loop: reviewers any("needs_fix") → fix → reviewers (all approved) → supervise → COMPLETE', async () => {
    const config = loadPiece('review-fix', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { persona: 'planner', status: 'done', content: '[GATHER:1]\n\nReview target gathered.' },
      // 5 parallel reviewers: security needs_fix
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'security-reviewer', status: 'done', content: 'needs_fix' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      { persona: 'testing-reviewer', status: 'done', content: 'approved' },
      { persona: 'requirements-reviewer', status: 'done', content: 'approved' },
      // Fix
      { persona: 'coder', status: 'done', content: '[FIX:1]\n\nFixes complete.' },
      // Re-review: all approved
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'security-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      { persona: 'testing-reviewer', status: 'done', content: 'approved' },
      { persona: 'requirements-reviewer', status: 'done', content: 'approved' },
      // Supervisor
      { persona: 'supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll validations complete, ready to merge.' },
    ]);

    const engine = createEngine(config!, testDir, 'Review PR #2');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });

  it('fix_supervisor path: supervise detects issues → fix_supervisor → supervise → COMPLETE', async () => {
    const config = loadPiece('review-fix', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { persona: 'planner', status: 'done', content: '[GATHER:1]\n\nReview target gathered.' },
      // 5 parallel reviewers: all approved
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'security-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      { persona: 'testing-reviewer', status: 'done', content: 'approved' },
      { persona: 'requirements-reviewer', status: 'done', content: 'approved' },
      // Supervisor: issues detected → fix_supervisor
      { persona: 'supervisor', status: 'done', content: '[SUPERVISE:2]\n\nIssues detected.' },
      // fix_supervisor: fixes complete → back to supervise
      { persona: 'coder', status: 'done', content: '[FIX_SUPERVISOR:1]\n\nFixes for supervisor findings complete.' },
      // Supervisor: ready to merge
      { persona: 'supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll validations complete, ready to merge.' },
    ]);

    const engine = createEngine(config!, testDir, 'Review PR #3');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });
});

describe('Piece Patterns IT: frontend-review-fix piece (fix loop)', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('fix loop: reviewers any("needs_fix") → fix → reviewers (all approved) → supervise → COMPLETE', async () => {
    const config = loadPiece('frontend-review-fix', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { persona: 'planner', status: 'done', content: '[GATHER:1]\n\nReview target gathered.' },
      // 4 parallel reviewers: frontend needs_fix
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'frontend-reviewer', status: 'done', content: 'needs_fix' },
      { persona: 'security-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      // Fix
      { persona: 'coder', status: 'done', content: '[FIX:1]\n\nFixes complete.' },
      // Re-review: all approved
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'frontend-reviewer', status: 'done', content: 'approved' },
      { persona: 'security-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      // Supervisor
      { persona: 'dual-supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll validations complete, ready to merge.' },
    ]);

    const engine = createEngine(config!, testDir, 'Review frontend PR');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });
});

describe('Piece Patterns IT: backend-review-fix piece (fix loop)', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('fix loop: reviewers any("needs_fix") → fix → reviewers (all approved) → supervise → COMPLETE', async () => {
    const config = loadPiece('backend-review-fix', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { persona: 'planner', status: 'done', content: '[GATHER:1]\n\nReview target gathered.' },
      // 3 parallel reviewers: security needs_fix
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'security-reviewer', status: 'done', content: 'needs_fix' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      // Fix
      { persona: 'coder', status: 'done', content: '[FIX:1]\n\nFixes complete.' },
      // Re-review: all approved
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'security-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      // Supervisor
      { persona: 'dual-supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll validations complete, ready to merge.' },
    ]);

    const engine = createEngine(config!, testDir, 'Review backend PR');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });
});

describe('Piece Patterns IT: dual-review-fix piece (fix loop)', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('fix loop: reviewers any("needs_fix") → fix → reviewers (all approved) → supervise → COMPLETE', async () => {
    const config = loadPiece('dual-review-fix', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { persona: 'planner', status: 'done', content: '[GATHER:1]\n\nReview target gathered.' },
      // 4 parallel reviewers: qa needs_fix
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'frontend-reviewer', status: 'done', content: 'approved' },
      { persona: 'security-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'needs_fix' },
      // Fix
      { persona: 'coder', status: 'done', content: '[FIX:1]\n\nFixes complete.' },
      // Re-review: all approved
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'frontend-reviewer', status: 'done', content: 'approved' },
      { persona: 'security-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      // Supervisor
      { persona: 'dual-supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll validations complete, ready to merge.' },
    ]);

    const engine = createEngine(config!, testDir, 'Review dual PR');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });
});

describe('Piece Patterns IT: dual-cqrs-review-fix piece (fix loop)', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('fix loop: reviewers any("needs_fix") → fix → reviewers (all approved) → supervise → COMPLETE', async () => {
    const config = loadPiece('dual-cqrs-review-fix', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { persona: 'planner', status: 'done', content: '[GATHER:1]\n\nReview target gathered.' },
      // 5 parallel reviewers: cqrs-es needs_fix
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'cqrs-es-reviewer', status: 'done', content: 'needs_fix' },
      { persona: 'frontend-reviewer', status: 'done', content: 'approved' },
      { persona: 'security-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      // Fix
      { persona: 'coder', status: 'done', content: '[FIX:1]\n\nFixes complete.' },
      // Re-review: all approved
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'cqrs-es-reviewer', status: 'done', content: 'approved' },
      { persona: 'frontend-reviewer', status: 'done', content: 'approved' },
      { persona: 'security-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      // Supervisor
      { persona: 'dual-supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll validations complete, ready to merge.' },
    ]);

    const engine = createEngine(config!, testDir, 'Review CQRS dual PR');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });
});

describe('Piece Patterns IT: backend-cqrs-review-fix piece (fix loop)', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('fix loop: reviewers any("needs_fix") → fix → reviewers (all approved) → supervise → COMPLETE', async () => {
    const config = loadPiece('backend-cqrs-review-fix', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { persona: 'planner', status: 'done', content: '[GATHER:1]\n\nReview target gathered.' },
      // 4 parallel reviewers: cqrs-es needs_fix
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'cqrs-es-reviewer', status: 'done', content: 'needs_fix' },
      { persona: 'security-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      // Fix
      { persona: 'coder', status: 'done', content: '[FIX:1]\n\nFixes complete.' },
      // Re-review: all approved
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'cqrs-es-reviewer', status: 'done', content: 'approved' },
      { persona: 'security-reviewer', status: 'done', content: 'approved' },
      { persona: 'qa-reviewer', status: 'done', content: 'approved' },
      // Supervisor
      { persona: 'dual-supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll validations complete, ready to merge.' },
    ]);

    const engine = createEngine(config!, testDir, 'Review backend CQRS PR');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });
});
