/**
 * Tests for path-based workflow loading
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { loadWorkflow, loadWorkflowFromPath } from '../config/workflowLoader.js';

describe('Path-based workflow loading', () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(() => {
    // Create temporary directories for testing
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
    projectDir = mkdtempSync(join(tmpdir(), 'takt-project-'));

    // Create a test workflow in temp directory
    writeFileSync(
      join(tempDir, 'test-workflow.yaml'),
      `name: test-path-workflow
description: Test workflow for path-based loading
initial_step: plan
max_iterations: 5

steps:
  - name: plan
    agent: planner
    instruction: "Plan the task"
    rules:
      - condition: ai("Ready?")
        next: implement

  - name: implement
    agent: coder
    instruction: "Implement"
`,
    );

    // Create project-local workflow directory
    const projectWorkflowsDir = join(projectDir, '.takt', 'workflows');
    rmSync(projectWorkflowsDir, { recursive: true, force: true });
    writeFileSync(
      join(tempDir, 'project-local.yaml'),
      `name: project-local-workflow
description: Project-local workflow
initial_step: test
max_iterations: 1

steps:
  - name: test
    agent: tester
    instruction: "Run tests"
`,
    );
  });

  afterEach(() => {
    // Clean up temporary directories
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('should load workflow by absolute path', () => {
    const absolutePath = join(tempDir, 'test-workflow.yaml');
    const workflow = loadWorkflowFromPath(absolutePath);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('test-path-workflow');
    expect(workflow!.description).toBe('Test workflow for path-based loading');
  });

  it('should load workflow by relative path', () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const relativePath = './test-workflow.yaml';
      const workflow = loadWorkflowFromPath(relativePath, tempDir);

      expect(workflow).not.toBeNull();
      expect(workflow!.name).toBe('test-path-workflow');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should load workflow with .yaml extension in name', () => {
    const pathWithExtension = join(tempDir, 'test-workflow.yaml');
    const workflow = loadWorkflowFromPath(pathWithExtension);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('test-path-workflow');
  });

  it('should return null for non-existent path', () => {
    const nonExistentPath = join(tempDir, 'non-existent.yaml');
    const workflow = loadWorkflowFromPath(nonExistentPath);

    expect(workflow).toBeNull();
  });

  it('should maintain backward compatibility with name-based loading', () => {
    // Load builtin workflow by name
    const workflow = loadWorkflow('default');

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('default');
  });

  it('should prioritize project-local workflows over global when loading by name', () => {
    // Create project-local workflow directory
    const projectWorkflowsDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });

    // Create project-local workflow with same name as builtin
    writeFileSync(
      join(projectWorkflowsDir, 'default.yaml'),
      `name: project-override
description: Project-local override of default workflow
initial_step: custom
max_iterations: 1

steps:
  - name: custom
    agent: custom
    instruction: "Custom step"
`,
    );

    // Load by name with projectCwd - should get project-local version
    const workflow = loadWorkflow('default', projectDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('project-override');
    expect(workflow!.description).toBe('Project-local override of default workflow');
  });

  it('should load workflows via loadWorkflowFromPath function', () => {
    // Absolute paths
    const pathWithSlash = join(tempDir, 'test-workflow.yaml');
    const workflow1 = loadWorkflowFromPath(pathWithSlash);
    expect(workflow1).not.toBeNull();

    // Relative paths
    const workflow2 = loadWorkflowFromPath('./test-workflow.yaml', tempDir);
    expect(workflow2).not.toBeNull();

    // Explicit path loading
    const yamlFile = join(tempDir, 'test-workflow.yaml');
    const workflow3 = loadWorkflowFromPath(yamlFile);
    expect(workflow3).not.toBeNull();
  });

  it('should handle workflow files with .yml extension', () => {
    // Create workflow with .yml extension
    const ymlPath = join(tempDir, 'test-yml.yml');
    writeFileSync(
      ymlPath,
      `name: yml-workflow
description: Workflow with .yml extension
initial_step: start
max_iterations: 1

steps:
  - name: start
    agent: starter
    instruction: "Start"
`,
    );

    const workflow = loadWorkflowFromPath(ymlPath);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('yml-workflow');
  });

  it('should resolve relative paths against provided base directory', () => {
    const relativePath = 'test-workflow.yaml';
    const workflow = loadWorkflowFromPath(relativePath, tempDir);

    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('test-path-workflow');
  });
});

// Import for test setup
import { mkdirSync } from 'node:fs';
