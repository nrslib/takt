import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initWorkflowCommand } from '../features/workflowAuthoring/init.js';

const mockSuccess = vi.fn();
const mockInfo = vi.fn();

vi.mock('../shared/ui/index.js', () => ({
  success: (...args: unknown[]) => mockSuccess(...args),
  info: (...args: unknown[]) => mockInfo(...args),
}));

describe('initWorkflowCommand', () => {
  let projectDir: string;
  let globalDir: string;
  const previousConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-workflow-init-project-'));
    globalDir = mkdtempSync(join(tmpdir(), 'takt-workflow-init-global-'));
    process.env.TAKT_CONFIG_DIR = globalDir;
    mockSuccess.mockClear();
    mockInfo.mockClear();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
      return;
    }
    process.env.TAKT_CONFIG_DIR = previousConfigDir;
  });

  it('creates a minimal workflow scaffold in project workflows by default', async () => {
    await initWorkflowCommand('sample-flow', { projectDir });

    const workflowPath = join(projectDir, '.takt', 'workflows', 'sample-flow.yaml');
    expect(existsSync(workflowPath)).toBe(true);

    const content = readFileSync(workflowPath, 'utf-8');
    expect(content).toContain('name: sample-flow');
    expect(content).toContain('max_steps: 10');
    expect(content).toContain('initial_step: step1');
    expect(content).toContain('steps:');
    expect(content).not.toContain('personas:');
    expect(content).not.toContain('instructions:');
  });

  it('creates workflow scaffold in global workflows when --global is set', async () => {
    await initWorkflowCommand('global-flow', { global: true, projectDir });

    const workflowPath = join(globalDir, 'workflows', 'global-flow.yaml');
    expect(existsSync(workflowPath)).toBe(true);
  });

  it('creates the requested number of steps', async () => {
    await initWorkflowCommand('three-steps', {
      projectDir,
      steps: 3,
    });

    const workflowPath = join(projectDir, '.takt', 'workflows', 'three-steps.yaml');
    const content = readFileSync(workflowPath, 'utf-8');
    expect(content.match(/- name: step/g)).toHaveLength(3);
    expect(content).toContain('next: step2');
    expect(content).toContain('next: step3');
    expect(content).toContain('next: COMPLETE');
  });

  it('creates faceted workflow and facet files', async () => {
    await initWorkflowCommand('faceted-flow', {
      projectDir,
      steps: 2,
      template: 'faceted',
    });

    const workflowPath = join(projectDir, '.takt', 'workflows', 'faceted-flow.yaml');
    const personaPath = join(projectDir, '.takt', 'facets', 'personas', 'default.md');
    const instructionOnePath = join(projectDir, '.takt', 'facets', 'instructions', 'step1.md');
    const instructionTwoPath = join(projectDir, '.takt', 'facets', 'instructions', 'step2.md');

    expect(existsSync(workflowPath)).toBe(true);
    expect(existsSync(personaPath)).toBe(true);
    expect(existsSync(instructionOnePath)).toBe(true);
    expect(existsSync(instructionTwoPath)).toBe(true);

    const workflowContent = readFileSync(workflowPath, 'utf-8');
    expect(workflowContent).toContain('personas:');
    expect(workflowContent).toContain('default: ../facets/personas/default.md');
    expect(workflowContent).toContain('instructions:');
    expect(workflowContent).toContain('step1: ../facets/instructions/step1.md');
    expect(workflowContent).toContain('step2: ../facets/instructions/step2.md');
  });

  it('fails when scaffold target already exists', async () => {
    await initWorkflowCommand('sample-flow', { projectDir });

    await expect(initWorkflowCommand('sample-flow', { projectDir }))
      .rejects.toThrow(/already exists/);
  });

  it('rejects invalid step count', async () => {
    await expect(initWorkflowCommand('bad-step-count', {
      projectDir,
      steps: 0,
    })).rejects.toThrow('--steps must be a positive integer');
  });

  it('rejects workflow names with path traversal', async () => {
    await expect(initWorkflowCommand('../outside', {
      projectDir,
    })).rejects.toThrow(/Invalid workflow name/);
  });

  it('emits next-step guidance after scaffold creation', async () => {
    await initWorkflowCommand('guided-flow', { projectDir });

    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('guided-flow.yaml'));
    expect(mockInfo).toHaveBeenCalledWith('Next: takt workflow doctor guided-flow');
  });
});
