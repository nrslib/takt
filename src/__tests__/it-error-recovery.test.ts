/**
 * Error recovery integration tests.
 *
 * Tests agent error, blocked responses, max iteration limits,
 * loop detection, scenario queue exhaustion, and movement execution exceptions.
 *
 * Mocked: UI, session, phase-runner, notifications, config, callAiJudge
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

// --- Mocks ---

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
  getDisabledBuiltins: vi.fn().mockReturnValue([]),
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
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-err-'));
  mkdirSync(join(dir, '.takt', 'reports', 'test-report-dir'), { recursive: true });

  const personasDir = join(dir, 'personas');
  mkdirSync(personasDir, { recursive: true });

  // Persona file names match movement names used in makeMovement()
  const agents = ['plan', 'implement', 'review', 'supervisor'];
  const agentPaths: Record<string, string> = {};
  for (const agent of agents) {
    const path = join(personasDir, `${agent}.md`);
    writeFileSync(path, `You are a ${agent} agent.`);
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

function buildPiece(agentPaths: Record<string, string>, maxMovements: number): PieceConfig {
  return {
    name: 'it-error',
    description: 'IT error recovery piece',
    maxMovements,
    initialMovement: 'plan',
    movements: [
      makeMovement('plan', agentPaths.plan, [
        makeRule('Requirements are clear', 'implement'),
        makeRule('Requirements unclear', 'ABORT'),
      ]),
      makeMovement('implement', agentPaths.implement, [
        makeRule('Implementation complete', 'review'),
        makeRule('Cannot proceed', 'plan'),
      ]),
      makeMovement('review', agentPaths.review, [
        makeRule('All checks passed', 'COMPLETE'),
        makeRule('Issues found', 'implement'),
      ]),
    ],
  };
}

describe('Error Recovery IT: agent blocked response', () => {
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

  it('should handle blocked agent response gracefully', async () => {
    setMockScenario([
      { persona: 'plan', status: 'blocked', content: 'Error: Agent is blocked.' },
    ]);

    const config = buildPiece(agentPaths, 10);
    const engine = new PieceEngine(config, testDir, 'Test task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const state = await engine.run();

    // Blocked agent should result in piece abort
    expect(state.status).toBe('aborted');
  });

  it('should handle empty content from agent', async () => {
    setMockScenario([
      { persona: 'plan', status: 'done', content: '' },
    ]);

    const config = buildPiece(agentPaths, 10);
    const engine = new PieceEngine(config, testDir, 'Test task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const state = await engine.run();

    // Empty content means no tag match; should eventually abort
    expect(['aborted', 'completed']).toContain(state.status);
  });
});

describe('Error Recovery IT: max iterations reached', () => {
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

  it('should abort when max iterations reached (tight limit)', async () => {
    // Only 2 iterations allowed, but piece needs 3 movements
    setMockScenario([
      { persona: 'plan', status: 'done', content: '[PLAN:1]\n\nClear.' },
      { persona: 'implement', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      { persona: 'review', status: 'done', content: '[REVIEW:1]\n\nPassed.' },
    ]);

    const config = buildPiece(agentPaths, 2);
    const engine = new PieceEngine(config, testDir, 'Task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBeLessThanOrEqual(2);
  });

  it('should abort when infinite plan → implement loop hits max', async () => {
    // plan → implement → plan → implement ...
    const loopScenario = Array.from({ length: 10 }, (_, i) => ({
      status: 'done' as const,
      content: i % 2 === 0 ? '[PLAN:1]\n\nClear.' : '[IMPLEMENT:2]\n\nCannot proceed.',
    }));
    setMockScenario(loopScenario);

    const config = buildPiece(agentPaths, 4);
    const engine = new PieceEngine(config, testDir, 'Looping task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBeLessThanOrEqual(4);
  });
});

describe('Error Recovery IT: scenario queue exhaustion', () => {
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

  it('should handle scenario queue exhaustion mid-piece', async () => {
    // Only 1 entry, but piece needs 3 movements
    setMockScenario([
      { persona: 'plan', status: 'done', content: '[PLAN:1]\n\nClear.' },
    ]);

    const config = buildPiece(agentPaths, 10);
    const engine = new PieceEngine(config, testDir, 'Task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    // Should not throw; mock client falls back to generic response when queue is empty
    const state = await engine.run();

    // Even with queue exhaustion, engine should reach some terminal state
    expect(['completed', 'aborted']).toContain(state.status);
  });
});

describe('Error Recovery IT: movement events on error paths', () => {
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

  it('should emit piece:abort event with reason on max iterations', async () => {
    const loopScenario = Array.from({ length: 6 }, (_, i) => ({
      status: 'done' as const,
      content: i % 2 === 0 ? '[PLAN:1]\n\nClear.' : '[IMPLEMENT:2]\n\nCannot proceed.',
    }));
    setMockScenario(loopScenario);

    const config = buildPiece(agentPaths, 3);
    const engine = new PieceEngine(config, testDir, 'Task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    let abortReason: string | undefined;
    engine.on('piece:abort', (_state, reason) => {
      abortReason = reason;
    });

    await engine.run();

    expect(abortReason).toBeDefined();
  });

  it('should emit movement:start and movement:complete for each executed movement before abort', async () => {
    setMockScenario([
      { persona: 'plan', status: 'done', content: '[PLAN:2]\n\nRequirements unclear.' },
    ]);

    const config = buildPiece(agentPaths, 10);
    const engine = new PieceEngine(config, testDir, 'Task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const startedSteps: string[] = [];
    const completedSteps: string[] = [];

    engine.on('movement:start', (step) => {
      startedSteps.push(step.name);
    });
    engine.on('movement:complete', (step) => {
      completedSteps.push(step.name);
    });

    await engine.run();

    expect(startedSteps).toEqual(['plan']);
    expect(completedSteps).toEqual(['plan']);
  });
});

describe('Error Recovery IT: programmatic abort', () => {
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

  it('should support engine.abort() to cancel running piece', async () => {
    // Provide enough scenarios for 3 steps
    setMockScenario([
      { persona: 'plan', status: 'done', content: '[PLAN:1]\n\nClear.' },
      { persona: 'implement', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      { persona: 'review', status: 'done', content: '[REVIEW:1]\n\nPassed.' },
    ]);

    const config = buildPiece(agentPaths, 10);
    const engine = new PieceEngine(config, testDir, 'Task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    // Abort after the first movement completes
    engine.on('movement:complete', () => {
      engine.abort();
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    // Should have aborted after 1 movement
    expect(state.iteration).toBeLessThanOrEqual(2);
  });
});
