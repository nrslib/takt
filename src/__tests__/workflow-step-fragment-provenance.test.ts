import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { WorkflowEngine } from './helpers/workflow-engine.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function errorMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replaceAll('\\"', '"');
  }
  throw new Error('Expected action to throw');
}

function engineValidationError(workflowPath: string, projectDir: string): string {
  return errorMessage(() => {
    const workflow = loadWorkflowFromFile(workflowPath, projectDir);
    return new WorkflowEngine(workflow, projectDir, 'test task', { projectCwd: projectDir });
  });
}

describe('workflow step fragment provenance', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    projectDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-provenance-project-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-provenance-global-'));
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it('attributes a normalizer error to the outer fragment that overrides the field', () => {
    writeFile(projectDir, '.takt/steps/inner.yaml', [
      'persona: reviewer',
      'instruction: review',
      '',
    ].join('\n'));
    const outerPath = writeFile(projectDir, '.takt/steps/outer.yaml', [
      'uses: inner',
      'persona: ""',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/nested.yaml', [
      'name: nested',
      'initial_step: outer',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: outer',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('empty persona value');
    expect(message).toContain('step fragment "outer"');
    expect(message).toContain(outerPath);
  });

  it('attributes a removed provider_options field to the outer fragment with a runtime migration hint', () => {
    writeFile(projectDir, '.takt/steps/inner.yaml', [
      'instruction: review',
      'provider_options:',
      '  codex:',
      '    network_access: false',
      '',
    ].join('\n'));
    const outerPath = writeFile(projectDir, '.takt/steps/outer.yaml', [
      'uses: inner',
      'provider_options:',
      '  codex:',
      '    network_access: true',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/nested-provider-options.yaml', [
      'name: nested-provider-options',
      'initial_step: outer',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: outer',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('workflow YAML no longer accepts provider execution settings');
    expect(message).toContain('step fragment "outer"');
    expect(message).toContain(outerPath);
    expect(message).not.toContain('step fragment "inner"');
  });

  it('retains fragment context when a workflow_call resolver is unavailable', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: child',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/without-resolver.yaml', [
      'name: without-resolver',
      'initial_step: delegate',
      'max_steps: 1',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain('workflowCallResolver is required');
    expect(message).toContain('step fragment "delegate"');
    expect(message).toContain(fragmentPath);
  });

  it('attributes an array-root schema error to the fragment that provides the array', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'policy:',
      '  - 42',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/array-root.yaml', [
      'name: array-root',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
    expect(message).not.toContain('invalid field is defined by the workflow');
  });

  it('attributes a removed promotion target to the outer fragment with a ladder migration hint', () => {
    writeFile(projectDir, '.takt/steps/inner.yaml', [
      'instruction: review',
      '',
    ].join('\n'));
    const outerPath = writeFile(projectDir, '.takt/steps/outer.yaml', [
      'uses: inner',
      'promotion:',
      '  - at: 1',
      '    provider: opencode',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/promotion-provider.yaml', [
      'name: promotion-provider',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: outer',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('workflow promotion only accepts {at: N}');
    expect(message).toContain('step fragment "outer"');
    expect(message).toContain(outerPath);
    expect(message).not.toContain('step fragment "inner"');
  });

  it.each([
    ['provider', 'provider: opencode'],
    ['model', 'model: invalid-model'],
  ])('attributes a removed %s field in a normal fragment to that fragment', (_field, declaration) => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      declaration,
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/removed-step-runtime.yaml', [
      'name: removed-step-runtime',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('workflow YAML no longer accepts provider execution settings');
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('attributes a removed provider field in a parallel sub-step to its fragment', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/reviewer.yaml', [
      'instruction: review',
      'provider: opencode',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parallel-provider.yaml', [
      'name: parallel-provider',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    instruction: review',
      '    parallel:',
      '      - name: nested-review',
      '        uses: reviewer',
      '        rules:',
      '          - condition: done',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('workflow YAML no longer accepts provider execution settings');
    expect(message).toContain('step fragment "reviewer"');
    expect(message).toContain(fragmentPath);
  });

  it('attributes a removed provider_options field in a parallel parent fragment to that fragment', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'provider_options:',
      '  codex:',
      '    network_access: true',
      'parallel:',
      '  - name: nested-review',
      '    instruction: review',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parallel-parent-provider-options.yaml', [
      'name: parallel-parent-provider-options',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      self:',
      '        - condition: done',
      '          next: COMPLETE',
      '      parallel:',
      '        nested-review:',
      '          - condition: done',
      '',
    ].join('\n'));

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('workflow YAML no longer accepts provider execution settings');
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('rejects workflow-level auto_routing while preserving its workflow boundary error', () => {
    const workflowPath = writeFile(projectDir, '.takt/workflows/auto-routing.yaml', [
      'name: auto-routing',
      'initial_step: review',
      'max_steps: 1',
      'auto_routing:',
      '  strategy: balanced',
      'steps:',
      '  - name: review',
      '    instruction: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('workflow YAML no longer accepts provider routing settings');
  });

  it('should attribute an unknown workflow_call target to its fragment call field', async () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: missing-child',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parent-missing-child.yaml', [
      'name: parent-missing-child',
      'initial_step: delegate',
      'max_steps: 1',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
      '      - condition: ABORT',
      '        next: ABORT',
      '',
    ].join('\n'));
    const workflow = loadWorkflowFromFile(workflowPath, projectDir);
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', {
      projectCwd: projectDir,
      provider: 'mock',
      model: 'mock-model',
      workflowCallResolver: () => null,
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReasons).toHaveLength(1);
    expect(abortReasons[0]).toContain('references unknown workflow "missing-child"');
    expect(abortReasons[0]).toContain(workflowPath);
    expect(abortReasons[0]).toContain('from step fragment "delegate"');
    expect(abortReasons[0]).toContain(fragmentPath);
  });

  it('attributes a removed workflow_call override to its parent fragment', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: child',
      'overrides:',
      '  provider: opencode',
      '',
    ].join('\n'));
    const childPath = writeFile(projectDir, '.takt/workflows/child.yaml', [
      'name: child',
      'subworkflow:',
      '  callable: true',
      '  returns:',
      '    - done',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    instruction: review',
      '    rules:',
      '      - condition: done',
      '        return: done',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parent.yaml', [
      'name: parent',
      'initial_step: delegate',
      'max_steps: 1',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
      '',
    ].join('\n'));
    const message = errorMessage(() => {
      const workflow = loadWorkflowFromFile(workflowPath, projectDir);
      return new WorkflowEngine(workflow, projectDir, 'test task', {
        projectCwd: projectDir,
        workflowCallResolver: () => loadWorkflowFromFile(childPath, projectDir),
      });
    });

    expect(message).toContain('workflow YAML no longer accepts provider execution settings');
    expect(message).toContain('step fragment "delegate"');
    expect(message).toContain(fragmentPath);
  });

  it('retains parent workflow provenance for an inline workflow_call override', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: child',
      '',
    ].join('\n'));
    const childPath = writeFile(projectDir, '.takt/workflows/child.yaml', [
      'name: child',
      'subworkflow:',
      '  callable: true',
      '  returns:',
      '    - done',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    instruction: review',
      '    rules:',
      '      - condition: done',
      '        return: done',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parent-inline-override.yaml', [
      'name: parent-inline-override',
      'initial_step: delegate',
      'max_steps: 1',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    overrides:',
      '      provider: opencode',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));
    const message = errorMessage(() => {
      const workflow = loadWorkflowFromFile(workflowPath, projectDir);
      return new WorkflowEngine(workflow, projectDir, 'test task', {
        projectCwd: projectDir,
        workflowCallResolver: () => loadWorkflowFromFile(childPath, projectDir),
      });
    });

    expect(message).toContain('workflow YAML no longer accepts provider execution settings');
    expect(message).toContain(workflowPath);
    expect(message).toContain('step uses fragment "delegate"');
    expect(message).toContain(fragmentPath);
    expect(message).toContain('defined by the workflow');
  });

  it('preserves a child workflow load error without parent fragment provenance', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: child',
      '',
    ].join('\n'));
    writeFile(projectDir, '.takt/workflows/child.yaml', [
      'name: child',
      'subworkflow:',
      '  callable: true',
      '  returns:',
      '    - done',
      'initial_step: review',
      'max_steps: invalid',
      'steps:',
      '  - name: review',
      '    instruction: review',
      '    rules:',
      '      - condition: done',
      '        return: done',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parent-child-load.yaml', [
      'name: parent-child-load',
      'initial_step: delegate',
      'max_steps: 1',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
      '',
    ].join('\n'));
    const workflow = loadWorkflowFromFile(workflowPath, projectDir);
    const step = workflow.steps[0];
    if (!step || step.kind !== 'workflow_call') {
      throw new Error('Expected workflow_call step');
    }

    const message = errorMessage(() => resolveWorkflowCallTarget(workflow, step, projectDir));

    expect(message).toContain('expected number');
    expect(message).not.toContain('step fragment "delegate"');
    expect(message).not.toContain(fragmentPath);
  });
});
