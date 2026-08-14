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
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected action to throw');
}

function engineValidationError(workflowPath: string, projectDir: string): string {
  const workflow = loadWorkflowFromFile(workflowPath, projectDir);
  return errorMessage(() => new WorkflowEngine(workflow, projectDir, 'test task', { projectCwd: projectDir }));
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

  it('should attribute a normalizer error to the outer fragment that overrides the field', () => {
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

  it('should attribute a provider option resolution error to the outer fragment that overrides the field', () => {
    writeFile(projectDir, '.takt/steps/inner.yaml', [
      'instruction: review',
      'provider_options:',
      '  extends: inherited-options',
      '',
    ].join('\n'));
    const outerPath = writeFile(projectDir, '.takt/steps/outer.yaml', [
      'uses: inner',
      'provider_options:',
      '  extends: missing-options',
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

    expect(message).toContain('provider_options.extends not found: missing-options');
    expect(message).toContain('step fragment "outer"');
    expect(message).toContain(outerPath);
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

    expect(message).toContain('step fragment \\"review\\"');
    expect(message).toContain(fragmentPath);
    expect(message).not.toContain('invalid field is defined by the workflow');
  });

  it('should attribute a promotion provider validation error to the fragment that provides it', () => {
    writeFile(projectDir, '.takt/steps/inner.yaml', [
      'instruction: review',
      '',
    ].join('\n'));
    const outerPath = writeFile(projectDir, '.takt/steps/outer.yaml', [
      'uses: inner',
      'promotion:',
      '  - at: 1',
      '    provider:',
      '      type: opencode',
      '      model: invalid-model',
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

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain("promotion[0].model must be in 'provider/model' format");
    expect(message).toContain('step fragment "outer"');
    expect(message).toContain(outerPath);
    expect(message).not.toContain('step fragment "inner"');
  });

  it('should attribute a nested provider model validation error to its fragment model field', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'provider:',
      '  type: opencode',
      '  model: invalid-model',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/nested-provider-model.yaml', [
      'name: nested-provider-model',
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

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain("step \"review\".model must be in 'provider/model' format");
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it.each([
    ['normal step', 'review', '  - name: review\n    uses: review\n    rules:\n      - condition: done\n        next: COMPLETE'],
    ['parallel sub-step', 'reviewers', '  - name: reviewers\n    parallel:\n      - name: review\n        uses: review\n        rules:\n          - condition: done\n    rules:\n      - condition: all("done")\n        next: COMPLETE'],
  ])('attributes a model-less OpenCode provider from a fragment in a %s to its provider field', (_placement, initialStep, steps) => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'provider: opencode',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/opencode-provider.yaml', [
      'name: opencode-provider',
      `initial_step: ${initialStep}`,
      'max_steps: 1',
      'steps:',
      steps,
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain("provider 'opencode' requires model");
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('should attribute a parallel nested provider model validation error to its fragment model field', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/reviewer.yaml', [
      'instruction: review',
      'provider:',
      '  type: opencode',
      '  model: invalid-model',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parallel-provider-model.yaml', [
      'name: parallel-provider-model',
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

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain("parallel sub-step \"nested-review\" of step \"review\".model must be in 'provider/model' format");
    expect(message).toContain('step fragment "reviewer"');
    expect(message).toContain(fragmentPath);
  });

  it('should attribute a parallel parent provider model validation error to its fragment model field', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'provider:',
      '  type: opencode',
      '  model: invalid-model',
      'parallel:',
      '  - name: nested-review',
      '    instruction: review',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parallel-parent-provider-model.yaml', [
      'name: parallel-parent-provider-model',
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

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain("step \"review\".model must be in 'provider/model' format");
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('should attribute a rule-selected auto-routing model error to its fragment model field', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'model: sonnet',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/auto-routing-fragment.yaml', [
      'name: auto-routing-fragment',
      'initial_step: review',
      'max_steps: 1',
      'auto_routing:',
      '  strategy: balanced',
      '  router:',
      '    provider: claude-sdk',
      '    model: claude-haiku-4-5-20251001',
      '  candidates:',
      '    - name: codex',
      '      description: Codex candidate',
      '      provider: codex',
      '      model: gpt-5-codex',
      '      routing_tier: medium',
      '  default_pool: general',
      '  candidate_pools:',
      '    general:',
      '      candidates: [codex]',
      '      fallback: codex',
      '  pool_rules:',
      '    steps:',
      '      auto-routing-fragment/review: general',
      '  rules:',
      '    steps:',
      '      review: codex',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain("auto_routing resolved model 'sonnet' is a Claude model alias but provider is 'codex'");
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('should attribute a default-pool auto-routing model error in a parallel sub-step to its fragment model field', () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/reviewer.yaml', [
      'instruction: review',
      'model: sonnet',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parallel-auto-routing-fragment.yaml', [
      'name: parallel-auto-routing-fragment',
      'initial_step: review',
      'max_steps: 1',
      'auto_routing:',
      '  strategy: balanced',
      '  router:',
      '    provider: claude-sdk',
      '    model: claude-haiku-4-5-20251001',
      '  candidates:',
      '    - name: codex',
      '      description: Codex candidate',
      '      provider: codex',
      '      model: gpt-5-codex',
      '      routing_tier: medium',
      '  default_pool: general',
      '  candidate_pools:',
      '    general:',
      '      candidates: [codex]',
      '      fallback: codex',
      '  pool_rules:',
      '    steps:',
      '      parallel-auto-routing-fragment/nested-review: general',
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

    const message = engineValidationError(workflowPath, projectDir);

    expect(message).toContain("auto_routing resolved model 'sonnet' is a Claude model alias but provider is 'codex'");
    expect(message).toContain('step fragment "reviewer"');
    expect(message).toContain(fragmentPath);
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

  it('does not attribute an inline child provider error to a valid workflow_call fragment override', async () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: child',
      'overrides:',
      '  provider:',
      '    type: opencode',
      '    model: opencode/valid-model',
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
      '    provider:',
      '      type: opencode',
      '      model: invalid-model',
      '    rules:',
      '      - condition: done',
      '        return: done',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parent-child-provider.yaml', [
      'name: parent-child-provider',
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
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', {
      projectCwd: projectDir,
      provider: 'mock',
      model: 'mock-model',
      workflowCallResolver: () => loadWorkflowFromFile(childPath, projectDir),
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReasons).toHaveLength(1);
    expect(abortReasons[0]).toContain('step "review".model must be in \'provider/model\' format');
    expect(abortReasons[0]).not.toContain('step fragment "delegate"');
    expect(abortReasons[0]).not.toContain(fragmentPath);
  });

  it('does not attribute a parent workflow_call override error to a child step fragment', async () => {
    const childFragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
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
      '    uses: review',
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
      '    kind: workflow_call',
      '    call: child',
      '    overrides:',
      '      provider: opencode',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));
    const workflow = loadWorkflowFromFile(workflowPath, projectDir);
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', {
      projectCwd: projectDir,
      provider: 'mock',
      model: 'mock-model',
      workflowCallResolver: () => loadWorkflowFromFile(childPath, projectDir),
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReasons).toHaveLength(1);
    expect(abortReasons[0]).toContain("provider 'opencode' requires model");
    expect(abortReasons[0]).not.toContain('step fragment "review"');
    expect(abortReasons[0]).not.toContain(childFragmentPath);
  });

  it('attributes a parent fragment workflow_call override error only to the parent fragment', async () => {
    const parentFragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: child',
      'overrides:',
      '  provider: opencode',
      '',
    ].join('\n'));
    const childFragmentPath = writeFile(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
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
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        return: done',
      '',
    ].join('\n'));
    const workflowPath = writeFile(projectDir, '.takt/workflows/parent-fragment-override.yaml', [
      'name: parent-fragment-override',
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
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', {
      projectCwd: projectDir,
      provider: 'mock',
      model: 'mock-model',
      workflowCallResolver: () => loadWorkflowFromFile(childPath, projectDir),
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReasons).toHaveLength(1);
    expect(abortReasons[0]).toContain("provider 'opencode' requires model");
    expect(abortReasons[0]).toContain('step fragment "delegate"');
    expect(abortReasons[0]).toContain(parentFragmentPath);
    expect(abortReasons[0]).not.toContain('step fragment "review"');
    expect(abortReasons[0]).not.toContain(childFragmentPath);
  });

  it('should preserve a child workflow load error without parent fragment provenance', () => {
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

  it('should attribute a workflow_call override provider error to its parent fragment', async () => {
    const fragmentPath = writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: child',
      'overrides:',
      '  provider:',
      '    type: opencode',
      '    model: invalid-model',
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
    const workflow = loadWorkflowFromFile(workflowPath, projectDir);
    const engine = new WorkflowEngine(workflow, projectDir, 'test task', {
      projectCwd: projectDir,
      provider: 'mock',
      model: 'mock-model',
      workflowCallResolver: () => loadWorkflowFromFile(childPath, projectDir),
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReasons).toHaveLength(1);
    expect(abortReasons[0]).toContain("step \"review\".model must be in 'provider/model' format");
    expect(abortReasons[0]).toContain('step fragment "delegate"');
    expect(abortReasons[0]).toContain(fragmentPath);
  });
});
