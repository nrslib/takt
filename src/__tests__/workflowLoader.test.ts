/**
 * Tests for isWorkflowPath and loadWorkflowByIdentifier
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isWorkflowPath,
  loadWorkflowByIdentifier,
  listWorkflows,
  loadAllWorkflows,
} from '../config/workflowLoader.js';

const SAMPLE_WORKFLOW = `name: test-workflow
description: Test workflow
initial_step: step1
max_iterations: 1

steps:
  - name: step1
    agent: coder
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
    const workflow = loadWorkflowByIdentifier('default');
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
    const workflow = loadWorkflowByIdentifier('non-existent-workflow-xyz');
    expect(workflow).toBeNull();
  });

  it('should return null for non-existent path', () => {
    const workflow = loadWorkflowByIdentifier('./non-existent.yaml', tempDir);
    expect(workflow).toBeNull();
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

  it('should include builtin workflows regardless of cwd', () => {
    const workflows = listWorkflows(tempDir);
    expect(workflows).toContain('default');
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
max_iterations: 1

steps:
  - name: step1
    agent: coder
    instruction: "{task}"
`;
    writeFileSync(join(projectWorkflowsDir, 'default.yaml'), overrideWorkflow);

    const workflows = loadAllWorkflows(tempDir);
    expect(workflows.get('default')!.name).toBe('project-override');
  });

});
