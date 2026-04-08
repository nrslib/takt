import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

import { listBuiltinWorkflowNames, loadWorkflow } from '../infra/config/loaders/index.js';

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-workflow-'));
  mkdirSync(join(dir, '.takt'), { recursive: true });
  return dir;
}

describe('Workflow Loader IT: canonical workflow loading', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
    languageState.value = 'en';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load builtin workflows through the workflow API', () => {
    // Given
    const builtinNames = listBuiltinWorkflowNames(testDir, { includeDisabled: true });

    // When
    const config = loadWorkflow('default', testDir);

    // Then
    expect(builtinNames).toContain('default');
    expect(config).not.toBeNull();
    expect(config!.name).toBe('default');
    expect(config!.steps.length).toBeGreaterThan(0);
    expect(config!.initialStep).toBeDefined();
    expect(config!.maxSteps).toBeGreaterThan(0);
  });

  it('should load project-local workflows only from .takt/workflows', () => {
    // Given
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    const agentsDir = join(testDir, '.takt', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'custom.md'), 'Custom agent');

    writeFileSync(join(workflowsDir, 'custom.yaml'), `
name: custom
description: Custom project workflow
max_steps: 5
initial_step: start

steps:
  - name: start
    persona: ../agents/custom.md
    instruction: "Do the work"
    rules:
      - condition: Done
        next: COMPLETE
`);

    // When
    const config = loadWorkflow('custom', testDir);

    // Then
    expect(config).not.toBeNull();
    expect(config!.name).toBe('custom');
    expect(config!.steps).toHaveLength(1);
    expect(config!.steps[0]!.name).toBe('start');
  });

  it('should not resolve project-local workflows from the removed legacy workflow directory', () => {
    // Given
    const legacyWorkflowsDir = join(testDir, '.takt', 'pieces');
    mkdirSync(legacyWorkflowsDir, { recursive: true });

    writeFileSync(join(legacyWorkflowsDir, 'legacy-only.yaml'), `
name: legacy-only
max_steps: 2
initial_step: start
steps:
  - name: start
    persona: ../agents/custom.md
    instruction: "Legacy directory should not be read"
    rules:
      - condition: Done
        next: COMPLETE
`);

    // When
    const config = loadWorkflow('legacy-only', testDir);

    // Then
    expect(config).toBeNull();
  });

  it('should not let entries in the removed legacy workflow directory shadow builtin workflows', () => {
    // Given
    const legacyWorkflowsDir = join(testDir, '.takt', 'pieces');
    mkdirSync(legacyWorkflowsDir, { recursive: true });

    writeFileSync(join(legacyWorkflowsDir, 'default.yaml'), `
name: default
description: Legacy override
max_steps: 1
initial_step: legacy
steps:
  - name: legacy
    instruction: "Legacy directory should not shadow builtin workflows"
    rules:
      - condition: done
        next: COMPLETE
`);

    // When
    const config = loadWorkflow('default', testDir);

    // Then
    expect(config).not.toBeNull();
    expect(config!.name).toBe('default');
    expect(config!.initialStep).not.toBe('legacy');
  });

  it('should reject legacy workflow YAML keys', () => {
    // Given
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    writeFileSync(join(workflowsDir, 'legacy-keys.yaml'), `
name: legacy-keys
max_steps: 3
initial_movement: plan
steps:
  - name: plan
    instruction: "Legacy keys must fail"
    rules:
      - condition: done
        next: COMPLETE
`);

    // Then
    expect(() => loadWorkflow('legacy-keys', testDir)).toThrow(/initial_movement/i);
  });

  it.each([
    {
      name: 'removed_step_list_key',
      yaml: `
name: legacy-step-list
movements:
  - name: plan
    instruction: "Legacy keys must fail"
    rules:
      - condition: done
        next: COMPLETE
`,
      expected: /movements/i,
    },
    {
      name: 'removed_workflow_config_key',
      yaml: `
name: legacy-workflow-config
piece_config:
  provider: mock
steps:
  - name: plan
    instruction: "Legacy keys must fail"
    rules:
      - condition: done
        next: COMPLETE
`,
      expected: /piece_config/i,
    },
    {
      name: 'removed_max_steps_key',
      yaml: `
name: legacy-step-limit
max_movements: 2
steps:
  - name: plan
    instruction: "Legacy keys must fail"
    rules:
      - condition: done
        next: COMPLETE
`,
      expected: /max_movements/i,
    },
  ])('should reject legacy workflow YAML key: $name', ({ name, yaml, expected }) => {
    // Given
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, `${name}.yaml`), yaml);

    // Then
    expect(() => loadWorkflow(name, testDir)).toThrow(expected);
  });

  it('should resolve agent paths from workflow YAML location', () => {
    // Given
    const config = loadWorkflow('default', testDir);

    // Then
    expect(config).not.toBeNull();
    for (const step of config!.steps) {
      if (step.personaPath) {
        expect(step.personaPath).toMatch(/^\//);
        expect(existsSync(step.personaPath)).toBe(true);
      }
    }
  });
});
