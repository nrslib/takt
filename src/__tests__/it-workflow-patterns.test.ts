/**
 * Workflow patterns integration tests.
 *
 * Tests that all builtin workflow definitions can be loaded and execute
 * the expected step transitions using WorkflowEngine + MockProvider + ScenarioQueue.
 *
 * Mocked: UI, session, phase-runner, notifications, config, callAiJudge
 * Not mocked: WorkflowEngine, runAgent, detectMatchedRule, rule-evaluator
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
    callAiJudge: vi.fn().mockImplementation(async (rules: { condition: string }[], content: string) => {
      // Simple text matching: return index of first rule whose condition appears in content
      for (let i = 0; i < rules.length; i++) {
        if (content.includes(rules[i]!.condition)) {
          return i;
        }
      }
      return -1;
    }),
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
import { loadWorkflow } from '../infra/config/index.js';
import type { WorkflowConfig } from '../core/models/index.js';

// --- Test helpers ---

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-wfp-'));
  mkdirSync(join(dir, '.takt', 'reports', 'test-report-dir'), { recursive: true });
  return dir;
}

function createEngine(config: WorkflowConfig, dir: string, task: string): WorkflowEngine {
  return new WorkflowEngine(config, dir, task, {
    projectCwd: dir,
    provider: 'mock',
    detectRuleIndex,
    callAiJudge,
  });
}

describe('Workflow Patterns IT: minimal workflow', () => {
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
    const config = loadWorkflow('minimal', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { agent: 'coder', status: 'done', content: 'Implementation complete.' },
      { agent: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues.' },
      { agent: 'supervisor', status: 'done', content: 'All checks passed.' },
    ]);

    const engine = createEngine(config!, testDir, 'Test task');
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(3);
  });

  it('should ABORT when implement cannot proceed', async () => {
    const config = loadWorkflow('minimal', testDir);

    setMockScenario([
      { agent: 'coder', status: 'done', content: 'Cannot proceed, insufficient info.' },
    ]);

    const engine = createEngine(config!, testDir, 'Vague task');
    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(1);
  });

});

describe('Workflow Patterns IT: default workflow (parallel reviewers)', () => {
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
    const config = loadWorkflow('default', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { agent: 'planner', status: 'done', content: '[PLAN:1]\n\nClear.' },
      { agent: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      { agent: 'ai-antipattern-reviewer', status: 'done', content: '[AI_REVIEW:1]\n\nNo issues.' },
      // Parallel reviewers: both approved
      { agent: 'architecture-reviewer', status: 'done', content: '[ARCH-REVIEW:1]\n\napproved' },
      { agent: 'security-reviewer', status: 'done', content: '[SECURITY-REVIEW:1]\n\napproved' },
      // Supervisor
      { agent: 'supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll checks passed.' },
    ]);

    const engine = createEngine(config!, testDir, 'Test task');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });

  it('should route to fix when any("needs_fix") in parallel review step', async () => {
    const config = loadWorkflow('default', testDir);

    setMockScenario([
      { agent: 'planner', status: 'done', content: '[PLAN:1]\n\nClear.' },
      { agent: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      { agent: 'ai-antipattern-reviewer', status: 'done', content: '[AI_REVIEW:1]\n\nNo issues.' },
      // Parallel: arch approved, security needs_fix
      { agent: 'architecture-reviewer', status: 'done', content: '[ARCH-REVIEW:1]\n\napproved' },
      { agent: 'security-reviewer', status: 'done', content: '[SECURITY-REVIEW:2]\n\nneeds_fix' },
      // Fix step
      { agent: 'coder', status: 'done', content: '[FIX:1]\n\nFix complete.' },
      // Re-review: both approved
      { agent: 'architecture-reviewer', status: 'done', content: '[ARCH-REVIEW:1]\n\napproved' },
      { agent: 'security-reviewer', status: 'done', content: '[SECURITY-REVIEW:1]\n\napproved' },
      // Supervisor
      { agent: 'supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll checks passed.' },
    ]);

    const engine = createEngine(config!, testDir, 'Task needing security fix');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });
});

describe('Workflow Patterns IT: research workflow', () => {
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
    const config = loadWorkflow('research', testDir);
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
    const config = loadWorkflow('research', testDir);

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

describe('Workflow Patterns IT: magi workflow', () => {
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
    const config = loadWorkflow('magi', testDir);
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

describe('Workflow Patterns IT: review-only workflow', () => {
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
    const config = loadWorkflow('review-only', testDir);
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

  it('should verify no steps have edit: true', () => {
    const config = loadWorkflow('review-only', testDir);
    expect(config).not.toBeNull();

    for (const step of config!.steps) {
      expect(step.edit).not.toBe(true);
      if (step.parallel) {
        for (const subStep of step.parallel) {
          expect(subStep.edit).not.toBe(true);
        }
      }
    }
  });
});

describe('Workflow Patterns IT: expert workflow (4 parallel reviewers)', () => {
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
    const config = loadWorkflow('expert', testDir);
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
