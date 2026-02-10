/**
 * Three-phase execution integration tests.
 *
 * Tests Phase 1 (main) → Phase 2 (report) → Phase 3 (status judgment) lifecycle.
 * Verifies that the correct combination of phases fires based on movement config.
 *
 * Mocked: UI, session, config, callAiJudge
 * Selectively mocked: phase-runner (to inspect call patterns)
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

const mockNeedsStatusJudgmentPhase = vi.fn();
const mockRunReportPhase = vi.fn();
const mockRunStatusJudgmentPhase = vi.fn();

vi.mock('../core/piece/phase-runner.js', () => ({
  needsStatusJudgmentPhase: (...args: unknown[]) => mockNeedsStatusJudgmentPhase(...args),
  runReportPhase: (...args: unknown[]) => mockRunReportPhase(...args),
  runStatusJudgmentPhase: (...args: unknown[]) => mockRunStatusJudgmentPhase(...args),
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

function createTestEnv(): { dir: string; agentPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-3ph-'));
  mkdirSync(join(dir, '.takt', 'reports', 'test-report-dir'), { recursive: true });

  const agentsDir = join(dir, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const agentPath = join(agentsDir, 'agent.md');
  writeFileSync(agentPath, 'You are an agent.');

  return { dir, agentPath };
}

function buildEngineOptions(projectCwd: string) {
  return {
    projectCwd,
    detectRuleIndex,
    callAiJudge,
  };
}

function makeMovement(
  name: string,
  agentPath: string,
  rules: PieceRule[],
  options: { outputContracts?: { label: string; path: string }[]; edit?: boolean } = {},
): PieceMovement {
  return {
    name,
    persona: './agents/agent.md',
    personaDisplayName: name,
    personaPath: agentPath,
    instructionTemplate: '{task}',
    passPreviousResponse: true,
    rules,
    outputContracts: options.outputContracts,
    edit: options.edit,
  };
}

describe('Three-Phase Execution IT: phase1 only (no report, no tag rules)', () => {
  let testDir: string;
  let agentPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const env = createTestEnv();
    testDir = env.dir;
    agentPath = env.agentPath;

    // No tag rules needed → Phase 3 not needed
    mockNeedsStatusJudgmentPhase.mockReturnValue(false);
    mockRunReportPhase.mockResolvedValue(undefined);
    mockRunStatusJudgmentPhase.mockResolvedValue('');
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should only run Phase 1 when movement has no report and no tag rules', async () => {
    setMockScenario([
      { status: 'done', content: '[STEP:1]\n\nDone.' },
    ]);

    const config: PieceConfig = {
      name: 'it-phase1-only',
      description: 'Test',
      maxMovements: 5,
      initialMovement: 'step',
      movements: [
        makeMovement('step', agentPath, [
          makeRule('Done', 'COMPLETE'),
          makeRule('Not done', 'ABORT'),
        ]),
      ],
    };

    const engine = new PieceEngine(config, testDir, 'Test task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(mockRunReportPhase).not.toHaveBeenCalled();
    // needsStatusJudgmentPhase is called but returns false
    expect(mockRunStatusJudgmentPhase).not.toHaveBeenCalled();
  });
});

describe('Three-Phase Execution IT: phase1 + phase2 (report defined)', () => {
  let testDir: string;
  let agentPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const env = createTestEnv();
    testDir = env.dir;
    agentPath = env.agentPath;

    mockNeedsStatusJudgmentPhase.mockReturnValue(false);
    mockRunReportPhase.mockResolvedValue(undefined);
    mockRunStatusJudgmentPhase.mockResolvedValue('');
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should run Phase 1 + Phase 2 when movement has report', async () => {
    setMockScenario([
      { status: 'done', content: '[STEP:1]\n\nDone.' },
    ]);

    const config: PieceConfig = {
      name: 'it-phase1-2',
      description: 'Test',
      maxMovements: 5,
      initialMovement: 'step',
      movements: [
        makeMovement('step', agentPath, [
          makeRule('Done', 'COMPLETE'),
          makeRule('Not done', 'ABORT'),
        ], { outputContracts: [{ label: 'test', path: 'test-report.md' }] }),
      ],
    };

    const engine = new PieceEngine(config, testDir, 'Test task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(mockRunReportPhase).toHaveBeenCalledTimes(1);
    expect(mockRunStatusJudgmentPhase).not.toHaveBeenCalled();
  });

  it('should run Phase 2 for multi-report movement', async () => {
    setMockScenario([
      { status: 'done', content: '[STEP:1]\n\nDone.' },
    ]);

    const config: PieceConfig = {
      name: 'it-phase1-2-multi',
      description: 'Test',
      maxMovements: 5,
      initialMovement: 'step',
      movements: [
        makeMovement('step', agentPath, [
          makeRule('Done', 'COMPLETE'),
        ], { outputContracts: [{ label: 'Scope', path: 'scope.md' }, { label: 'Decisions', path: 'decisions.md' }] }),
      ],
    };

    const engine = new PieceEngine(config, testDir, 'Test task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(mockRunReportPhase).toHaveBeenCalledTimes(1);
  });
});

describe('Three-Phase Execution IT: phase1 + phase3 (tag rules defined)', () => {
  let testDir: string;
  let agentPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const env = createTestEnv();
    testDir = env.dir;
    agentPath = env.agentPath;

    mockNeedsStatusJudgmentPhase.mockReturnValue(true);
    mockRunReportPhase.mockResolvedValue(undefined);
    // Phase 3 returns content with a tag
    mockRunStatusJudgmentPhase.mockResolvedValue('[STEP:1]');
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should run Phase 1 + Phase 3 when movement has tag-based rules but no report', async () => {
    setMockScenario([
      // Phase 1: main content (no tag — Phase 3 will provide it)
      { status: 'done', content: 'Agent completed the work.' },
    ]);

    const config: PieceConfig = {
      name: 'it-phase1-3',
      description: 'Test',
      maxMovements: 5,
      initialMovement: 'step',
      movements: [
        makeMovement('step', agentPath, [
          makeRule('Done', 'COMPLETE'),
          makeRule('Not done', 'ABORT'),
        ]),
      ],
    };

    const engine = new PieceEngine(config, testDir, 'Test task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(mockRunReportPhase).not.toHaveBeenCalled();
    expect(mockRunStatusJudgmentPhase).toHaveBeenCalledTimes(1);
  });
});

describe('Three-Phase Execution IT: all three phases', () => {
  let testDir: string;
  let agentPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const env = createTestEnv();
    testDir = env.dir;
    agentPath = env.agentPath;

    mockNeedsStatusJudgmentPhase.mockReturnValue(true);
    mockRunReportPhase.mockResolvedValue(undefined);
    mockRunStatusJudgmentPhase.mockResolvedValue('[STEP:1]');
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should run Phase 1 → Phase 2 → Phase 3 when movement has report and tag rules', async () => {
    setMockScenario([
      { status: 'done', content: 'Agent completed the work.' },
    ]);

    const config: PieceConfig = {
      name: 'it-all-phases',
      description: 'Test',
      maxMovements: 5,
      initialMovement: 'step',
      movements: [
        makeMovement('step', agentPath, [
          makeRule('Done', 'COMPLETE'),
          makeRule('Not done', 'ABORT'),
        ], { outputContracts: [{ label: 'test', path: 'test-report.md' }] }),
      ],
    };

    const engine = new PieceEngine(config, testDir, 'Test task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(mockRunReportPhase).toHaveBeenCalledTimes(1);
    expect(mockRunStatusJudgmentPhase).toHaveBeenCalledTimes(1);

    // Verify ordering: report phase is called before status judgment
    const reportCallOrder = mockRunReportPhase.mock.invocationCallOrder[0];
    const judgmentCallOrder = mockRunStatusJudgmentPhase.mock.invocationCallOrder[0];
    expect(reportCallOrder).toBeLessThan(judgmentCallOrder);
  });
});

describe('Three-Phase Execution IT: phase3 tag → rule match', () => {
  let testDir: string;
  let agentPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const env = createTestEnv();
    testDir = env.dir;
    agentPath = env.agentPath;

    mockNeedsStatusJudgmentPhase.mockReturnValue(true);
    mockRunReportPhase.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should use Phase 3 tag for rule matching over Phase 1 content', async () => {
    // Phase 1 content has no tag → fallback
    setMockScenario([
      { status: 'done', content: 'Work done.' },
      { status: 'done', content: '[STEP2:1]\n\nChecked.' },
    ]);

    // Phase 3 returns rule 2 (ABORT)
    mockRunStatusJudgmentPhase.mockResolvedValue('[STEP1:2]');

    const config: PieceConfig = {
      name: 'it-phase3-tag',
      description: 'Test',
      maxMovements: 5,
      initialMovement: 'step1',
      movements: [
        makeMovement('step1', agentPath, [
          makeRule('Done', 'step2'),
          makeRule('Not done', 'ABORT'),
        ]),
        makeMovement('step2', agentPath, [
          makeRule('Checked', 'COMPLETE'),
        ]),
      ],
    };

    const engine = new PieceEngine(config, testDir, 'Test task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const state = await engine.run();

    // Phase 3 returned [STEP1:2] → rule index 1 → "Not done" → ABORT
    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(1);
  });
});
