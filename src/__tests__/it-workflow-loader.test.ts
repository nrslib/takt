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

import { loadWorkflow } from '../infra/config/loaders/index.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { loadGlobalConfig } from '../infra/config/global/globalConfig.js';
import { validateWorkflowConfig } from '../core/workflow/engine/WorkflowValidator.js';

const loadWorkflowConfig = loadWorkflow;
// --- Test helpers ---

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-wfl-'));
  mkdirSync(join(dir, '.takt'), { recursive: true });
  return dir;
}

function expectWorkflowLoadIssue(
  workflowName: string,
  projectDir: string,
  expectedPath: readonly PropertyKey[],
): void {
  try {
    loadWorkflow(workflowName, projectDir);
    expect.fail(`Expected ${workflowName} to fail workflow validation`);
  } catch (error) {
    expect(error).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: expectedPath,
          message: expect.stringContaining('runtime.yaml'),
        }),
      ]),
    });
  }
}

describe('Workflow Loader IT: workflow validation', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
    languageState.value = 'en';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

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

  it('should reject loop monitor judge provider and model overrides', () => {
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

    expectWorkflowLoadIssue(
      'loop-monitor-judge-provider-model',
      testDir,
      ['loop_monitors', 0, 'judge', 'provider'],
    );
  });

  it('should reject loop monitor judge provider block overrides', () => {
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

    expectWorkflowLoadIssue(
      'loop-monitor-judge-provider-block',
      testDir,
      ['loop_monitors', 0, 'judge', 'provider'],
    );
  });

  it('should reject loop monitor judge model-only overrides', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'loop-monitor-judge-model-only.yaml'), `
name: loop-monitor-judge-model-only
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
      model: opencode/model-b
      instruction: "Judge instruction"
      rules:
        - condition: continue
          next: step2
`);

    expectWorkflowLoadIssue(
      'loop-monitor-judge-model-only',
      testDir,
      ['loop_monitors', 0, 'judge', 'model'],
    );
  });

  it('should reject bare OpenCode loop judge model at the workflow boundary', () => {
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

    expectWorkflowLoadIssue(
      'loop-monitor-judge-opencode-bare-model',
      testDir,
      ['loop_monitors', 0, 'judge', 'provider'],
    );
  });

  it('should reject inherited bare OpenCode loop judge model at the workflow boundary', () => {
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

    expectWorkflowLoadIssue(
      'loop-monitor-judge-inherited-opencode-bare-model',
      testDir,
      ['loop_monitors', 0, 'judge', 'model'],
    );
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
