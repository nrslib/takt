/**
 * Workflow patterns integration tests.
 *
 * Tests that all builtin workflow definitions can be loaded and execute
 * the expected step transitions using WorkflowEngine + MockProvider + ScenarioQueue.
 *
 * Mocked: UI, session, phase-runner, notifications, config
 * Not mocked: WorkflowEngine, runAgent, detectMatchedRule, rule-evaluator
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';
import { DefaultStructuredCaller, type StructuredCaller } from '../agents/structured-caller.js';
import { detectRuleIndex } from '../shared/utils/ruleIndex.js';

// --- Mocks ---

vi.mock('../core/workflow/phase-runner.js', () => ({
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
  getBuiltinWorkflowsEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/config/project/projectConfig.js', () => ({
  loadProjectConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: vi.fn((_cwd: string, key: string) => {
    if (key === 'language') return 'en';
    if (key === 'enableBuiltinWorkflows') return true;
    if (key === 'disabledBuiltins') return [];
    return undefined;
  }),
  resolveConfigValues: vi.fn((_cwd: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === 'language') result[key] = 'en';
      if (key === 'enableBuiltinWorkflows') result[key] = true;
      if (key === 'disabledBuiltins') result[key] = [];
    }
    return result;
  }),
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
  const defaultStructuredCaller = new DefaultStructuredCaller();
  const structuredCaller: StructuredCaller = {
    judgeStatus: defaultStructuredCaller.judgeStatus.bind(defaultStructuredCaller),
    evaluateCondition: vi.fn().mockImplementation(async (content: string, conditions: { index: number; text: string }[]) => {
      for (const condition of conditions) {
        if (content.includes(condition.text)) {
          return condition.index;
        }
      }
      return -1;
    }),
    decomposeTask: defaultStructuredCaller.decomposeTask.bind(defaultStructuredCaller),
    requestMoreParts: defaultStructuredCaller.requestMoreParts.bind(defaultStructuredCaller),
  };
  return new WorkflowEngine(config, dir, task, {
    projectCwd: dir,
    provider: 'mock',
    detectRuleIndex,
    structuredCaller,
  });
}

describe('Workflow Patterns IT: default workflow (happy path)', () => {
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
    const config = loadWorkflow('default', testDir);
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
    const config = loadWorkflow('default', testDir);

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
    const config = loadWorkflow('default', testDir);

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
    const config = loadWorkflow('default', testDir);

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

describe('Workflow Patterns IT: default workflow (write_tests skip path)', () => {
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
    const config = loadWorkflow('default', testDir);
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
    const config = loadWorkflow('research', testDir);

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

describe('Workflow Patterns IT: review workflow', () => {
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
    const config = loadWorkflow('review-default', testDir);
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

  it('should verify no steps have edit: true', () => {
    const config = loadWorkflow('review-default', testDir);
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

describe('Workflow Patterns IT: dual workflow (2-stage parallel reviewers)', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should complete with 2-stage review: reviewers_1 → reviewers_2 → supervise', async () => {
    const config = loadWorkflow('dual', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:1]\n\nClear.' },
      { persona: 'coder', status: 'done', content: '[WRITE_TESTS:1]\n\nTests written.' },
      // Team leader decompose (returns single part via structuredOutput)
      { persona: 'coder', status: 'done', content: 'Decomposed into 1 part.', structuredOutput: { parts: [{ id: 'part-1', title: 'Implement all', instruction: 'Implement the task.' }] } },
      // Team leader part execution
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: '[AI_REVIEW:1]\n\nNo issues.' },
      // Stage 1: 3 parallel reviewers (arch, frontend, testing)
      { persona: 'architecture-reviewer', status: 'done', content: '[ARCH-REVIEW:1]\n\napproved' },
      { persona: 'frontend-reviewer', status: 'done', content: '[FRONTEND-REVIEW:1]\n\napproved' },
      { persona: 'testing-reviewer', status: 'done', content: '[TESTING-REVIEW:1]\n\napproved' },
      // Stage 2: 3 parallel reviewers (security, qa, requirements)
      { persona: 'security-reviewer', status: 'done', content: '[SECURITY-REVIEW:1]\n\napproved' },
      { persona: 'qa-reviewer', status: 'done', content: '[QA-REVIEW:1]\n\napproved' },
      { persona: 'requirements-reviewer', status: 'done', content: '[REQUIREMENTS-REVIEW:1]\n\napproved' },
      // Supervisor
      { persona: 'dual-supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll validations pass.' },
    ]);

    const engine = createEngine(config!, testDir, 'Dual review task');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });
});

describe('Workflow Patterns IT: review-fix workflow', () => {
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
    const config = loadWorkflow('review-fix-default', testDir);
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
    const config = loadWorkflow('review-fix-default', testDir);
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
    const config = loadWorkflow('review-fix-default', testDir);
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

describe('Workflow Patterns IT: frontend-review-fix workflow (fix loop)', () => {
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
    const config = loadWorkflow('review-fix-frontend', testDir);
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

describe('Workflow Patterns IT: backend-review-fix workflow (fix loop)', () => {
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
    const config = loadWorkflow('review-fix-backend', testDir);
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

describe('Workflow Patterns IT: dual-review-fix workflow (fix loop)', () => {
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
    const config = loadWorkflow('review-fix-dual', testDir);
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

describe('Workflow Patterns IT: dual-cqrs-review-fix workflow (fix loop)', () => {
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
    const config = loadWorkflow('review-fix-dual-cqrs', testDir);
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

describe('Workflow Patterns IT: backend-cqrs-review-fix workflow (fix loop)', () => {
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
    const config = loadWorkflow('review-fix-backend-cqrs', testDir);
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
