/**
 * Error recovery integration tests.
 *
 * Tests agent error, blocked responses, max iteration limits,
 * loop detection, scenario queue exhaustion, and step execution exceptions.
 *
 * Mocked: UI, session, phase-runner, notifications, config, callAiJudge
 * Not mocked: WorkflowEngine, runAgent, detectMatchedRule, rule-evaluator
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';
import type { WorkflowConfig, WorkflowStep, WorkflowRule } from '../core/models/index.js';
import { callAiJudge, detectRuleIndex } from '../infra/claude/index.js';

// --- Mocks ---

vi.mock('../infra/claude/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/claude/client.js')>();
  return {
    ...original,
    callAiJudge: vi.fn().mockResolvedValue(-1),
  };
});

vi.mock('../core/workflow/phase-runner.js', () => ({
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
  getBuiltinWorkflowsEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/config/project/projectConfig.js', () => ({
  loadProjectConfig: vi.fn().mockReturnValue({}),
}));

// --- Imports (after mocks) ---

import { WorkflowEngine } from '../core/workflow/index.js';

// --- Test helpers ---

function makeRule(condition: string, next: string): WorkflowRule {
  return { condition, next };
}

function makeStep(name: string, agentPath: string, rules: WorkflowRule[]): WorkflowStep {
  return {
    name,
    agent: `./agents/${name}.md`,
    agentDisplayName: name,
    agentPath,
    instructionTemplate: '{task}',
    passPreviousResponse: true,
    rules,
  };
}

function createTestEnv(): { dir: string; agentPaths: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-err-'));
  mkdirSync(join(dir, '.takt', 'reports', 'test-report-dir'), { recursive: true });

  const agentsDir = join(dir, 'agents');
  mkdirSync(agentsDir, { recursive: true });

  // Agent file names match step names used in makeStep()
  const agents = ['plan', 'implement', 'review', 'supervisor'];
  const agentPaths: Record<string, string> = {};
  for (const agent of agents) {
    const path = join(agentsDir, `${agent}.md`);
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

function buildWorkflow(agentPaths: Record<string, string>, maxIterations: number): WorkflowConfig {
  return {
    name: 'it-error',
    description: 'IT error recovery workflow',
    maxIterations,
    initialStep: 'plan',
    steps: [
      makeStep('plan', agentPaths.plan, [
        makeRule('Requirements are clear', 'implement'),
        makeRule('Requirements unclear', 'ABORT'),
      ]),
      makeStep('implement', agentPaths.implement, [
        makeRule('Implementation complete', 'review'),
        makeRule('Cannot proceed', 'plan'),
      ]),
      makeStep('review', agentPaths.review, [
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
      { agent: 'plan', status: 'blocked', content: 'Error: Agent is blocked.' },
    ]);

    const config = buildWorkflow(agentPaths, 10);
    const engine = new WorkflowEngine(config, testDir, 'Test task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const state = await engine.run();

    // Blocked agent should result in workflow abort
    expect(state.status).toBe('aborted');
  });

  it('should handle empty content from agent', async () => {
    setMockScenario([
      { agent: 'plan', status: 'done', content: '' },
    ]);

    const config = buildWorkflow(agentPaths, 10);
    const engine = new WorkflowEngine(config, testDir, 'Test task', {
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
    // Only 2 iterations allowed, but workflow needs 3 steps
    setMockScenario([
      { agent: 'plan', status: 'done', content: '[PLAN:1]\n\nClear.' },
      { agent: 'implement', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      { agent: 'review', status: 'done', content: '[REVIEW:1]\n\nPassed.' },
    ]);

    const config = buildWorkflow(agentPaths, 2);
    const engine = new WorkflowEngine(config, testDir, 'Task', {
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

    const config = buildWorkflow(agentPaths, 4);
    const engine = new WorkflowEngine(config, testDir, 'Looping task', {
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

  it('should handle scenario queue exhaustion mid-workflow', async () => {
    // Only 1 entry, but workflow needs 3 steps
    setMockScenario([
      { agent: 'plan', status: 'done', content: '[PLAN:1]\n\nClear.' },
    ]);

    const config = buildWorkflow(agentPaths, 10);
    const engine = new WorkflowEngine(config, testDir, 'Task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    // Should not throw; mock client falls back to generic response when queue is empty
    const state = await engine.run();

    // Even with queue exhaustion, engine should reach some terminal state
    expect(['completed', 'aborted']).toContain(state.status);
  });
});

describe('Error Recovery IT: step events on error paths', () => {
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

  it('should emit workflow:abort event with reason on max iterations', async () => {
    const loopScenario = Array.from({ length: 6 }, (_, i) => ({
      status: 'done' as const,
      content: i % 2 === 0 ? '[PLAN:1]\n\nClear.' : '[IMPLEMENT:2]\n\nCannot proceed.',
    }));
    setMockScenario(loopScenario);

    const config = buildWorkflow(agentPaths, 3);
    const engine = new WorkflowEngine(config, testDir, 'Task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    let abortReason: string | undefined;
    engine.on('workflow:abort', (_state, reason) => {
      abortReason = reason;
    });

    await engine.run();

    expect(abortReason).toBeDefined();
  });

  it('should emit step:start and step:complete for each executed step before abort', async () => {
    setMockScenario([
      { agent: 'plan', status: 'done', content: '[PLAN:2]\n\nRequirements unclear.' },
    ]);

    const config = buildWorkflow(agentPaths, 10);
    const engine = new WorkflowEngine(config, testDir, 'Task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    const startedSteps: string[] = [];
    const completedSteps: string[] = [];

    engine.on('step:start', (step) => {
      startedSteps.push(step.name);
    });
    engine.on('step:complete', (step) => {
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

  it('should support engine.abort() to cancel running workflow', async () => {
    // Provide enough scenarios for 3 steps
    setMockScenario([
      { agent: 'plan', status: 'done', content: '[PLAN:1]\n\nClear.' },
      { agent: 'implement', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      { agent: 'review', status: 'done', content: '[REVIEW:1]\n\nPassed.' },
    ]);

    const config = buildWorkflow(agentPaths, 10);
    const engine = new WorkflowEngine(config, testDir, 'Task', {
      ...buildEngineOptions(testDir),
      provider: 'mock',
    });

    // Abort after the first step completes
    engine.on('step:complete', () => {
      engine.abort();
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    // Should have aborted after 1 step
    expect(state.iteration).toBeLessThanOrEqual(2);
  });
});
