/**
 * Tests for getWorkflowDescription, buildWorkflowString, and buildStepPreviews
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { getWorkflowDescription } from '../infra/config/loaders/workflowResolver.js';

const getWorkflowSummary = getWorkflowDescription;
const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;

function isolateConfig(configDir: string): void {
  mkdirSync(configDir, { recursive: true });
  process.env.TAKT_CONFIG_DIR = configDir;
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
}

function restoreConfig(): void {
  if (originalTaktConfigDir === undefined) {
    delete process.env.TAKT_CONFIG_DIR;
  } else {
    process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
  }
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
}

function writeProjectConfig(projectDir: string, body: string): void {
  const configDir = join(projectDir, '.takt');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), body, 'utf-8');
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
}

describe('getWorkflowDescription', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-workflow-resolver-'));
    isolateConfig(join(tempDir, '.global-takt'));
  });

  afterEach(() => {
    restoreConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return workflow structure with sequential steps', () => {
    const workflowYaml = `name: test-workflow
description: Test workflow
initial_step: plan
max_steps: 3

steps:
  - name: plan
    description: タスク計画
    persona: planner
    instruction: "Plan the task"
  - name: implement
    description: 実装
    persona: coder
    instruction: "Implement"
  - name: review
    persona: reviewer
    instruction: "Review"
`;

    const workflowPath = join(tempDir, 'test.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir);

    expect(result.name).toBe('test-workflow');
    expect(result.description).toBe('Test workflow');
    expect(result.workflowStructure).toBe(
      '1. plan (タスク計画)\n2. implement (実装)\n3. review'
    );
    expect(result.stepPreviews).toEqual([]);
  });

  it('should return workflow structure with parallel steps', () => {
    const workflowYaml = `name: coding
description: Full coding workflow
initial_step: plan
max_steps: 10

steps:
  - name: plan
    description: タスク計画
    persona: planner
    instruction: "Plan"
  - name: reviewers
    description: 並列レビュー
    parallel:
      - name: ai_review
        persona: ai-reviewer
        instruction: "AI review"
      - name: arch_review
        persona: arch-reviewer
        instruction: "Architecture review"
  - name: fix
    description: 修正
    persona: coder
    instruction: "Fix"
`;

    const workflowPath = join(tempDir, 'coding.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir);

    expect(result.name).toBe('coding');
    expect(result.description).toBe('Full coding workflow');
    expect(result.workflowStructure).toBe(
      '1. plan (タスク計画)\n' +
      '2. reviewers (並列レビュー)\n' +
      '   - ai_review\n' +
      '   - arch_review\n' +
      '3. fix (修正)'
    );
    expect(result.stepPreviews).toEqual([]);
  });

  it('should handle steps without descriptions', () => {
    const workflowYaml = `name: minimal
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "Do step1"
  - name: step2
    persona: coder
    instruction: "Do step2"
`;

    const workflowPath = join(tempDir, 'minimal.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir);

    expect(result.name).toBe('minimal');
    expect(result.description).toBe('');
    expect(result.workflowStructure).toBe('1. step1\n2. step2');
    expect(result.stepPreviews).toEqual([]);
  });

  it('should return empty strings when workflow is not found', () => {
    const result = getWorkflowSummary('nonexistent', tempDir);

    expect(result.name).toBe('nonexistent');
    expect(result.description).toBe('');
    expect(result.workflowStructure).toBe('');
    expect(result.stepPreviews).toEqual([]);
  });

  it('should handle parallel steps without descriptions', () => {
    const workflowYaml = `name: test-parallel
initial_step: parent
max_steps: 1

steps:
  - name: parent
    parallel:
      - name: child1
        persona: agent1
        instruction: "Do child1"
      - name: child2
        persona: agent2
        instruction: "Do child2"
`;

    const workflowPath = join(tempDir, 'test-parallel.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir);

    expect(result.workflowStructure).toBe(
      '1. parent\n' +
      '   - child1\n' +
      '   - child2'
    );
    expect(result.stepPreviews).toEqual([]);
  });
});

describe('getWorkflowDescription with stepPreviews', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-previews-'));
    isolateConfig(join(tempDir, '.global-takt'));
  });

  afterEach(() => {
    restoreConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return step previews when previewCount is specified', () => {
    const workflowYaml = `name: preview-test
description: Test workflow
initial_step: plan
max_steps: 5
workflow_config:
  provider: claude

steps:
  - name: plan
    description: Planning
    persona: Plan the task
    instruction: "Create a plan for {task}"
    provider_options:
      claude:
        allowed_tools:
          - Read
          - Glob
    rules:
      - condition: plan complete
        next: implement
  - name: implement
    description: Implementation
    persona: Implement the code
    instruction: "Implement according to plan"
    edit: true
    provider_options:
      claude:
        allowed_tools:
          - Read
          - Edit
          - Bash
    rules:
      - condition: done
        next: review
  - name: review
    persona: Review the code
    instruction: "Review changes"
    rules:
      - condition: approved
        next: COMPLETE
`;

    const workflowPath = join(tempDir, 'preview-test.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir, 3);

    expect(result.stepPreviews).toHaveLength(3);

    // First step: plan
    expect(result.stepPreviews[0].name).toBe('plan');
    expect(result.stepPreviews[0].personaContent).toBe('Plan the task');
    expect(result.stepPreviews[0].instructionContent).toBe('Create a plan for {task}');
    expect(result.stepPreviews[0].allowedTools).toEqual(['Read', 'Glob']);
    expect(result.stepPreviews[0].canEdit).toBe(false);

    // Second step: implement
    expect(result.stepPreviews[1].name).toBe('implement');
    expect(result.stepPreviews[1].personaContent).toBe('Implement the code');
    expect(result.stepPreviews[1].instructionContent).toBe('Implement according to plan');
    expect(result.stepPreviews[1].allowedTools).toEqual(['Read', 'Edit', 'Bash']);
    expect(result.stepPreviews[1].canEdit).toBe(true);

    // Third step: review
    expect(result.stepPreviews[2].name).toBe('review');
    expect(result.stepPreviews[2].personaContent).toBe('Review the code');
    expect(result.stepPreviews[2].canEdit).toBe(false);
  });

  it('should resolve preview tools from project config and apply readonly filtering', () => {
    writeProjectConfig(tempDir, `provider: claude
provider_options:
  claude:
    allowed_tools:
      - Read
      - Write
      - Bash
`);

    const workflowYaml = `name: preview-config-tools
initial_step: plan
max_steps: 1
workflow_config:
  provider: claude

steps:
  - name: plan
    persona: planner
    instruction: "Plan the task"
    output_contracts:
      report:
        - name: report
          format: markdown
`;

    const workflowPath = join(tempDir, 'preview-config-tools.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir, 1);

    expect(result.stepPreviews[0]?.allowedTools).toEqual(['Read', 'Bash']);
  });

  it('should fail fast when preview tools are configured for a non-Claude provider', () => {
    const workflowYaml = `name: preview-invalid-tools
initial_step: plan
max_steps: 1
workflow_config:
  provider: cursor

steps:
  - name: plan
    persona: planner
    instruction: "Plan the task"
    provider_options:
      claude:
        allowed_tools:
          - Read
`;

    const workflowPath = join(tempDir, 'preview-invalid-tools.yaml');
    writeFileSync(workflowPath, workflowYaml);

    expect(() => getWorkflowSummary(workflowPath, tempDir, 1))
      .toThrow('provider_options.claude.allowed_tools is not supported for provider "cursor"');
  });

  it('should return empty previews when previewCount is 0', () => {
    const workflowYaml = `name: test
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: agent
    instruction: "Do step1"
`;

    const workflowPath = join(tempDir, 'test.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir, 0);

    expect(result.stepPreviews).toEqual([]);
  });

  it('should return empty previews when previewCount is not specified', () => {
    const workflowYaml = `name: test
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: agent
    instruction: "Do step1"
`;

    const workflowPath = join(tempDir, 'test.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir);

    expect(result.stepPreviews).toEqual([]);
  });

  it('should stop at COMPLETE step', () => {
    const workflowYaml = `name: test-complete
initial_step: step1
max_steps: 3

steps:
  - name: step1
    persona: agent1
    instruction: "Step 1"
    rules:
      - condition: done
        next: COMPLETE
  - name: step2
    persona: agent2
    instruction: "Step 2"
`;

    const workflowPath = join(tempDir, 'test-complete.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir, 5);

    expect(result.stepPreviews).toHaveLength(1);
    expect(result.stepPreviews[0].name).toBe('step1');
  });

  it('should stop at ABORT step', () => {
    const workflowYaml = `name: test-abort
initial_step: step1
max_steps: 3

steps:
  - name: step1
    persona: agent1
    instruction: "Step 1"
    rules:
      - condition: abort
        next: ABORT
  - name: step2
    persona: agent2
    instruction: "Step 2"
`;

    const workflowPath = join(tempDir, 'test-abort.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir, 5);

    expect(result.stepPreviews).toHaveLength(1);
    expect(result.stepPreviews[0].name).toBe('step1');
  });

  it('should read persona content from file when personaPath is set', () => {
    const workflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    const personaContent = '# Planner Persona\nYou are a planning expert.';
    const personaPath = join(workflowsDir, 'planner.md');
    writeFileSync(personaPath, personaContent);

    const workflowYaml = `name: test-persona-file
initial_step: plan
max_steps: 1

personas:
  planner: ./planner.md

steps:
  - name: plan
    persona: planner
    instruction: "Plan the task"
`;

    const workflowPath = join(workflowsDir, 'test-persona-file.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir, 1);

    expect(result.stepPreviews).toHaveLength(1);
    expect(result.stepPreviews[0].name).toBe('plan');
    expect(result.stepPreviews[0].personaContent).toBe(personaContent);
  });

  it('should limit previews to maxCount', () => {
    const workflowYaml = `name: test-limit
initial_step: step1
max_steps: 5

steps:
  - name: step1
    persona: agent1
    instruction: "Step 1"
    rules:
      - condition: done
        next: step2
  - name: step2
    persona: agent2
    instruction: "Step 2"
    rules:
      - condition: done
        next: step3
  - name: step3
    persona: agent3
    instruction: "Step 3"
`;

    const workflowPath = join(tempDir, 'test-limit.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir, 2);

    expect(result.stepPreviews).toHaveLength(2);
    expect(result.stepPreviews[0].name).toBe('step1');
    expect(result.stepPreviews[1].name).toBe('step2');
  });

  it('should handle steps without rules (stop after first)', () => {
    const workflowYaml = `name: test-no-rules
initial_step: step1
max_steps: 3

steps:
  - name: step1
    persona: agent1
    instruction: "Step 1"
  - name: step2
    persona: agent2
    instruction: "Step 2"
`;

    const workflowPath = join(tempDir, 'test-no-rules.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir, 3);

    expect(result.stepPreviews).toHaveLength(1);
    expect(result.stepPreviews[0].name).toBe('step1');
  });

  it('should return empty previews when initial step not found in list', () => {
    const workflowYaml = `name: test-missing-initial
initial_step: nonexistent
max_steps: 1

steps:
  - name: step1
    persona: agent
    instruction: "Do something"
`;

    const workflowPath = join(tempDir, 'test-missing-initial.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir, 3);

    expect(result.stepPreviews).toEqual([]);
  });

  it('should handle self-referencing rule (prevent infinite loop)', () => {
    const workflowYaml = `name: test-self-ref
initial_step: step1
max_steps: 5

steps:
  - name: step1
    persona: agent1
    instruction: "Step 1"
    rules:
      - condition: loop
        next: step1
`;

    const workflowPath = join(tempDir, 'test-self-ref.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir, 5);

    expect(result.stepPreviews).toHaveLength(1);
    expect(result.stepPreviews[0].name).toBe('step1');
  });

  it('should handle multi-node cycle A→B→A (prevent duplicate previews)', () => {
    const workflowYaml = `name: test-cycle
initial_step: stepA
max_steps: 10

steps:
  - name: stepA
    persona: agentA
    instruction: "Step A"
    rules:
      - condition: next
        next: stepB
  - name: stepB
    persona: agentB
    instruction: "Step B"
    rules:
      - condition: back
        next: stepA
`;

    const workflowPath = join(tempDir, 'test-cycle.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir, 10);

    expect(result.stepPreviews).toHaveLength(2);
    expect(result.stepPreviews[0].name).toBe('stepA');
    expect(result.stepPreviews[1].name).toBe('stepB');
  });

  it('should return empty stepPreviews when workflow is not found', () => {
    const result = getWorkflowSummary('nonexistent', tempDir, 3);

    expect(result.stepPreviews).toEqual([]);
  });

  it('should use inline persona content when no personaPath', () => {
    const workflowYaml = `name: test-inline
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: You are an inline persona
    instruction: "Do something"
`;

    const workflowPath = join(tempDir, 'test-inline.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir, 1);

    expect(result.stepPreviews).toHaveLength(1);
    expect(result.stepPreviews[0].personaContent).toBe('You are an inline persona');
  });

  it('should fallback to empty personaContent when personaPath file becomes unreadable', () => {
    const workflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    // Create the persona file so it passes existsSync during parsing
    const personaPath = join(workflowsDir, 'unreadable-persona.md');
    writeFileSync(personaPath, '# Persona content');
    // Make the file unreadable so readFileSync fails while building step previews
    chmodSync(personaPath, 0o000);

    const workflowYaml = `name: test-unreadable-persona
initial_step: plan
max_steps: 1

personas:
  planner: ./unreadable-persona.md

steps:
  - name: plan
    persona: planner
    instruction: "Plan the task"
`;

    const workflowPath = join(workflowsDir, 'test-unreadable-persona.yaml');
    writeFileSync(workflowPath, workflowYaml);

    try {
      const result = getWorkflowSummary(workflowPath, tempDir, 1);

      expect(result.stepPreviews).toHaveLength(1);
      expect(result.stepPreviews[0].name).toBe('plan');
      expect(result.stepPreviews[0].personaContent).toBe('');
      expect(result.stepPreviews[0].instructionContent).toBe('Plan the task');
    } finally {
      // Restore permissions so cleanup can remove the file
      chmodSync(personaPath, 0o644);
    }
  });

  it('should include personaDisplayName in previews', () => {
    const workflowYaml = `name: test-display
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: agent
    persona_name: Custom Agent Name
    instruction: "Do something"
`;

    const workflowPath = join(tempDir, 'test-display.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir, 1);

    expect(result.stepPreviews).toHaveLength(1);
    expect(result.stepPreviews[0].personaDisplayName).toBe('Custom Agent Name');
  });
});

describe('getWorkflowDescription interactiveMode field', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-interactive-mode-'));
    isolateConfig(join(tempDir, '.global-takt'));
  });

  afterEach(() => {
    restoreConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return interactiveMode when workflow defines interactive_mode', () => {
    const workflowYaml = `name: test-mode
initial_step: step1
max_steps: 1
interactive_mode: quiet

steps:
  - name: step1
    persona: agent
    instruction: "Do something"
`;

    const workflowPath = join(tempDir, 'test-mode.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir);

    expect(result.interactiveMode).toBe('quiet');
  });

  it('should return undefined interactiveMode when workflow omits interactive_mode', () => {
    const workflowYaml = `name: test-no-mode
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: agent
    instruction: "Do something"
`;

    const workflowPath = join(tempDir, 'test-no-mode.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir);

    expect(result.interactiveMode).toBeUndefined();
  });

  it('should return interactiveMode for each valid mode value', () => {
    for (const mode of ['assistant', 'persona', 'quiet', 'passthrough'] as const) {
      const workflowYaml = `name: test-${mode}
initial_step: step1
max_steps: 1
interactive_mode: ${mode}

steps:
  - name: step1
    persona: agent
    instruction: "Do something"
`;

      const workflowPath = join(tempDir, `test-${mode}.yaml`);
      writeFileSync(workflowPath, workflowYaml);

      const result = getWorkflowSummary(workflowPath, tempDir);

      expect(result.interactiveMode).toBe(mode);
    }
  });
});

describe('getWorkflowDescription firstStep field', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-first-step-'));
    isolateConfig(join(tempDir, '.global-takt'));
  });

  afterEach(() => {
    restoreConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return firstStep with inline persona content', () => {
    const workflowYaml = `name: test-first
initial_step: plan
max_steps: 1
workflow_config:
  provider: claude

steps:
  - name: plan
    persona: You are a planner.
    persona_name: Planner
    instruction: "Plan the task"
    provider_options:
      claude:
        allowed_tools:
          - Read
          - Glob
`;

    const workflowPath = join(tempDir, 'test-first.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir);

    expect(result.firstStep).toBeDefined();
    expect(result.firstStep!.personaContent).toBe('You are a planner.');
    expect(result.firstStep!.personaDisplayName).toBe('Planner');
    expect(result.firstStep!.allowedTools).toEqual(['Read', 'Glob']);
  });

  it('should resolve firstStep tools from project config with the same rules as execution', () => {
    writeProjectConfig(tempDir, `provider: claude
provider_options:
  claude:
    allowed_tools:
      - Read
      - Write
      - Bash
`);

    const workflowYaml = `name: test-first-config-tools
initial_step: plan
max_steps: 1
workflow_config:
  provider: claude

steps:
  - name: plan
    persona: You are a planner.
    persona_name: Planner
    instruction: "Plan the task"
    output_contracts:
      report:
        - name: report
          format: markdown
`;

    const workflowPath = join(tempDir, 'test-first-config-tools.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir);

    expect(result.firstStep).toBeDefined();
    expect(result.firstStep!.allowedTools).toEqual(['Read', 'Bash']);
  });

  it('should return firstStep with persona file content', () => {
    const workflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    const personaContent = '# Expert Planner\nYou plan tasks with precision.';
    const personaPath = join(workflowsDir, 'planner-persona.md');
    writeFileSync(personaPath, personaContent);

    const workflowYaml = `name: test-persona-file
initial_step: plan
max_steps: 1

personas:
  planner: ./planner-persona.md

steps:
  - name: plan
    persona: planner
    persona_name: Planner
    instruction: "Plan the task"
`;

    const workflowPath = join(workflowsDir, 'test-persona-file.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir);

    expect(result.firstStep).toBeDefined();
    expect(result.firstStep!.personaContent).toBe(personaContent);
  });

  it('should return undefined firstStep when initial_step is not found', () => {
    const workflowYaml = `name: test-missing
initial_step: nonexistent
max_steps: 1

steps:
  - name: step1
    persona: agent
    instruction: "Do something"
`;

    const workflowPath = join(tempDir, 'test-missing.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir);

    expect(result.firstStep).toBeUndefined();
  });

  it('should return empty allowedTools array when step has no tools', () => {
    const workflowYaml = `name: test-no-tools
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: agent
    persona_name: Agent
    instruction: "Do something"
`;

    const workflowPath = join(tempDir, 'test-no-tools.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const result = getWorkflowSummary(workflowPath, tempDir);

    expect(result.firstStep).toBeDefined();
    expect(result.firstStep!.allowedTools).toEqual([]);
  });

  it('should fallback to inline persona when personaPath is unreadable', () => {
    const workflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    const personaPath = join(workflowsDir, 'unreadable.md');
    writeFileSync(personaPath, '# Persona');
    chmodSync(personaPath, 0o000);

    const workflowYaml = `name: test-fallback
initial_step: step1
max_steps: 1

personas:
  myagent: ./unreadable.md

steps:
  - name: step1
    persona: myagent
    persona_name: Agent
    instruction: "Do something"
`;

    const workflowPath = join(workflowsDir, 'test-fallback.yaml');
    writeFileSync(workflowPath, workflowYaml);

    try {
      const result = getWorkflowSummary(workflowPath, tempDir);

      expect(result.firstStep).toBeDefined();
      // personaPath is unreadable, so fallback to empty (persona was resolved to a path)
      expect(result.firstStep!.personaContent).toBe('');
    } finally {
      chmodSync(personaPath, 0o644);
    }
  });
});
