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
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
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

import {
  loadAllStandaloneWorkflowsWithSources,
  loadWorkflow,
} from '../infra/config/loaders/index.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { listBuiltinWorkflowNames } from '../infra/config/loaders/workflowResolver.js';
import { loadGlobalConfig } from '../infra/config/global/globalConfig.js';
import { validateWorkflowConfig } from '../core/workflow/engine/WorkflowValidator.js';
import { getLanguageResourcesDir } from '../infra/resources/index.js';

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

  it.each(['en', 'ja'] as const)('should load every %s builtin standalone workflow without warnings', (language) => {
    languageState.value = language;
    const onWarning = vi.fn();

    const workflows = loadAllStandaloneWorkflowsWithSources(testDir, { onWarning });

    expect(workflows.size).toBeGreaterThan(0);
    expect(Array.from(workflows.values()).every(({ source }) => source === 'builtin')).toBe(true);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it.each(['en', 'ja'] as const)(
    'should keep scenario contracts opt-in across representative %s builtin compositions',
    (language) => {
      languageState.value = language;
      const partial = (facetKind: 'instructions' | 'output-contracts', name: string): string =>
        readFileSync(
          join(
            getLanguageResourcesDir(language),
            'facets',
            'partials',
            facetKind,
            `${name}.md`,
          ),
          'utf-8',
        ).trim();
      const step = (workflowName: string, stepName: string) => {
        const workflow = loadWorkflow(workflowName, testDir);
        expect(workflow, `${workflowName} should load`).not.toBeNull();
        const resolvedStep = workflow!.steps.find((candidate) => candidate.name === stepName);
        expect(resolvedStep, `${workflowName}.${stepName} should exist`).toBeDefined();
        return resolvedStep!;
      };
      const instruction = (workflowName: string, stepName: string): string => {
        const resolvedStep = step(workflowName, stepName);
        expect(resolvedStep.kind).toBe('agent');
        return (resolvedStep as { instruction: string }).instruction;
      };
      const reportFormat = (workflowName: string, stepName: string): string => {
        const resolvedStep = step(workflowName, stepName);
        expect(resolvedStep.kind).toBe('agent');
        const reports = (resolvedStep as {
          outputContracts?: Array<{ format: string }>;
        }).outputContracts;
        expect(reports).toHaveLength(1);
        return reports![0]!.format;
      };

      const planning = partial('instructions', 'requirement-scenario-planning');
      const testMapping = partial('instructions', 'requirement-scenario-test-mapping');
      const maintenance = partial('instructions', 'requirement-scenario-maintenance');
      const verification = partial('instructions', 'requirement-scenario-verification');
      const scenarioPlanReport = partial('output-contracts', 'requirement-scenarios-plan');
      const scenarioFixPlanReport = partial('output-contracts', 'requirement-scenarios-fix-plan');
      const scenarioTestReport = partial('output-contracts', 'requirement-scenarios-test-report');

      expect(instruction('development-core', 'plan')).not.toContain(planning);
      expect(reportFormat('development-core', 'plan')).not.toContain(scenarioPlanReport);
      expect(instruction('development-core', 'write_tests')).not.toContain(testMapping);
      expect(reportFormat('development-core', 'write_tests')).not.toContain(scenarioTestReport);
      expect(instruction('development-core', 'replan')).not.toContain(maintenance);
      expect(instruction('development-remediation', 'fix-plan')).not.toContain(maintenance);
      expect(reportFormat('development-remediation', 'fix-plan'))
        .not.toContain(scenarioFixPlanReport);
      expect(instruction('development-remediation-dynamic', 'fix-plan')).not.toContain(maintenance);
      expect(reportFormat('development-remediation-dynamic', 'fix-plan'))
        .not.toContain(scenarioFixPlanReport);
      expect(instruction('peer-review', 'final-gate')).not.toContain(verification);
      expect(instruction('simple-core', 'plan')).not.toContain(planning);
      expect(reportFormat('simple-core', 'plan')).not.toContain(scenarioPlanReport);
      expect(instruction('simple-core', 'write_tests')).not.toContain(testMapping);
      expect(reportFormat('simple-core', 'write_tests')).not.toContain(scenarioTestReport);
      expect(instruction('review-remediation', 'fix-plan')).not.toContain(maintenance);
      expect(reportFormat('review-remediation', 'fix-plan')).not.toContain(scenarioFixPlanReport);
      expect(instruction('review-default', 'merge-readiness-review')).not.toContain(verification);
      expect(instruction('merge-readiness-final-gate', 'merge-readiness-review'))
        .not.toContain(verification);
      expect(instruction('merge-readiness-final-gate', 'supervise')).not.toContain(verification);
      expect(instruction('merge-readiness-dual-final-gate', 'merge-readiness-review'))
        .not.toContain(verification);
      expect(instruction('merge-readiness-dual-final-gate', 'supervise'))
        .not.toContain(verification);
      expect(instruction('terraform', 'plan')).not.toContain(planning);
      expect(reportFormat('terraform', 'plan')).not.toContain(scenarioPlanReport);
      expect(instruction('terraform', 'merge-readiness-review')).not.toContain(verification);
    },
  );

  it('should return null for non-existent workflow', () => {
    const config = loadWorkflow('non-existent-workflow-xyz', testDir);
    expect(config).toBeNull();
  });

  it('should reject workflow files when pr_selection.where does not match pr_list.where', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    const workflowPath = join(workflowsDir, 'invalid-pr-selection.yaml');

    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(workflowPath, `
name: invalid-pr-selection
initial_step: route_context
max_steps: 2
steps:
  - name: route_context
    mode: system
    system_inputs:
      - type: pr_list
        source: current_project
        as: prs
        where:
          head_branch: takt/*
          draft: false
      - type: pr_selection
        source: current_project
        as: selected_pr
        where:
          head_branch: feature/*
          draft: false
    rules:
      - condition: "when(true)"
        next: COMPLETE
`, 'utf-8');

    expect(() => loadWorkflowFromFile(workflowPath, testDir)).toThrow(
      'pr_selection.where must match a pr_list.where in the same step',
    );
  });

  it('should reject workflow files when issue_list.exclude_selected_from does not match an earlier issue_selection binding', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    const workflowPath = join(workflowsDir, 'invalid-issue-selection-reference.yaml');

    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(workflowPath, `
name: invalid-issue-selection-reference
initial_step: route_context
max_steps: 2
steps:
  - name: route_context
    mode: system
    system_inputs:
      - type: issue_selection
        source: current_project
        as: selected_issue
      - type: issue_list
        source: current_project
        as: tracked_issues
        exclude_selected_from: missing_issue_selection
    rules:
      - condition: "when(true)"
        next: COMPLETE
`, 'utf-8');

    expect(() => loadWorkflowFromFile(workflowPath, testDir)).toThrow(
      'issue_list.exclude_selected_from must match an earlier issue_selection.as in the same step',
    );
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

  it('should defer bare OpenCode loop judge model rejection to effective config validation', () => {
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

    const config = loadWorkflow('loop-monitor-judge-opencode-bare-model', testDir);

    expect(config).not.toBeNull();
    expect(() => validateWorkflowConfig(config!, { projectCwd: testDir }))
      .toThrow("Configuration error: loop_monitors.judge.model");
  });

  it('should defer inherited bare OpenCode loop judge model rejection to effective config validation', () => {
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

    const config = loadWorkflow('loop-monitor-judge-inherited-opencode-bare-model', testDir);

    expect(config).not.toBeNull();
    expect(() => validateWorkflowConfig(config!, { projectCwd: testDir }))
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

describe('Workflow Loader IT: quality_gates loading', () => {
  let testDir: string;
  const loadGlobalConfigMock = vi.mocked(loadGlobalConfig);

  beforeEach(() => {
    testDir = createTestDir();
    loadGlobalConfigMock.mockReturnValue({});
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

  it('should parse mixed string and command quality_gates from YAML', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'workflow_command_gates:\n  custom_scripts: true\n');

    writeFileSync(join(workflowsDir, 'mixed-gates.yaml'), `
name: mixed-gates
description: Workflow with mixed quality gates
max_steps: 5
initial_step: implement

steps:
  - name: implement
    persona: coder
    edit: true
    quality_gates:
      - "All tests must pass"
      - type: command
        name: quality-check
        command: "./.takt/quality-gates/check.sh"
        cwd: "."
        timeout_ms: 300000
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Implement the feature"
`);

    const config = loadWorkflowConfig('mixed-gates', testDir);

    expect(config).not.toBeNull();
    const implementStep = config!.steps.find((s) => s.name === 'implement');
    expect(implementStep).toBeDefined();
    expect(implementStep!.qualityGates).toEqual([
      'All tests must pass',
      {
        type: 'command',
        name: 'quality-check',
        command: './.takt/quality-gates/check.sh',
        cwd: '.',
        timeoutMs: 300000,
      },
    ]);
  });

  it('should load a callable command quality gate with timeout_ms from YAML', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(testDir, '.takt', 'config.yaml'), 'workflow_command_gates:\n  custom_scripts: true\n');

    writeFileSync(join(workflowsDir, 'callable-command-gate.yaml'), `
name: callable-command-gate
description: Callable workflow with a command quality gate timeout
subworkflow:
  callable: true
  visibility: internal
max_steps: 5
initial_step: implement

steps:
  - name: implement
    persona: coder
    edit: true
    quality_gates:
      - type: command
        name: quality-check
        command: "./.takt/quality-gates/check.sh"
        timeout_ms: 900000
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Implement the feature"
`);

    const config = loadWorkflowConfig('callable-command-gate', testDir);

    expect(config).not.toBeNull();
    expect(config!.steps.find((step) => step.name === 'implement')?.qualityGates).toEqual([
      {
        type: 'command',
        name: 'quality-check',
        command: './.takt/quality-gates/check.sh',
        timeoutMs: 900000,
      },
    ]);
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
