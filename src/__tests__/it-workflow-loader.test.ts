/**
 * Workflow loader integration tests.
 *
 * Tests the 3-tier workflow resolution (project-local → user → builtin)
 * and YAML parsing including special rule syntax (ai(), all(), any()).
 *
 * Mocked: globalConfig (for language/builtins)
 * Not mocked: loadWorkflow, parseWorkflow, rule parsing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- Mocks ---

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn().mockReturnValue({}),
  getLanguage: vi.fn().mockReturnValue('en'),
  getDisabledBuiltins: vi.fn().mockReturnValue([]),
  getBuiltinWorkflowsEnabled: vi.fn().mockReturnValue(true),
}));

// --- Imports (after mocks) ---

import { loadWorkflow } from '../infra/config/index.js';

// --- Test helpers ---

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-wfl-'));
  mkdirSync(join(dir, '.takt'), { recursive: true });
  return dir;
}

describe('Workflow Loader IT: builtin workflow loading', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const builtinNames = ['default', 'minimal', 'expert', 'expert-cqrs', 'research', 'magi', 'review-only', 'review-fix-minimal'];

  for (const name of builtinNames) {
    it(`should load builtin workflow: ${name}`, () => {
      const config = loadWorkflow(name, testDir);

      expect(config).not.toBeNull();
      expect(config!.name).toBe(name);
      expect(config!.steps.length).toBeGreaterThan(0);
      expect(config!.initialStep).toBeDefined();
      expect(config!.maxIterations).toBeGreaterThan(0);
    });
  }

  it('should return null for non-existent workflow', () => {
    const config = loadWorkflow('non-existent-workflow-xyz', testDir);
    expect(config).toBeNull();
  });
});

describe('Workflow Loader IT: project-local workflow override', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load project-local workflow from .takt/workflows/', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    const agentsDir = join(testDir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'custom.md'), 'Custom agent');

    writeFileSync(join(workflowsDir, 'custom-wf.yaml'), `
name: custom-wf
description: Custom project workflow
max_iterations: 5
initial_step: start

steps:
  - name: start
    agent: ./agents/custom.md
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Do the work"
`);

    const config = loadWorkflow('custom-wf', testDir);

    expect(config).not.toBeNull();
    expect(config!.name).toBe('custom-wf');
    expect(config!.steps.length).toBe(1);
    expect(config!.steps[0]!.name).toBe('start');
  });
});

describe('Workflow Loader IT: agent path resolution', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should resolve relative agent paths from workflow YAML location', () => {
    const config = loadWorkflow('minimal', testDir);
    expect(config).not.toBeNull();

    for (const step of config!.steps) {
      if (step.agentPath) {
        // Agent paths should be resolved to absolute paths
        expect(step.agentPath).toMatch(/^\//);
        // Agent files should exist
        expect(existsSync(step.agentPath)).toBe(true);
      }
      if (step.parallel) {
        for (const sub of step.parallel) {
          if (sub.agentPath) {
            expect(sub.agentPath).toMatch(/^\//);
            expect(existsSync(sub.agentPath)).toBe(true);
          }
        }
      }
    }
  });
});

describe('Workflow Loader IT: rule syntax parsing', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should parse all() aggregate conditions from default workflow', () => {
    const config = loadWorkflow('default', testDir);
    expect(config).not.toBeNull();

    // Find the parallel reviewers step
    const reviewersStep = config!.steps.find(
      (s) => s.parallel && s.parallel.length > 0,
    );
    expect(reviewersStep).toBeDefined();

    // Should have aggregate rules
    const allRule = reviewersStep!.rules?.find(
      (r) => r.isAggregateCondition && r.aggregateType === 'all',
    );
    expect(allRule).toBeDefined();
    expect(allRule!.aggregateConditionText).toBe('approved');
  });

  it('should parse any() aggregate conditions from default workflow', () => {
    const config = loadWorkflow('default', testDir);
    expect(config).not.toBeNull();

    const reviewersStep = config!.steps.find(
      (s) => s.parallel && s.parallel.length > 0,
    );

    const anyRule = reviewersStep!.rules?.find(
      (r) => r.isAggregateCondition && r.aggregateType === 'any',
    );
    expect(anyRule).toBeDefined();
    expect(anyRule!.aggregateConditionText).toBe('needs_fix');
  });

  it('should parse standard rules with next step', () => {
    const config = loadWorkflow('minimal', testDir);
    expect(config).not.toBeNull();

    const implementStep = config!.steps.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.rules).toBeDefined();
    expect(implementStep!.rules!.length).toBeGreaterThan(0);

    // Each rule should have condition and next
    for (const rule of implementStep!.rules!) {
      expect(typeof rule.condition).toBe('string');
      expect(rule.condition.length).toBeGreaterThan(0);
    }
  });
});

describe('Workflow Loader IT: workflow config validation', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should set max_iterations from YAML', () => {
    const config = loadWorkflow('minimal', testDir);
    expect(config).not.toBeNull();
    expect(typeof config!.maxIterations).toBe('number');
    expect(config!.maxIterations).toBeGreaterThan(0);
  });

  it('should set initial_step from YAML', () => {
    const config = loadWorkflow('minimal', testDir);
    expect(config).not.toBeNull();
    expect(typeof config!.initialStep).toBe('string');

    // initial_step should reference an existing step
    const stepNames = config!.steps.map((s) => s.name);
    expect(stepNames).toContain(config!.initialStep);
  });

  it('should preserve edit property on steps (review-only has no edit: true)', () => {
    const config = loadWorkflow('review-only', testDir);
    expect(config).not.toBeNull();

    // review-only: no step should have edit: true
    for (const step of config!.steps) {
      expect(step.edit).not.toBe(true);
      if (step.parallel) {
        for (const sub of step.parallel) {
          expect(sub.edit).not.toBe(true);
        }
      }
    }

    // expert: implement step should have edit: true
    const expertConfig = loadWorkflow('expert', testDir);
    expect(expertConfig).not.toBeNull();
    const implementStep = expertConfig!.steps.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.edit).toBe(true);
  });

  it('should set passPreviousResponse from YAML', () => {
    const config = loadWorkflow('minimal', testDir);
    expect(config).not.toBeNull();

    // At least some steps should have passPreviousResponse set
    const stepsWithPassPrev = config!.steps.filter((s) => s.passPreviousResponse === true);
    expect(stepsWithPassPrev.length).toBeGreaterThan(0);
  });
});

describe('Workflow Loader IT: parallel step loading', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load parallel sub-steps from default workflow', () => {
    const config = loadWorkflow('default', testDir);
    expect(config).not.toBeNull();

    const parallelStep = config!.steps.find(
      (s) => s.parallel && s.parallel.length > 0,
    );
    expect(parallelStep).toBeDefined();
    expect(parallelStep!.parallel!.length).toBeGreaterThanOrEqual(2);

    // Each sub-step should have required fields
    for (const sub of parallelStep!.parallel!) {
      expect(sub.name).toBeDefined();
      expect(sub.agent).toBeDefined();
      expect(sub.rules).toBeDefined();
    }
  });

  it('should load 4 parallel reviewers from expert workflow', () => {
    const config = loadWorkflow('expert', testDir);
    expect(config).not.toBeNull();

    const parallelStep = config!.steps.find(
      (s) => s.parallel && s.parallel.length === 4,
    );
    expect(parallelStep).toBeDefined();

    const subNames = parallelStep!.parallel!.map((s) => s.name);
    expect(subNames).toContain('arch-review');
    expect(subNames).toContain('frontend-review');
    expect(subNames).toContain('security-review');
    expect(subNames).toContain('qa-review');
  });
});

describe('Workflow Loader IT: report config loading', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load single report config', () => {
    const config = loadWorkflow('default', testDir);
    expect(config).not.toBeNull();

    // default workflow: plan step has a report config
    const planStep = config!.steps.find((s) => s.name === 'plan');
    expect(planStep).toBeDefined();
    expect(planStep!.report).toBeDefined();
  });

  it('should load multi-report config from expert workflow', () => {
    const config = loadWorkflow('expert', testDir);
    expect(config).not.toBeNull();

    // implement step has multi-report: [Scope, Decisions]
    const implementStep = config!.steps.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.report).toBeDefined();
    expect(Array.isArray(implementStep!.report)).toBe(true);
    expect((implementStep!.report as unknown[]).length).toBe(2);
  });
});

describe('Workflow Loader IT: invalid YAML handling', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should throw for workflow file with invalid YAML', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'broken.yaml'), `
name: broken
this is not: valid yaml: [[[[
  - bad: {
`);

    expect(() => loadWorkflow('broken', testDir)).toThrow();
  });

  it('should throw for workflow missing required fields', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'incomplete.yaml'), `
name: incomplete
description: Missing steps
`);

    expect(() => loadWorkflow('incomplete', testDir)).toThrow();
  });
});
