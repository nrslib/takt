/**
 * Workflow execution integration tests.
 *
 * Tests WorkflowEngine with real runAgent + MockProvider + ScenarioQueue.
 * No vi.mock on runAgent or detectMatchedRule — rules are matched via
 * [STEP_NAME:N] tags in scenario content (tag-based detection).
 *
 * Mocked: UI, session, phase-runner (report/judgment phases), notifications, config
 * Not mocked: WorkflowEngine, runAgent, detectMatchedRule, rule-evaluator
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockScenario, resetScenario } from '../mock/scenario.js';
import type { WorkflowConfig, WorkflowStep, WorkflowRule } from '../models/types.js';

// --- Mocks (minimal — only infrastructure, not core logic) ---

// Safety net: prevent callAiJudge from calling real Claude CLI.
// Tag-based detection should always match in these tests; if it doesn't,
// this mock surfaces the failure immediately instead of timing out.
vi.mock('../claude/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../claude/client.js')>();
  return {
    ...original,
    callAiJudge: vi.fn().mockResolvedValue(-1),
  };
});

vi.mock('../workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue(''),
}));

vi.mock('../utils/session.js', () => ({
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  generateSessionId: vi.fn().mockReturnValue('test-session-id'),
}));

vi.mock('../config/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn().mockReturnValue({}),
  getLanguage: vi.fn().mockReturnValue('en'),
}));

vi.mock('../config/projectConfig.js', () => ({
  loadProjectConfig: vi.fn().mockReturnValue({}),
}));

// --- Imports (after mocks) ---

import { WorkflowEngine } from '../workflow/engine.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-wf-'));
  mkdirSync(join(dir, '.takt', 'reports', 'test-report-dir'), { recursive: true });

  const agentsDir = join(dir, 'agents');
  mkdirSync(agentsDir, { recursive: true });

  const agents = ['planner', 'coder', 'reviewer', 'fixer', 'supervisor'];
  const agentPaths: Record<string, string> = {};
  for (const agent of agents) {
    const path = join(agentsDir, `${agent}.md`);
    writeFileSync(path, `You are a ${agent}.`);
    agentPaths[agent] = path;
  }

  return { dir, agentPaths };
}

function buildSimpleWorkflow(agentPaths: Record<string, string>): WorkflowConfig {
  return {
    name: 'it-simple',
    description: 'IT simple workflow',
    maxIterations: 15,
    initialStep: 'plan',
    steps: [
      makeStep('plan', agentPaths.planner, [
        makeRule('Requirements are clear', 'implement'),
        makeRule('Requirements unclear', 'ABORT'),
      ]),
      makeStep('implement', agentPaths.coder, [
        makeRule('Implementation complete', 'review'),
        makeRule('Cannot proceed', 'plan'),
      ]),
      makeStep('review', agentPaths.reviewer, [
        makeRule('All checks passed', 'COMPLETE'),
        makeRule('Issues found', 'implement'),
      ]),
    ],
  };
}

function buildLoopWorkflow(agentPaths: Record<string, string>): WorkflowConfig {
  return {
    name: 'it-loop',
    description: 'IT workflow with fix loop',
    maxIterations: 20,
    initialStep: 'plan',
    steps: [
      makeStep('plan', agentPaths.planner, [
        makeRule('Requirements are clear', 'implement'),
        makeRule('Requirements unclear', 'ABORT'),
      ]),
      makeStep('implement', agentPaths.coder, [
        makeRule('Implementation complete', 'review'),
        makeRule('Cannot proceed', 'plan'),
      ]),
      makeStep('review', agentPaths.reviewer, [
        makeRule('Approved', 'supervise'),
        makeRule('Needs fix', 'fix'),
      ]),
      makeStep('fix', agentPaths.fixer, [
        makeRule('Fix complete', 'review'),
        makeRule('Cannot fix', 'ABORT'),
      ]),
      makeStep('supervise', agentPaths.supervisor, [
        makeRule('All checks passed', 'COMPLETE'),
        makeRule('Requirements unmet', 'plan'),
      ]),
    ],
  };
}

describe('Workflow Engine IT: Happy Path', () => {
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
      { agent: 'plan', status: 'done', content: '[PLAN:1]\n\nRequirements are clear.' },
      { agent: 'implement', status: 'done', content: '[IMPLEMENT:1]\n\nImplementation complete.' },
      { agent: 'review', status: 'done', content: '[REVIEW:1]\n\nAll checks passed.' },
    ]);

    const config = buildSimpleWorkflow(agentPaths);
    const engine = new WorkflowEngine(config, testDir, 'Test task', {
      projectCwd: testDir,
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(3);
  });

  it('should ABORT when plan returns rule 2', async () => {
    setMockScenario([
      { agent: 'plan', status: 'done', content: '[PLAN:2]\n\nRequirements unclear.' },
    ]);

    const config = buildSimpleWorkflow(agentPaths);
    const engine = new WorkflowEngine(config, testDir, 'Vague task', {
      projectCwd: testDir,
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(1);
  });
});

describe('Workflow Engine IT: Fix Loop', () => {
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
      { agent: 'plan', status: 'done', content: '[PLAN:1]\n\nClear.' },
      { agent: 'implement', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      // First review: needs fix
      { agent: 'review', status: 'done', content: '[REVIEW:2]\n\nNeeds fix.' },
      // Fix
      { agent: 'fix', status: 'done', content: '[FIX:1]\n\nFix complete.' },
      // Second review: approved
      { agent: 'review', status: 'done', content: '[REVIEW:1]\n\nApproved.' },
      // Supervise
      { agent: 'supervise', status: 'done', content: '[SUPERVISE:1]\n\nAll checks passed.' },
    ]);

    const config = buildLoopWorkflow(agentPaths);
    const engine = new WorkflowEngine(config, testDir, 'Task needing fix', {
      projectCwd: testDir,
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(6);
  });

  it('should ABORT if fix fails', async () => {
    setMockScenario([
      { agent: 'plan', status: 'done', content: '[PLAN:1]\n\nClear.' },
      { agent: 'implement', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      { agent: 'review', status: 'done', content: '[REVIEW:2]\n\nNeeds fix.' },
      { agent: 'fix', status: 'done', content: '[FIX:2]\n\nCannot fix.' },
    ]);

    const config = buildLoopWorkflow(agentPaths);
    const engine = new WorkflowEngine(config, testDir, 'Unfixable task', {
      projectCwd: testDir,
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
  });
});

describe('Workflow Engine IT: Max Iterations', () => {
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

  it('should abort when maxIterations exceeded in infinite loop', async () => {
    // Create an infinite loop: plan always goes to implement, implement always goes back to plan
    const infiniteScenario = Array.from({ length: 10 }, (_, i) => ({
      status: 'done' as const,
      content: i % 2 === 0 ? '[PLAN:1]\n\nClear.' : '[IMPLEMENT:2]\n\nCannot proceed.',
    }));
    setMockScenario(infiniteScenario);

    const config = buildSimpleWorkflow(agentPaths);
    config.maxIterations = 5;

    const engine = new WorkflowEngine(config, testDir, 'Looping task', {
      projectCwd: testDir,
      provider: 'mock',
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBeLessThanOrEqual(5);
  });
});

describe('Workflow Engine IT: Step Output Tracking', () => {
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

  it('should track step outputs through events', async () => {
    setMockScenario([
      { agent: 'plan', status: 'done', content: '[PLAN:1]\n\nPlan output.' },
      { agent: 'implement', status: 'done', content: '[IMPLEMENT:1]\n\nImplement output.' },
      { agent: 'review', status: 'done', content: '[REVIEW:1]\n\nReview output.' },
    ]);

    const config = buildSimpleWorkflow(agentPaths);
    const engine = new WorkflowEngine(config, testDir, 'Track outputs', {
      projectCwd: testDir,
      provider: 'mock',
    });

    const completedSteps: string[] = [];
    engine.on('step:complete', (step) => {
      completedSteps.push(step.name);
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(completedSteps).toEqual(['plan', 'implement', 'review']);
  });
});
