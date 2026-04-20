/**
 * Workflow loader integration tests.
 *
 * Tests the 3-tier workflow resolution (project-local → user → builtin)
 * and YAML parsing including special rule syntax (ai(), all(), any()).
 *
 * Mocked: loadConfig (for language/builtins)
 * Not mocked: loadWorkflow, workflow parsing, rule parsing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- Mocks ---
const languageState = vi.hoisted(() => ({ value: 'en' as 'en' | 'ja' }));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: vi.fn((_cwd: string, key: string) => {
    if (key === 'language') return languageState.value;
    if (key === 'enableBuiltinWorkflows') return true;
    if (key === 'disabledBuiltins') return [];
    return undefined;
  }),
  resolveConfigValues: vi.fn((_cwd: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === 'language') result[key] = languageState.value;
      if (key === 'enableBuiltinWorkflows') result[key] = true;
      if (key === 'disabledBuiltins') result[key] = [];
    }
    return result;
  }),
}));

// --- Imports (after mocks) ---

import { loadWorkflow } from '../infra/config/loaders/index.js';
import { listBuiltinWorkflowNames } from '../infra/config/loaders/workflowResolver.js';
import { loadGlobalConfig } from '../infra/config/global/globalConfig.js';

const loadWorkflowConfig = loadWorkflow;
const listBuiltinWorkflowLabels = listBuiltinWorkflowNames;

// --- Test helpers ---

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-wfl-'));
  mkdirSync(join(dir, '.takt'), { recursive: true });
  return dir;
}

describe('Workflow Loader IT: builtin workflow loading', () => {
  let testDir: string;
  const builtinNames = listBuiltinWorkflowLabels(process.cwd(), { includeDisabled: true });

  beforeEach(() => {
    testDir = createTestDir();
    languageState.value = 'en';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  for (const name of builtinNames) {
    it(`should load builtin workflow: ${name}`, () => {
      const config = loadWorkflow(name, testDir);

      expect(config).not.toBeNull();
      expect(config!.name).toBe(name);
      expect(config!.steps.length).toBeGreaterThan(0);
      expect(config!.initialStep).toBeDefined();
      const maxSteps = (config as Record<string, unknown>).maxSteps;
      expect(maxSteps === 'infinite' || typeof maxSteps === 'number').toBe(true);
      if (typeof maxSteps === 'number') {
        expect(maxSteps).toBeGreaterThan(0);
      }
    });
  }

  it('should return null for non-existent workflow', () => {
    const config = loadWorkflow('non-existent-workflow-xyz', testDir);
    expect(config).toBeNull();
  });

  it('should include and load audit-e2e as a builtin workflow', () => {
    expect(builtinNames).toContain('audit-e2e');

    const config = loadWorkflowConfig('audit-e2e', testDir);
    expect(config).not.toBeNull();

    const planStep = config!.steps.find((step) => step.name === 'plan');
    const auditStep = config!.steps.find((step) => step.name === 'audit');

    expect(planStep).toBeDefined();
    expect(auditStep).toBeDefined();
  });

  it('should include and load auto-improvement-loop as a builtin workflow', () => {
    expect(builtinNames).toContain('auto-improvement-loop');

    const config = loadWorkflowConfig('auto-improvement-loop', testDir);
    expect(config).not.toBeNull();
    expect((config as Record<string, unknown>).maxSteps).toBe('infinite');
    expect(config!.schemas).toEqual(expect.objectContaining({
      'followup-task': 'followup-task',
    }));

    const routeContext = config!.steps.find((step) => step.name === 'route_context');
    expect(routeContext?.kind).toBe('system');
    expect(routeContext?.systemInputs).toHaveLength(4);
    expect(routeContext?.systemInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'task_context', as: 'task' }),
      expect.objectContaining({ type: 'branch_context', as: 'branch' }),
      expect.objectContaining({ type: 'pr_list', as: 'prs' }),
      expect.objectContaining({ type: 'issue_context', as: 'issue' }),
    ]));
  });

  it('should preserve the north-star orchestration contract in the builtin workflow', () => {
    const config = loadWorkflowConfig('auto-improvement-loop', testDir);
    expect(config).not.toBeNull();

    const planFromIssue = config!.steps.find((step) => step.name === 'plan_from_issue') as Record<string, unknown> | undefined;
    const enqueueFromIssue = config!.steps.find((step) => step.name === 'enqueue_from_issue') as Record<string, unknown> | undefined;
    const planFromExistingPr = config!.steps.find((step) => step.name === 'plan_from_existing_pr') as Record<string, unknown> | undefined;
    const enqueueFromPr = config!.steps.find((step) => step.name === 'enqueue_from_pr') as Record<string, unknown> | undefined;
    const prepareMerge = config!.steps.find((step) => step.name === 'prepare_merge') as Record<string, unknown> | undefined;
    const resolveConflicts = config!.steps.find((step) => step.name === 'resolve_conflicts') as Record<string, unknown> | undefined;
    const enqueueConflictResolutionTask = config!.steps.find((step) => step.name === 'enqueue_conflict_resolution_task') as Record<string, unknown> | undefined;
    const mergePr = config!.steps.find((step) => step.name === 'merge_pr') as Record<string, unknown> | undefined;
    const waitBeforeNextScan = config!.steps.find((step) => step.name === 'wait_before_next_scan') as Record<string, unknown> | undefined;

    expect(planFromIssue?.delayBeforeMs).toBe(60000);
    expect(planFromIssue?.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ condition: 'structured.plan_from_issue.action == "noop"', next: 'wait_before_next_scan' }),
      expect.objectContaining({ condition: 'true', next: 'ABORT' }),
    ]));
    expect(enqueueFromIssue?.effects).toEqual([
      expect.objectContaining({
        type: 'enqueue_task',
        mode: 'new',
        workflow: 'takt-default',
        base_branch: 'improve',
        issue: '{structured:plan_from_issue.issue}',
      }),
    ]);
    expect(planFromExistingPr?.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ condition: 'structured.plan_from_existing_pr.action == "noop"', next: 'wait_before_next_scan' }),
      expect.objectContaining({ condition: 'true', next: 'ABORT' }),
    ]));
    expect(enqueueFromPr?.effects).toEqual([
      expect.objectContaining({
        type: 'enqueue_task',
        mode: 'from_pr',
        workflow: 'takt-default',
        base_branch: 'improve',
      }),
    ]);
    expect(prepareMerge?.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ condition: 'effect.prepare_merge.sync_with_root.success == true', next: 'merge_pr' }),
      expect.objectContaining({ condition: 'effect.prepare_merge.sync_with_root.conflicted == true', next: 'resolve_conflicts' }),
    ]));
    expect(resolveConflicts?.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ condition: 'effect.resolve_conflicts.resolve_conflicts_with_ai.success == true', next: 'merge_pr' }),
      expect.objectContaining({ condition: 'effect.resolve_conflicts.resolve_conflicts_with_ai.failed == true', next: 'enqueue_conflict_resolution_task' }),
    ]));
    expect(enqueueConflictResolutionTask?.effects).toEqual([
      expect.objectContaining({
        type: 'enqueue_task',
        mode: 'from_pr',
        workflow: 'takt-default',
        base_branch: 'improve',
      }),
    ]);
    expect(mergePr).toBeDefined();
    expect(waitBeforeNextScan?.systemInputs).toEqual([
      expect.objectContaining({
        type: 'task_queue_context',
        as: 'queue',
        exclude_current_task: true,
      }),
    ]);
    expect(waitBeforeNextScan?.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        condition: 'exists(context.wait_before_next_scan.queue.items, item.kind == "running")',
        next: 'wait_before_next_scan',
      }),
    ]));
  });

  it('should load audit-e2e as a builtin workflow in ja locale', () => {
    languageState.value = 'ja';

    const jaBuiltinNames = listBuiltinWorkflowNames(testDir, { includeDisabled: true });
    expect(jaBuiltinNames).toContain('audit-e2e');

    const config = loadWorkflowConfig('audit-e2e', testDir);
    expect(config).not.toBeNull();

    const planStep = config!.steps.find((step) => step.name === 'plan');
    const auditStep = config!.steps.find((step) => step.name === 'audit');

    expect(planStep).toBeDefined();
    expect(auditStep).toBeDefined();
  });

  it('should load auto-improvement-loop as a builtin workflow in ja locale', () => {
    languageState.value = 'ja';

    const jaBuiltinNames = listBuiltinWorkflowNames(testDir, { includeDisabled: true });
    expect(jaBuiltinNames).toContain('auto-improvement-loop');

    const config = loadWorkflowConfig('auto-improvement-loop', testDir);
    expect(config).not.toBeNull();
    expect((config as Record<string, unknown>).maxSteps).toBe('infinite');
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

    const agentsDir = join(testDir, '.takt', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'custom.md'), 'Custom agent');

    writeFileSync(join(workflowsDir, 'custom-wf.yaml'), `
name: custom-wf
description: Custom project workflow
max_steps: 5
initial_step: start

steps:
  - name: start
    persona: ../agents/custom.md
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Do the work"
`);

    const config = loadWorkflowConfig('custom-wf', testDir);

    expect(config).not.toBeNull();
    expect(config!.name).toBe('custom-wf');
    expect(config!.steps.length).toBe(1);
    expect(config!.steps[0]!.name).toBe('start');
  });

  it('should propagate canonical instruction field through loader for step and loop monitor judge', () => {
    // Given: project-local workflow that uses instruction on both step and loop monitor judge
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'instruction-canonical.yaml'), `
name: instruction-canonical
max_steps: 8
initial_step: step1

steps:
  - name: step1
    instruction: "Step 1 instruction"
    rules:
      - condition: next
        next: step2
  - name: step2
    instruction: "Step 2 instruction"
    rules:
      - condition: done
        next: COMPLETE

loop_monitors:
  - cycle: [step1, step2]
    threshold: 2
    judge:
      instruction: "Judge instruction"
      rules:
        - condition: continue
          next: step2
`);

    // When: loading the workflow through the integration entry point
    const config = loadWorkflowConfig('instruction-canonical', testDir);

    // Then: canonical instruction is available on normalized step/judge models
    expect(config).not.toBeNull();
    const step1 = config!.steps[0] as unknown as Record<string, unknown>;
    const judge = config!.loopMonitors?.[0]?.judge as unknown as Record<string, unknown>;
    expect(step1.instruction).toBe('Step 1 instruction');
    expect(judge.instruction).toBe('Judge instruction');
  });

  it('should load loop monitor judge provider and model overrides', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'loop-monitor-judge-provider-model.yaml'), `
name: loop-monitor-judge-provider-model
max_steps: 8
initial_step: step1

steps:
  - name: step1
    instruction: "Step 1 instruction"
    rules:
      - condition: next
        next: step2
  - name: step2
    instruction: "Step 2 instruction"
    rules:
      - condition: done
        next: COMPLETE

loop_monitors:
  - cycle: [step1, step2]
    threshold: 2
    judge:
      persona: supervisor
      provider: opencode
      model: opencode/big-pickle
      instruction: "Judge instruction"
      rules:
        - condition: continue
          next: step2
`);

    const config = loadWorkflow('loop-monitor-judge-provider-model', testDir);

    expect(config).not.toBeNull();
    expect(config!.loopMonitors).toHaveLength(1);
    expect(config!.loopMonitors?.[0]?.judge).toMatchObject({
      persona: 'supervisor',
      provider: 'opencode',
      model: 'opencode/big-pickle',
      instruction: 'Judge instruction',
    });
  });

  it('should load loop monitor judge provider block overrides', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'loop-monitor-judge-provider-block.yaml'), `
name: loop-monitor-judge-provider-block
max_steps: 8
initial_step: step1

steps:
  - name: step1
    instruction: "Step 1 instruction"
    rules:
      - condition: next
        next: step2
  - name: step2
    instruction: "Step 2 instruction"
    rules:
      - condition: done
        next: COMPLETE

loop_monitors:
  - cycle: [step1, step2]
    threshold: 2
    judge:
      provider:
        type: codex
        model: gpt-5.2-codex
        network_access: true
      instruction: "Judge instruction"
      rules:
        - condition: continue
          next: step2
`);

    const config = loadWorkflow('loop-monitor-judge-provider-block', testDir);

    expect(config).not.toBeNull();
    expect(config!.loopMonitors).toHaveLength(1);
    expect(config!.loopMonitors?.[0]?.judge).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.2-codex',
      providerOptions: {
        codex: {
          networkAccess: true,
        },
      },
      instruction: 'Judge instruction',
    });
  });

  it('should load loop monitor judge model-only override without changing provider', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'loop-monitor-judge-model-only.yaml'), `
name: loop-monitor-judge-model-only
max_steps: 8
initial_step: step1

steps:
  - name: step1
    provider: opencode
    model: opencode/big-pickle
    instruction: "Step 1 instruction"
    rules:
      - condition: next
        next: step2
  - name: step2
    instruction: "Step 2 instruction"
    rules:
      - condition: done
        next: COMPLETE

loop_monitors:
  - cycle: [step1, step2]
    threshold: 2
    judge:
      model: opencode/model-b
      instruction: "Judge instruction"
      rules:
        - condition: continue
          next: step2
`);

    const config = loadWorkflow('loop-monitor-judge-model-only', testDir);

    expect(config).not.toBeNull();
    expect(config!.loopMonitors?.[0]?.judge).toMatchObject({
      model: 'opencode/model-b',
      instruction: 'Judge instruction',
    });
  });

  it('should reject bare OpenCode models in loop monitor judge config', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'loop-monitor-judge-opencode-bare-model.yaml'), `
name: loop-monitor-judge-opencode-bare-model
max_steps: 8
initial_step: step1

steps:
  - name: step1
    instruction: "Step 1 instruction"
    rules:
      - condition: next
        next: step2
  - name: step2
    instruction: "Step 2 instruction"
    rules:
      - condition: done
        next: COMPLETE

loop_monitors:
  - cycle: [step1, step2]
    threshold: 2
    judge:
      provider: opencode
      model: big-pickle
      instruction: "Judge instruction"
      rules:
        - condition: continue
          next: step2
`);

    expect(() => loadWorkflow('loop-monitor-judge-opencode-bare-model', testDir))
      .toThrow("Configuration error: loop_monitors.judge.model");
  });

  it('should reject bare OpenCode judge models inherited from the triggering step provider', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'loop-monitor-judge-inherited-opencode-bare-model.yaml'), `
name: loop-monitor-judge-inherited-opencode-bare-model
max_steps: 8
initial_step: step1

steps:
  - name: step1
    instruction: "Step 1 instruction"
    rules:
      - condition: next
        next: step2
  - name: step2
    provider: opencode
    model: opencode/big-pickle
    instruction: "Step 2 instruction"
    rules:
      - condition: done
        next: COMPLETE

loop_monitors:
  - cycle: [step1, step2]
    threshold: 2
    judge:
      model: big-pickle
      instruction: "Judge instruction"
      rules:
        - condition: continue
          next: step2
`);

    expect(() => loadWorkflow('loop-monitor-judge-inherited-opencode-bare-model', testDir))
      .toThrow("Configuration error: loop_monitors.judge.model");
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
    const config = loadWorkflowConfig('default', testDir);
    expect(config).not.toBeNull();

    for (const step of config!.steps) {
      if (step.personaPath) {
        // Agent paths should be resolved to absolute paths
        expect(step.personaPath).toMatch(/^\//);
        // Agent files should exist
        expect(existsSync(step.personaPath)).toBe(true);
      }
      if (step.parallel) {
        for (const sub of step.parallel) {
          if (sub.personaPath) {
            expect(sub.personaPath).toMatch(/^\//);
            expect(existsSync(sub.personaPath)).toBe(true);
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

  it('should parse all() multi-condition aggregate from the default workflow', () => {
    const config = loadWorkflowConfig('default', testDir);
    expect(config).not.toBeNull();

    // Find the parallel reviewers step
    const reviewersStep = config!.steps.find(
      (s) => s.parallel && s.parallel.length > 0,
    );
    expect(reviewersStep).toBeDefined();

    // Should have aggregate rules with multi-condition (array)
    const allRule = reviewersStep!.rules?.find(
      (r) => r.isAggregateCondition && r.aggregateType === 'all',
    );
    expect(allRule).toBeDefined();
    // Multi-condition aggregate: all("approved", "All checks passed")
    expect(Array.isArray(allRule!.aggregateConditionText)).toBe(true);
    expect((allRule!.aggregateConditionText as string[])[0]).toBe('approved');
  });

  it('should parse any() multi-condition aggregate from the default workflow', () => {
    const config = loadWorkflowConfig('default', testDir);
    expect(config).not.toBeNull();

    const reviewersStep = config!.steps.find(
      (s) => s.parallel && s.parallel.length > 0,
    );

    const anyRule = reviewersStep!.rules?.find(
      (r) => r.isAggregateCondition && r.aggregateType === 'any',
    );
    expect(anyRule).toBeDefined();
    // Multi-condition aggregate: any("needs_fix", "...")
    expect(Array.isArray(anyRule!.aggregateConditionText)).toBe(true);
    expect((anyRule!.aggregateConditionText as string[])[0]).toBe('needs_fix');
  });

  it('should parse standard rules with next step', () => {
    const config = loadWorkflowConfig('default', testDir);
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

  it('should set max_steps from YAML', () => {
    const config = loadWorkflowConfig('default', testDir);
    expect(config).not.toBeNull();
    expect(typeof config!.maxSteps).toBe('number');
    expect(config!.maxSteps).toBeGreaterThan(0);

    const infiniteConfig = loadWorkflowConfig('auto-improvement-loop', testDir);
    expect(infiniteConfig).not.toBeNull();
    expect((infiniteConfig as Record<string, unknown>).maxSteps).toBe('infinite');
  });

  it('should set initial_step from YAML', () => {
    const config = loadWorkflowConfig('default', testDir);
    expect(config).not.toBeNull();
    expect(typeof config!.initialStep).toBe('string');

    const stepNames = config!.steps.map((s) => s.name);
    expect(stepNames).toContain(config!.initialStep);
  });

  it('should preserve edit property on steps (review has no edit: true)', () => {
    const config = loadWorkflowConfig('review-default', testDir);
    expect(config).not.toBeNull();

    // review: no step should have edit: true
    for (const step of config!.steps) {
      expect(step.edit).not.toBe(true);
      if (step.parallel) {
        for (const sub of step.parallel) {
          expect(sub.edit).not.toBe(true);
        }
      }
    }

    // dual: implement step should have edit: true
    const dualConfig = loadWorkflowConfig('dual', testDir);
    expect(dualConfig).not.toBeNull();
    const implementStep = dualConfig!.steps.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.edit).toBe(true);
  });

  it('should set passPreviousResponse from YAML', () => {
    const config = loadWorkflowConfig('default', testDir);
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
    const config = loadWorkflowConfig('default', testDir);
    expect(config).not.toBeNull();

    const parallelStep = config!.steps.find(
      (s) => s.parallel && s.parallel.length > 0,
    );
    expect(parallelStep).toBeDefined();
    expect(parallelStep!.parallel!.length).toBeGreaterThanOrEqual(2);

    // Each sub-step should have required fields
    for (const sub of parallelStep!.parallel!) {
      expect(sub.name).toBeDefined();
      expect(sub.persona).toBeDefined();
      expect(sub.rules).toBeDefined();
    }
  });

  it('should load 2-stage parallel reviewers from the dual workflow', () => {
    const config = loadWorkflowConfig('dual', testDir);
    expect(config).not.toBeNull();

    const reviewers1 = config!.steps.find((s) => s.name === 'reviewers_1');
    expect(reviewers1).toBeDefined();
    expect(reviewers1!.parallel!.length).toBe(3);
    const stage1Names = reviewers1!.parallel!.map((s) => s.name);
    expect(stage1Names).toContain('arch-review');
    expect(stage1Names).toContain('frontend-review');
    expect(stage1Names).toContain('testing-review');

    const reviewers2 = config!.steps.find((s) => s.name === 'reviewers_2');
    expect(reviewers2).toBeDefined();
    expect(reviewers2!.parallel!.length).toBe(3);
    const stage2Names = reviewers2!.parallel!.map((s) => s.name);
    expect(stage2Names).toContain('security-review');
    expect(stage2Names).toContain('qa-review');
    expect(stage2Names).toContain('requirements-review');
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
    const config = loadWorkflowConfig('default', testDir);
    expect(config).not.toBeNull();

    // default workflow: plan step has output contracts
    const planStep = config!.steps.find((s) => s.name === 'plan');
    expect(planStep).toBeDefined();
    expect(planStep!.outputContracts).toBeDefined();
  });

  it('should load multi-report config from the dual workflow', () => {
    const config = loadWorkflowConfig('dual', testDir);
    expect(config).not.toBeNull();

    // implement step has multi-output contracts: [Scope, Decisions]
    const implementStep = config!.steps.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.outputContracts).toBeDefined();
    expect(Array.isArray(implementStep!.outputContracts)).toBe(true);
    expect((implementStep!.outputContracts as unknown[]).length).toBe(2);
  });
});

describe('Workflow Loader IT: quality_gates loading', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should parse quality_gates from YAML', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'with-gates.yaml'), `
name: with-gates
description: Workflow with quality gates
max_steps: 5
initial_step: implement

steps:
  - name: implement
    persona: coder
    edit: true
    quality_gates:
      - "All tests must pass"
      - "No TypeScript errors"
      - "Coverage must be above 80%"
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Implement the feature"
`);

    const config = loadWorkflowConfig('with-gates', testDir);

    expect(config).not.toBeNull();
    const implementStep = config!.steps.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.qualityGates).toBeDefined();
    expect(implementStep!.qualityGates).toEqual([
      'All tests must pass',
      'No TypeScript errors',
      'Coverage must be above 80%',
    ]);
  });

  it('should allow step without quality_gates', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'no-gates.yaml'), `
name: no-gates
description: Workflow without quality gates
max_steps: 5
initial_step: implement

steps:
  - name: implement
    persona: coder
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Implement the feature"
`);

    const config = loadWorkflowConfig('no-gates', testDir);

    expect(config).not.toBeNull();
    const implementStep = config!.steps.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.qualityGates).toBeUndefined();
  });

  it('should allow empty quality_gates array', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'empty-gates.yaml'), `
name: empty-gates
description: Workflow with empty quality gates
max_steps: 5
initial_step: implement

steps:
  - name: implement
    persona: coder
    quality_gates: []
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Implement the feature"
`);

    const config = loadWorkflowConfig('empty-gates', testDir);

    expect(config).not.toBeNull();
    const implementStep = config!.steps.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.qualityGates).toEqual([]);
  });
});

describe('Workflow Loader IT: mcp_servers parsing', () => {
  let testDir: string;
  const loadGlobalConfigMock = vi.mocked(loadGlobalConfig);

  beforeEach(() => {
    testDir = createTestDir();
    loadGlobalConfigMock.mockReturnValue({});
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should reject stdio mcp_servers from workflow YAML by default', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'with-mcp.yaml'), `
name: with-mcp
description: Workflow with MCP servers
max_steps: 5
initial_step: e2e-test

steps:
  - name: e2e-test
    persona: coder
    mcp_servers:
      playwright:
        command: npx
        args: ["-y", "@anthropic-ai/mcp-server-playwright"]
    provider_options:
      claude:
        allowed_tools:
          - Read
          - Bash
          - mcp__playwright__*
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Run E2E tests"
`);

    expect(() => loadWorkflowConfig('with-mcp', testDir)).toThrow(/workflow_mcp_servers/);
  });

  it('should allow step without mcp_servers', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'no-mcp.yaml'), `
name: no-mcp
description: Workflow without MCP servers
max_steps: 5
initial_step: implement

steps:
  - name: implement
    persona: coder
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Implement the feature"
`);

    const config = loadWorkflowConfig('no-mcp', testDir);

    expect(config).not.toBeNull();
    const implementStep = config!.steps.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.mcpServers).toBeUndefined();
  });

  it('should reject mcp_servers with multiple transports by default', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'multi-mcp.yaml'), `
name: multi-mcp
description: Workflow with multiple MCP servers
max_steps: 5
initial_step: test

steps:
  - name: test
    persona: coder
    mcp_servers:
      playwright:
        command: npx
        args: ["-y", "@anthropic-ai/mcp-server-playwright"]
      remote-api:
        type: http
        url: http://localhost:3000/mcp
        headers:
          Authorization: "Bearer token123"
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Run tests"
`);

    expect(() => loadWorkflowConfig('multi-mcp', testDir)).toThrow(/workflow_mcp_servers/);
  });

  it('should allow http/sse mcp_servers only when project config enables them', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      join(testDir, '.takt', 'config.yaml'),
      ['workflow_mcp_servers:', '  http: true', '  sse: true'].join('\n'),
      'utf-8',
    );

    writeFileSync(join(workflowsDir, 'remote-mcp.yaml'), `
name: remote-mcp
description: Workflow with remote MCP servers
max_steps: 5
initial_step: test

steps:
  - name: test
    persona: coder
    mcp_servers:
      remote-api:
        type: http
        url: https://example.com/mcp
      stream-api:
        type: sse
        url: https://example.com/sse
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Run tests"
`);

    const config = loadWorkflowConfig('remote-mcp', testDir);

    expect(config).not.toBeNull();
    const testStep = config!.steps.find((s) => s.name === 'test');
    expect(testStep?.mcpServers).toEqual({
      'remote-api': {
        type: 'http',
        url: 'https://example.com/mcp',
      },
      'stream-api': {
        type: 'sse',
        url: 'https://example.com/sse',
      },
    });
  });

  it('should allow stdio mcp_servers only when project config enables them', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'workflow_mcp_servers:\n  stdio: true\n');

    writeFileSync(join(workflowsDir, 'with-mcp.yaml'), `
name: with-mcp
description: Workflow with MCP servers
max_steps: 5
initial_step: e2e-test

steps:
  - name: e2e-test
    persona: coder
    mcp_servers:
      playwright:
        command: npx
        args: ["-y", "@anthropic-ai/mcp-server-playwright"]
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Run E2E tests"
`);

    const config = loadWorkflowConfig('with-mcp', testDir);

    expect(config).not.toBeNull();
    expect(config!.steps.find((s) => s.name === 'e2e-test')?.mcpServers).toEqual({
      playwright: {
        command: 'npx',
        args: ['-y', '@anthropic-ai/mcp-server-playwright'],
      },
    });
  });

  it('should deny transport when project config explicitly overrides global true with false', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      workflowMcpServers: { stdio: true },
    });
    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'workflow_mcp_servers:\n  stdio: false\n');

    writeFileSync(join(workflowsDir, 'denied-mcp.yaml'), `
name: denied-mcp
description: Workflow with stdio MCP denied by project
max_steps: 5
initial_step: test

steps:
  - name: test
    persona: coder
    mcp_servers:
      playwright:
        command: npx
        args: ["-y", "@anthropic-ai/mcp-server-playwright"]
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Run tests"
`);

    expect(() => loadWorkflowConfig('denied-mcp', testDir)).toThrow(/workflow_mcp_servers/);
  });

  it('should preserve globally allowed transports when project config enables another transport', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      workflowMcpServers: { stdio: true },
    });
    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'workflow_mcp_servers:\n  sse: true\n');

    writeFileSync(join(workflowsDir, 'mixed-mcp.yaml'), `
name: mixed-mcp
description: Workflow with stdio and sse MCP servers
max_steps: 5
initial_step: test

steps:
  - name: test
    persona: coder
    mcp_servers:
      playwright:
        command: npx
        args: ["-y", "@anthropic-ai/mcp-server-playwright"]
      stream-api:
        type: sse
        url: https://example.com/sse
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Run tests"
`);

    const config = loadWorkflowConfig('mixed-mcp', testDir);

    expect(config).not.toBeNull();
    expect(config!.steps.find((s) => s.name === 'test')?.mcpServers).toEqual({
      playwright: {
        command: 'npx',
        args: ['-y', '@anthropic-ai/mcp-server-playwright'],
      },
      'stream-api': {
        type: 'sse',
        url: 'https://example.com/sse',
      },
    });
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

    expect(() => loadWorkflowConfig('broken', testDir)).toThrow();
  });

  it('should throw for workflow missing required fields', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'incomplete.yaml'), `
name: incomplete
description: Missing steps
`);

    expect(() => loadWorkflowConfig('incomplete', testDir)).toThrow();
  });
});


describe('Workflow Loader IT: workflow runtime.prepare policy', () => {
  let testDir: string;
  const loadGlobalConfigMock = vi.mocked(loadGlobalConfig);

  beforeEach(() => {
    testDir = createTestDir();
    loadGlobalConfigMock.mockReturnValue({});
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects workflow runtime.prepare custom scripts by default', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'runtime-custom.yaml'), `
name: runtime-custom
workflow_config:
  runtime:
    prepare:
      - ./setup.sh
steps:
  - name: implement
    instruction: "Do the work"
`);

    expect(() => loadWorkflowConfig('runtime-custom', testDir)).toThrow(/workflow_runtime_prepare\.custom_scripts/);
  });

  it('allows workflow runtime.prepare gradle preset by default', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'runtime-gradle.yaml'), `
name: runtime-gradle
workflow_config:
  runtime:
    prepare:
      - gradle
steps:
  - name: implement
    instruction: "Do the work"
`);

    const config = loadWorkflowConfig('runtime-gradle', testDir);

    expect(config).not.toBeNull();
    expect(config!.runtime).toEqual({ prepare: ['gradle'] });
  });

  it('allows workflow runtime.prepare node preset by default', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'runtime-node.yaml'), `
name: runtime-node
workflow_config:
  runtime:
    prepare:
      - node
steps:
  - name: implement
    instruction: "Do the work"
`);

    const config = loadWorkflowConfig('runtime-node', testDir);

    expect(config).not.toBeNull();
    expect(config!.runtime).toEqual({ prepare: ['node'] });
  });

  it('allows workflow runtime.prepare custom scripts when project config enables them', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'workflow_runtime_prepare:\n  custom_scripts: true\n');
    writeFileSync(join(workflowsDir, 'runtime-custom.yaml'), `
name: runtime-custom
workflow_config:
  runtime:
    prepare:
      - ./setup.sh
steps:
  - name: implement
    instruction: "Do the work"
`);

    const config = loadWorkflowConfig('runtime-custom', testDir);

    expect(config).not.toBeNull();
    expect(config!.runtime).toEqual({ prepare: ['./setup.sh'] });
  });

  it('rejects workflow runtime.prepare custom scripts when global allows and project explicitly denies', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      workflowRuntimePrepare: { customScripts: true },
    });
    writeFileSync(
      join(testDir, '.takt', 'config.yaml'),
      'workflow_runtime_prepare:\n  custom_scripts: false\n',
    );
    writeFileSync(join(workflowsDir, 'runtime-custom.yaml'), `
name: runtime-custom
workflow_config:
  runtime:
    prepare:
      - ./setup.sh
steps:
  - name: implement
    instruction: "Do the work"
`);

    expect(() => loadWorkflowConfig('runtime-custom', testDir)).toThrow(/workflow_runtime_prepare\.custom_scripts/);
  });

  it('allows workflow runtime.prepare custom scripts when global denies and project explicitly allows', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      workflowRuntimePrepare: { customScripts: false },
    });
    writeFileSync(
      join(testDir, '.takt', 'config.yaml'),
      'workflow_runtime_prepare:\n  custom_scripts: true\n',
    );
    writeFileSync(join(workflowsDir, 'runtime-custom.yaml'), `
name: runtime-custom
workflow_config:
  runtime:
    prepare:
      - ./setup.sh
steps:
  - name: implement
    instruction: "Do the work"
`);

    const config = loadWorkflowConfig('runtime-custom', testDir);

    expect(config).not.toBeNull();
    expect(config!.runtime).toEqual({ prepare: ['./setup.sh'] });
  });

  it('preserves globally allowed runtime.prepare custom scripts when project config sets the policy block', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      workflowRuntimePrepare: { customScripts: true },
    });
    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'workflow_runtime_prepare: {}\n');
    writeFileSync(join(workflowsDir, 'runtime-custom.yaml'), `
name: runtime-custom
workflow_config:
  runtime:
    prepare:
      - ./setup.sh
steps:
  - name: implement
    instruction: "Do the work"
`);

    const config = loadWorkflowConfig('runtime-custom', testDir);

    expect(config).not.toBeNull();
    expect(config!.runtime).toEqual({ prepare: ['./setup.sh'] });
  });
});

describe('Workflow Loader IT: workflow Arpeggio policy', () => {
  let testDir: string;
  const loadGlobalConfigMock = vi.mocked(loadGlobalConfig);

  beforeEach(() => {
    testDir = createTestDir();
    loadGlobalConfigMock.mockReturnValue({});
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects custom Arpeggio capabilities by default', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(testDir, 'rows.csv'), 'value\nhello\n');
    writeFileSync(join(testDir, 'prompt.md'), 'Summarize {{rows}}');

    writeFileSync(join(workflowsDir, 'arpeggio-custom.yaml'), `
name: arpeggio-custom
steps:
  - name: summarize
    instruction: "unused"
    arpeggio:
      source: csv
      source_path: ../../rows.csv
      template: ../../prompt.md
      merge:
        strategy: custom
        inline_js: 'return results.map(r => r.content).join(\"\\n\");'
`);

    expect(() => loadWorkflowConfig('arpeggio-custom', testDir)).toThrow(/workflow_arpeggio\.custom_merge_inline_js/);
  });

  it('allows custom Arpeggio capabilities when project config enables them', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      join(testDir, '.takt', 'config.yaml'),
      [
        'workflow_arpeggio:',
        '  custom_data_source_modules: true',
        '  custom_merge_inline_js: true',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(join(testDir, 'rows.csv'), 'value\nhello\n');
    writeFileSync(join(testDir, 'prompt.md'), 'Summarize {{rows}}');

    writeFileSync(join(workflowsDir, 'arpeggio-custom.yaml'), `
name: arpeggio-custom
steps:
  - name: summarize
    instruction: "unused"
    arpeggio:
      source: custom-source
      source_path: ../../rows.csv
      template: ../../prompt.md
      merge:
        strategy: custom
        inline_js: 'return results.map(r => r.content).join(\"\\n\");'
`);

    const config = loadWorkflowConfig('arpeggio-custom', testDir);

    expect(config).not.toBeNull();
    expect(config!.steps[0]?.arpeggio?.source).toBe('custom-source');
    expect(config!.steps[0]?.arpeggio?.merge.inlineJs).toContain('join');
  });

  it('preserves globally allowed Arpeggio capabilities when project config enables another one', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    loadGlobalConfigMock.mockReturnValue({
      workflowArpeggio: { customDataSourceModules: true },
    });
    writeFileSync(
      join(testDir, '.takt', 'config.yaml'),
      ['workflow_arpeggio:', '  custom_merge_inline_js: true'].join('\n'),
      'utf-8',
    );
    writeFileSync(join(testDir, 'rows.csv'), 'value\nhello\n');
    writeFileSync(join(testDir, 'prompt.md'), 'Summarize {{rows}}');

    writeFileSync(join(workflowsDir, 'arpeggio-precedence.yaml'), `
name: arpeggio-precedence
steps:
  - name: summarize
    instruction: "unused"
    arpeggio:
      source: custom-source
      source_path: ../../rows.csv
      template: ../../prompt.md
      merge:
        strategy: custom
        inline_js: 'return results.map(r => r.content).join(\"\\n\");'
`);

    const config = loadWorkflowConfig('arpeggio-precedence', testDir);

    expect(config).not.toBeNull();
    expect(config!.steps[0]?.arpeggio?.source).toBe('custom-source');
    expect(config!.steps[0]?.arpeggio?.merge.inlineJs).toContain('join');
  });
});
