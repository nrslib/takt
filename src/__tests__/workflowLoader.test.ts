/**
 * Tests for workflow loader path detection and identifier resolution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isWorkflowPath,
  loadWorkflowByIdentifier,
  listWorkflows,
  listWorkflowEntries,
  loadAllWorkflows,
  loadAllWorkflowsWithSources,
} from '../infra/config/loaders/workflowLoader.js';

const SAMPLE_WORKFLOW = `name: test-workflow
description: Test workflow
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`;

const INVALID_ALLOWED_TOOLS_WORKFLOW = `name: broken-workflow
description: Broken workflow
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    allowed_tools: [Read]
    instruction: "{task}"
`;

describe('isWorkflowPath', () => {
  it('should return true for absolute paths', () => {
    expect(isWorkflowPath('/path/to/workflow.yaml')).toBe(true);
    expect(isWorkflowPath('/workflow')).toBe(true);
  });

  it('should return true for home directory paths', () => {
    expect(isWorkflowPath('~/workflow.yaml')).toBe(true);
    expect(isWorkflowPath('~/.takt/workflows/custom.yaml')).toBe(true);
  });

  it('should return true for relative paths starting with ./', () => {
    expect(isWorkflowPath('./workflow.yaml')).toBe(true);
    expect(isWorkflowPath('./subdir/workflow.yaml')).toBe(true);
  });

  it('should return true for relative paths starting with ../', () => {
    expect(isWorkflowPath('../workflow.yaml')).toBe(true);
    expect(isWorkflowPath('../subdir/workflow.yaml')).toBe(true);
  });

  it('should return true for paths ending with .yaml', () => {
    expect(isWorkflowPath('custom.yaml')).toBe(true);
    expect(isWorkflowPath('my-workflow.yaml')).toBe(true);
  });

  it('should return true for paths ending with .yml', () => {
    expect(isWorkflowPath('custom.yml')).toBe(true);
    expect(isWorkflowPath('my-workflow.yml')).toBe(true);
  });

  it('should return false for plain workflow names', () => {
    expect(isWorkflowPath('default')).toBe(false);
    expect(isWorkflowPath('simple')).toBe(false);
    expect(isWorkflowPath('magi')).toBe(false);
    expect(isWorkflowPath('my-custom-workflow')).toBe(false);
  });
});

describe('loadWorkflowByIdentifier', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load workflow by name (builtin)', () => {
    const workflow = loadWorkflowByIdentifier('default', process.cwd());
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('default');
  });

  it('should load workflow by absolute path', () => {
    const filePath = join(tempDir, 'test.yaml');
    writeFileSync(filePath, SAMPLE_WORKFLOW);

    const workflow = loadWorkflowByIdentifier(filePath, tempDir);
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('test-workflow');
  });

  it('should reject privileged system workflows loaded from arbitrary project paths', () => {
    const filePath = join(tempDir, 'unsafe-system.yaml');
    writeFileSync(filePath, `name: unsafe-system
initial_step: route_context
max_steps: 2

steps:
  - name: route_context
    mode: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - when: "true"
        next: COMPLETE
`);

    expect(() => loadWorkflowByIdentifier(filePath, tempDir)).toThrow(
      /Project workflow ".*unsafe-system\.yaml" cannot use privileged system execution/,
    );
  });

  it('should reject privileged system workflows loaded from arbitrary relative project paths', () => {
    writeFileSync(join(tempDir, 'unsafe-system.yaml'), `name: unsafe-system
initial_step: route_context
max_steps: 2

steps:
  - name: route_context
    mode: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - when: "true"
        next: COMPLETE
`);

    expect(() => loadWorkflowByIdentifier('./unsafe-system.yaml', tempDir)).toThrow(
      /Project workflow ".*unsafe-system\.yaml" cannot use privileged system execution/,
    );
  });

  it('should reject system-input workflows loaded from arbitrary project paths', () => {
    const filePath = join(tempDir, 'unsafe-system-inputs.yaml');
    writeFileSync(filePath, `name: unsafe-system-inputs
initial_step: route_context
max_steps: 2

steps:
  - name: route_context
    mode: system
    system_inputs:
      - type: pr_context
        source: current_branch
        as: pr
    rules:
      - when: "true"
        next: COMPLETE
`);

    expect(() => loadWorkflowByIdentifier(filePath, tempDir)).toThrow(
      /Project workflow ".*unsafe-system-inputs\.yaml" cannot use privileged system execution/,
    );
  });

  it('should load workflow by relative path', () => {
    const filePath = join(tempDir, 'test.yaml');
    writeFileSync(filePath, SAMPLE_WORKFLOW);

    const workflow = loadWorkflowByIdentifier('./test.yaml', tempDir);
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('test-workflow');
  });

  it('should load workflow by filename with .yaml extension', () => {
    const filePath = join(tempDir, 'test.yaml');
    writeFileSync(filePath, SAMPLE_WORKFLOW);

    const workflow = loadWorkflowByIdentifier('test.yaml', tempDir);
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('test-workflow');
  });

  it('should return null for non-existent name', () => {
    const workflow = loadWorkflowByIdentifier('non-existent-workflow-xyz', process.cwd());
    expect(workflow).toBeNull();
  });

  it('should return null for non-existent path', () => {
    const workflow = loadWorkflowByIdentifier('./non-existent.yaml', tempDir);
    expect(workflow).toBeNull();
  });

  it('should load workflow definitions from project-local workflows directory', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'project-custom.yaml'), SAMPLE_WORKFLOW);

    const workflow = loadWorkflowByIdentifier('project-custom', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('test-workflow');
  });

  it('should load privileged project-local workflows by name', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'auto-improvement-loop.yaml'), `name: auto-improvement-loop
description: project system workflow
initial_step: route_context
max_steps: 2

steps:
  - name: route_context
    mode: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - when: "true"
        next: COMPLETE
`);

    const workflow = loadWorkflowByIdentifier('auto-improvement-loop', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('auto-improvement-loop');
    expect(workflow!.steps[0]?.effects).toEqual([{ type: 'merge_pr', pr: 42 }]);
  });

  it('should load privileged project-local workflows loaded by path', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    const workflowPath = join(projectWorkflowsDir, 'auto-improvement-loop.yaml');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(workflowPath, `name: auto-improvement-loop
description: project system workflow
initial_step: route_context
max_steps: 2

steps:
  - name: route_context
    mode: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - when: "true"
        next: COMPLETE
`);

    const workflow = loadWorkflowByIdentifier('./.takt/workflows/auto-improvement-loop.yaml', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('auto-improvement-loop');
    expect(workflow!.steps[0]?.effects).toEqual([{ type: 'merge_pr', pr: 42 }]);
  });

  it('should load workflow definitions that use steps and initial_step aliases', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'aliased-workflow.yaml'), `name: aliased-workflow
description: aliased workflow
initial_step: plan
max_steps: 1

steps:
  - name: plan
    persona: coder
    instruction: "{task}"
`);

    const workflow = loadWorkflowByIdentifier('aliased-workflow', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.initialStep).toBe('plan');
    expect(workflow!.steps).toHaveLength(1);
    expect(workflow!.steps[0]?.name).toBe('plan');
  });

  it('should load project-local workflow definitions from .takt/workflows', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'default.yaml'), `name: workflow-priority
description: workflow wins
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`);

    const workflow = loadWorkflowByIdentifier('default', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('workflow-priority');
  });
});

describe('listWorkflows with project-local', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should include project-local workflows when cwd is provided', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'project-custom.yaml'), SAMPLE_WORKFLOW);

    const workflows = listWorkflows(tempDir);
    expect(workflows).toContain('project-custom');
  });

  it('should include project-local workflows when cwd is provided', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'workflow-custom.yaml'), SAMPLE_WORKFLOW);

    const workflows = listWorkflows(tempDir);

    expect(workflows).toContain('workflow-custom');
  });

  it('should include builtin workflows regardless of cwd', () => {
    const workflows = listWorkflows(tempDir);
    expect(workflows).toContain('default');
  });

  it('should warn and skip invalid project-local workflows', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'broken.yaml'), INVALID_ALLOWED_TOOLS_WORKFLOW);
    const onWarning = vi.fn();

    const workflows = listWorkflows(tempDir, { onWarning });

    expect(workflows).not.toContain('broken');
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('Workflow "broken" failed to load'));
  });

  it('should include privileged project-local workflows', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'unsafe-system.yaml'), `name: unsafe-system
initial_step: route_context
max_steps: 1

steps:
  - name: route_context
    mode: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - when: "true"
        next: COMPLETE
`);
    const onWarning = vi.fn();

    const workflows = listWorkflows(tempDir, { onWarning });

    expect(workflows).toContain('unsafe-system');
    expect(onWarning).not.toHaveBeenCalled();
  });

});

describe('loadAllWorkflows with project-local', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should include project-local workflows when cwd is provided', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'project-custom.yaml'), SAMPLE_WORKFLOW);

    const workflows = loadAllWorkflows(tempDir);
    expect(workflows.has('project-custom')).toBe(true);
    expect(workflows.get('project-custom')!.name).toBe('test-workflow');
  });

  it('should have project-local override builtin when same name', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });

    const overrideWorkflow = `name: project-override
description: Project override
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`;
    writeFileSync(join(projectWorkflowsDir, 'default.yaml'), overrideWorkflow);

    const workflows = loadAllWorkflows(tempDir);
    expect(workflows.get('default')!.name).toBe('project-override');
  });

  it('should load project-local workflows in loadAllWorkflows', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'shared.yaml'), `name: workflow-priority
description: workflow priority
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`);

    const workflows = loadAllWorkflows(tempDir);

    expect(workflows.get('shared')?.name).toBe('workflow-priority');
  });

  it('should load privileged project-local workflows in loadAllWorkflows', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'unsafe-system.yaml'), `name: unsafe-system
initial_step: route_context
max_steps: 1

steps:
  - name: route_context
    mode: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - when: "true"
        next: COMPLETE
`);
    const onWarning = vi.fn();

    const workflows = loadAllWorkflows(tempDir, { onWarning });

    expect(workflows.has('unsafe-system')).toBe(true);
    expect(workflows.get('unsafe-system')?.steps[0]?.effects).toEqual([{ type: 'merge_pr', pr: 42 }]);
    expect(onWarning).not.toHaveBeenCalled();
  });

});

describe('loadWorkflowByIdentifier with @scope ref (repertoire)', () => {
  let tempDir: string;
  let configDir: string;
  const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
    configDir = mkdtempSync(join(tmpdir(), 'takt-config-'));
    process.env.TAKT_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (originalTaktConfigDir !== undefined) {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    } else {
      delete process.env.TAKT_CONFIG_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('should load workflow by @scope ref (repertoire)', () => {
    const workflowsDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'expert.yaml'), SAMPLE_WORKFLOW);

    const workflow = loadWorkflowByIdentifier('@nrslib/takt-ensemble/expert', tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('test-workflow');
  });

  it('should return null for non-existent @scope workflow', () => {
    const workflowsDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    const workflow = loadWorkflowByIdentifier('@nrslib/takt-ensemble/no-such-workflow', tempDir);

    expect(workflow).toBeNull();
  });
});

describe('loadAllWorkflowsWithSources with repertoire workflows', () => {
  let tempDir: string;
  let configDir: string;
  const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
    configDir = mkdtempSync(join(tmpdir(), 'takt-config-'));
    process.env.TAKT_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (originalTaktConfigDir !== undefined) {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    } else {
      delete process.env.TAKT_CONFIG_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('should include repertoire workflows with @scope qualified names', () => {
    const workflowsDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'expert.yaml'), SAMPLE_WORKFLOW);

    const workflows = loadAllWorkflowsWithSources(tempDir);

    expect(workflows.has('@nrslib/takt-ensemble/expert')).toBe(true);
    expect(workflows.get('@nrslib/takt-ensemble/expert')!.source).toBe('repertoire');
  });

  it('should not throw when repertoire dir does not exist', () => {
    const workflows = loadAllWorkflowsWithSources(tempDir);

    const repertoireWorkflows = Array.from(workflows.keys()).filter((k) => k.startsWith('@'));
    expect(repertoireWorkflows).toHaveLength(0);
  });

  it('should warn and skip invalid project-local workflows', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'broken.yaml'), INVALID_ALLOWED_TOOLS_WORKFLOW);
    const onWarning = vi.fn();

    const workflows = loadAllWorkflowsWithSources(tempDir, { onWarning });

    expect(workflows.has('broken')).toBe(false);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('Workflow "broken" failed to load'));
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('allowed_tools'));
  });

  it('should warn and skip invalid repertoire workflows', () => {
    const workflowsDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'broken.yaml'), INVALID_ALLOWED_TOOLS_WORKFLOW);
    const onWarning = vi.fn();

    const workflows = loadAllWorkflowsWithSources(tempDir, { onWarning });

    expect(workflows.has('@nrslib/takt-ensemble/broken')).toBe(false);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('Workflow "@nrslib/takt-ensemble/broken" failed to load'),
    );
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('allowed_tools'));
  });

  it('should forward warnings through loadAllWorkflows callback', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'broken.yaml'), INVALID_ALLOWED_TOOLS_WORKFLOW);
    const onWarning = vi.fn();

    const workflows = loadAllWorkflows(tempDir, { onWarning });

    expect(workflows.has('broken')).toBe(false);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('allowed_tools'));
  });

  it('should return workflow entries from .takt/workflows in loadAllWorkflowsWithSources and listWorkflowEntries', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'shared.yaml'), `name: workflow-priority
description: workflow priority
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`);

    const workflows = loadAllWorkflowsWithSources(tempDir);
    const entries = listWorkflowEntries(tempDir);

    expect(workflows.get('shared')?.config.name).toBe('workflow-priority');
    expect(entries.find((entry) => entry.name === 'shared')?.path).toBe(
      join(projectWorkflowsDir, 'shared.yaml'),
    );
  });

  it('should load user workflows for the same name', () => {
    const userWorkflowsDir = join(configDir, 'workflows');
    mkdirSync(userWorkflowsDir, { recursive: true });
    writeFileSync(join(userWorkflowsDir, 'shared.yaml'), `name: user-workflow
description: user workflow priority
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`);

    const workflow = loadWorkflowByIdentifier('shared', tempDir);
    const workflows = loadAllWorkflowsWithSources(tempDir);
    const entries = listWorkflowEntries(tempDir);

    expect(workflow?.name).toBe('user-workflow');
    expect(workflows.get('shared')?.config.name).toBe('user-workflow');
    expect(entries.find((entry) => entry.name === 'shared')?.path).toBe(
      join(userWorkflowsDir, 'shared.yaml'),
    );
  });

  it('should prefer project workflows over user workflows', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    const userWorkflowsDir = join(configDir, 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    mkdirSync(userWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'shared.yaml'), `name: project-workflow
description: project workflow priority
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`);
    writeFileSync(join(userWorkflowsDir, 'shared.yaml'), `name: user-workflow
description: user workflow priority
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`);

    const workflow = loadWorkflowByIdentifier('shared', tempDir);
    const workflows = loadAllWorkflowsWithSources(tempDir);
    const entries = listWorkflowEntries(tempDir);

    expect(workflow?.name).toBe('project-workflow');
    expect(workflows.get('shared')?.config.name).toBe('project-workflow');
    expect(entries.find((entry) => entry.name === 'shared')?.path).toBe(
      join(projectWorkflowsDir, 'shared.yaml'),
    );
  });

  it('should reject conflicting workflow aliases', () => {
    const conflictPath = join(tempDir, 'conflict.yaml');
    writeFileSync(conflictPath, `name: conflict
description: conflicting aliases
initial_step: plan
max_steps: 1

steps:
  - name: plan
    persona: coder
    instruction: "{task}"
steps:
  - name: implement
    persona: coder
    instruction: "{task}"
`);

    expect(() => loadWorkflowByIdentifier(conflictPath, tempDir)).toThrow(
      /Map keys must be unique|duplicated mapping key/i,
    );
  });

  it('should return validated selection entries for repertoire workflows without collapsing repo names', () => {
    const workflowsDirA = join(configDir, 'repertoire', '@nrslib', 'repo-a', 'workflows');
    const workflowsDirB = join(configDir, 'repertoire', '@nrslib', 'repo-b', 'workflows');
    mkdirSync(workflowsDirA, { recursive: true });
    mkdirSync(workflowsDirB, { recursive: true });
    writeFileSync(join(workflowsDirA, 'expert.yaml'), SAMPLE_WORKFLOW);
    writeFileSync(join(workflowsDirB, 'expert.yaml'), SAMPLE_WORKFLOW);

    const entries = listWorkflowEntries(tempDir);

    expect(entries).toEqual(
      expect.arrayContaining([
        {
          name: '@nrslib/repo-a/expert',
          path: join(workflowsDirA, 'expert.yaml'),
          source: 'repertoire',
        },
        {
          name: '@nrslib/repo-b/expert',
          path: join(workflowsDirB, 'expert.yaml'),
          source: 'repertoire',
        },
      ]),
    );
  });

  it('should warn and skip invalid entries from listWorkflowEntries', () => {
    const workflowsDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'broken.yaml'), INVALID_ALLOWED_TOOLS_WORKFLOW);
    const onWarning = vi.fn();

    const entries = listWorkflowEntries(tempDir, { onWarning });

    expect(entries.find((entry) => entry.name === '@nrslib/takt-ensemble/broken')).toBeUndefined();
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('Workflow "@nrslib/takt-ensemble/broken" failed to load'),
    );
  });
});

describe('normalizeArpeggio: strategy coercion via loadWorkflowByIdentifier', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-arpeggio-coerce-'));
    mkdirSync(join(tempDir, '.takt'), { recursive: true });
    // Dummy files required by normalizeArpeggio (resolved relative to workflow dir)
    writeFileSync(join(tempDir, 'template.md'), '{line:1}');
    writeFileSync(join(tempDir, 'data.csv'), 'col\nval');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should preserve strategy:"custom" when loading arpeggio workflow YAML', () => {
    writeFileSync(
      join(tempDir, '.takt', 'config.yaml'),
      ['workflow_arpeggio:', '  custom_merge_inline_js: true'].join('\n'),
      'utf-8',
    );

    const workflowYaml = `name: arpeggio-coerce-test
initial_step: process
max_steps: 5
steps:
  - name: process
    persona: coder
    arpeggio:
      source: csv
      source_path: ./data.csv
      template: ./template.md
      merge:
        strategy: custom
        inline_js: 'return results.map(r => r.content).join(", ");'
    rules:
      - condition: All processed
        next: COMPLETE
`;
    const workflowPath = join(tempDir, 'workflow.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const config = loadWorkflowByIdentifier(workflowPath, tempDir);

    expect(config).not.toBeNull();
    const step = config!.steps[0]!;
    expect(step.arpeggio).toBeDefined();
    expect(step.arpeggio!.merge.strategy).toBe('custom');
    expect(step.arpeggio!.merge.inlineJs).toContain('map');
  });

  it('should preserve concat strategy and separator when loading arpeggio workflow YAML', () => {
    const workflowYaml = `name: arpeggio-concat-test
initial_step: process
max_steps: 5
steps:
  - name: process
    persona: coder
    arpeggio:
      source: csv
      source_path: ./data.csv
      template: ./template.md
      merge:
        strategy: concat
        separator: "\\n---\\n"
    rules:
      - condition: All processed
        next: COMPLETE
`;
    const workflowPath = join(tempDir, 'workflow.yaml');
    writeFileSync(workflowPath, workflowYaml);

    const config = loadWorkflowByIdentifier(workflowPath, tempDir);

    expect(config).not.toBeNull();
    const step = config!.steps[0]!;
    expect(step.arpeggio!.merge.strategy).toBe('concat');
    expect(step.arpeggio!.merge.separator).toBe('\n---\n');
  });
});
