/**
 * Piece execution integration tests.
 *
 * Tests PieceEngine with real runAgent + MockProvider + ScenarioQueue.
 * No vi.mock on runAgent or detectMatchedRule — rules are matched via
 * [MOVEMENT_NAME:N] tags in scenario content (tag-based detection).
 *
 * Mocked: UI, session, phase-runner (report/judgment phases), notifications, config
 * Not mocked: PieceEngine, runAgent, detectMatchedRule, rule-evaluator
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';
import type { PieceConfig, PieceMovement, PieceRule } from '../core/models/index.js';
import { detectRuleIndex } from '../infra/claude/index.js';
import { callAiJudge } from '../agents/ai-judge.js';

// --- Mocks (minimal — only infrastructure, not core logic) ---

// Safety net: prevent callAiJudge from calling real agent.
// Tag-based detection should always match in these tests; if it doesn't,
// this mock surfaces the failure immediately instead of timing out.
vi.mock('../agents/ai-judge.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../agents/ai-judge.js')>();
  return {
    ...original,
    callAiJudge: vi.fn().mockResolvedValue(-1),
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
  getBuiltinPiecesEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/config/project/projectConfig.js', () => ({
  loadProjectConfig: vi.fn().mockReturnValue({}),
}));

// --- Imports (after mocks) ---

import { PieceEngine } from '../core/piece/index.js';

// --- Test helpers ---

function makeRule(condition: string, next: string): PieceRule {
  return { condition, next };
}

function makeMovement(name: string, agentPath: string, rules: PieceRule[]): PieceMovement {
  return {
    name,
    persona: `./personas/${name}.md`,
    personaDisplayName: name,
    personaPath: agentPath,
    instructionTemplate: '{task}',
    passPreviousResponse: true,
    rules,
  };
}

function createTestEnv(): { dir: string; agentPaths: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-wf-'));
  mkdirSync(join(dir, '.takt', 'reports', 'test-report-dir'), { recursive: true });

  const personasDir = join(dir, 'personas');
  mkdirSync(personasDir, { recursive: true });

  const agents = ['planner', 'coder', 'reviewer', 'fixer', 'supervisor'];
  const agentPaths: Record<string, string> = {};
  for (const agent of agents) {
    const path = join(personasDir, `${agent}.md`);
    writeFileSync(path, `You are a ${agent}.`);
    agentPaths[agent] = path;
  }

  return { dir, agentPaths };
}

function buildEngineOptions(projectCwd: string) {
  return {
    projectCwd,
    detectRuleIndex,
    callAiJudge,
  };
}

function buildSimplePiece(agentPaths: Record<string, string>): PieceConfig {
  return {
    name: 'it-simple',
    description: 'IT simple piece',
    maxMovements: 15,
    initialMovement: 'plan',
    movements: [
      makeMovement('plan', agentPaths.planner, [
        makeRule('Requirements are clear', 'implement'),
        makeRule('Requirements unclear', 'ABORT'),
      ]),
      makeMovement('implement', agentPaths.coder, [
        makeRule('Implementation complete', 'review'),
        makeRule('Cannot proceed', 'plan'),
      ]),
      makeMovement('review', agentPaths.reviewer, [
        makeRule('All checks passed', 'COMPLETE'),
        makeRule('Issues found', 'implement'),
      ]),
    ],
  };
}

function buildLoopPiece(agentPaths: Record<string, string>): PieceConfig {
  return {
    name: 'it-loop',
    description: 'IT piece with fix loop',
    maxMovements: 20,
    initialMovement: 'plan',
    movements: [
      makeMovement('plan', agentPaths.planner, [
        makeRule('Requirements are clear', 'implement'),
        makeRule('Requirements unclear', 'ABORT'),
      ]),
      makeMovement('implement', agentPaths.coder, [
        makeRule('Implementation complete', 'review'),
        makeRule('Cannot proceed', 'plan'),
      ]),
      makeMovement('review', agentPaths.reviewer, [
        makeRule('Approved', 'supervise'),
        makeRule('Needs fix', 'fix'),
      ]),
      makeMovement('fix', agentPaths.fixer, [
        makeRule('Fix complete', 'review'),
        makeRule('Cannot fix', 'ABORT'),
      ]),
      makeMovement('supervise', agentPaths.supervisor, [
        makeRule('All checks passed', 'COMPLETE'),
        makeRule('Requirements unmet', 'plan'),
      ]),
    ],
  };
}

describe('Piece Engine IT: Happy Path', () => {
  let testDir: string;
  let agentPaths: Record<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    const env = createTestEnv();
    testDir = env.dir;
    agentPaths = env.agentPaths;
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should complete: plan → implement → review → COMPLETE', async () => {
    setMockScenario([
      { persona: 'plan', status: 'done', content: '[PLAN:1]\n\nRequirements are clear.' },
      { persona: 'implement', status: 'done', content: '[IMPLEMENT:1]\n\nImplementation complete.' },
      { persona: 'review', status: 'done', content: '[REVIEW:1]\n\nAll checks passed.' },
    ]);

    const config = buildSimplePiece(agentPaths);
    const engine = new PieceEngine(config, testDir, 'Test task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(3);
  });

  it('should ABORT when plan returns rule 2', async () => {
    setMockScenario([
      { persona: 'plan', status: 'done', content: '[PLAN:2]\n\nRequirements unclear.' },
    ]);

    const config = buildSimplePiece(agentPaths);
    const engine = new PieceEngine(config, testDir, 'Vague task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(1);
  });
});

describe('Piece Engine IT: Fix Loop', () => {
  let testDir: string;
  let agentPaths: Record<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    const env = createTestEnv();
    testDir = env.dir;
    agentPaths = env.agentPaths;
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should handle review → fix → review → supervise → COMPLETE', async () => {
    setMockScenario([
      { persona: 'plan', status: 'done', content: '[PLAN:1]\n\nClear.' },
      { persona: 'implement', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      // First review: needs fix
      { persona: 'review', status: 'done', content: '[REVIEW:2]\n\nNeeds fix.' },
      // Fix
      { persona: 'fix', status: 'done', content: '[FIX:1]\n\nFix complete.' },
      // Second review: approved
      { persona: 'review', status: 'done', content: '[REVIEW:1]\n\nApproved.' },
      // Supervise
      { persona: 'supervise', status: 'done', content: '[SUPERVISE:1]\n\nAll checks passed.' },
    ]);

    const config = buildLoopPiece(agentPaths);
    const engine = new PieceEngine(config, testDir, 'Task needing fix', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(6);
  });

  it('should ABORT if fix fails', async () => {
    setMockScenario([
      { persona: 'plan', status: 'done', content: '[PLAN:1]\n\nClear.' },
      { persona: 'implement', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      { persona: 'review', status: 'done', content: '[REVIEW:2]\n\nNeeds fix.' },
      { persona: 'fix', status: 'done', content: '[FIX:2]\n\nCannot fix.' },
    ]);

    const config = buildLoopPiece(agentPaths);
    const engine = new PieceEngine(config, testDir, 'Unfixable task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
  });
});

describe('Piece Engine IT: Max Iterations', () => {
  let testDir: string;
  let agentPaths: Record<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    const env = createTestEnv();
    testDir = env.dir;
    agentPaths = env.agentPaths;
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should abort when maxMovements exceeded in infinite loop', async () => {
    // Create an infinite loop: plan always goes to implement, implement always goes back to plan
    const infiniteScenario = Array.from({ length: 10 }, (_, i) => ({
      status: 'done' as const,
      content: i % 2 === 0 ? '[PLAN:1]\n\nClear.' : '[IMPLEMENT:2]\n\nCannot proceed.',
    }));
    setMockScenario(infiniteScenario);

    const config = buildSimplePiece(agentPaths);
    config.maxMovements = 5;

    const engine = new PieceEngine(config, testDir, 'Looping task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBeLessThanOrEqual(5);
  });
});

describe('Piece Engine IT: Movement Output Tracking', () => {
  let testDir: string;
  let agentPaths: Record<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    const env = createTestEnv();
    testDir = env.dir;
    agentPaths = env.agentPaths;
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should track movement outputs through events', async () => {
    setMockScenario([
      { persona: 'plan', status: 'done', content: '[PLAN:1]\n\nPlan output.' },
      { persona: 'implement', status: 'done', content: '[IMPLEMENT:1]\n\nImplement output.' },
      { persona: 'review', status: 'done', content: '[REVIEW:1]\n\nReview output.' },
    ]);

    const config = buildSimplePiece(agentPaths);
    const engine = new PieceEngine(config, testDir, 'Track outputs', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const completedMovements: string[] = [];
    engine.on('movement:complete', (movement) => {
      completedMovements.push(movement.name);
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(completedMovements).toEqual(['plan', 'implement', 'review']);
  });
});
