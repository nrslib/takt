import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowEngine } from '../core/workflow/index.js';
import type { WorkflowConfig } from '../core/models/index.js';
import type { ProviderResolutionSource } from '../core/workflow/provider-options-trace.js';
import {
  getProviderValidationErrorSource,
  withProviderValidationErrorSource,
} from '../core/workflow/provider-validation-error.js';
import { withWorkflowConfigErrorPath } from '../core/workflow/workflow-config-error.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import {
  registerWorkflowStepFragmentErrorContext,
  translateWorkflowStepFragmentError,
} from '../infra/config/loaders/workflowStepFragmentErrorTranslator.js';
import {
  captureConfigErrorMessage as engineError,
  isolateStepFragmentTestConfig,
  writeStepFragmentTestFile as write,
} from './helpers/step-fragment-test-helpers.js';

describe('workflow step fragment provider provenance', () => {
  let projectDir: string;
  let restoreConfig: () => void;

  beforeEach(() => {
    restoreConfig = isolateStepFragmentTestConfig('takt-step-provider-provenance-config-');
    projectDir = mkdtempSync(join(tmpdir(), 'takt-step-provider-provenance-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    restoreConfig();
  });

  it.each([
    'cli',
    'env',
    'auto.rules',
    'auto.dynamic',
    'auto.fallback',
    'project',
    'global',
    'default',
  ] as const satisfies readonly ProviderResolutionSource[])('does not associate a fragment with a %s provider validation error', (providerSource) => {
    const raw = { steps: [{ provider: 'claude' }] };
    const workflow = {} as WorkflowConfig;
    registerWorkflowStepFragmentErrorContext(
      workflow,
      [{ stepPath: ['steps', 0, 'provider'], ref: 'review', sourcePath: '/fragments/review.yaml' }],
      raw,
      '/workflows/default.yaml',
    );
    const validationError = withProviderValidationErrorSource(
      withWorkflowConfigErrorPath(new Error("provider 'opencode' requires model"), ['steps', 0, 'provider']),
      {
        provider: 'opencode',
        model: undefined,
        providerSource,
        modelSource: undefined,
      },
    );

    const translated = translateWorkflowStepFragmentError(workflow, validationError);

    expect(translated).toBe(validationError);
  });

  it('attributes a fragment field when a configuration error has no provider metadata', () => {
    const raw = { steps: [{ instruction: 'review' }] };
    const workflow = {} as WorkflowConfig;
    registerWorkflowStepFragmentErrorContext(
      workflow,
      [{ stepPath: ['steps', 0, 'instruction'], ref: 'review', sourcePath: '/fragments/review.yaml' }],
      raw,
      '/workflows/default.yaml',
    );
    const configurationError = withWorkflowConfigErrorPath(
      new Error('invalid instruction'),
      ['steps', 0, 'instruction'],
    );

    const translated = translateWorkflowStepFragmentError(workflow, configurationError);

    expect(translated).not.toBe(configurationError);
    expect(translated.message).toContain('from step fragment "review" at /fragments/review.yaml');
  });

  it('associates a missing provider with the provider field even when a model is present', () => {
    const error = withProviderValidationErrorSource(new Error('provider is required'), {
      provider: undefined,
      model: 'model-without-provider',
      providerSource: undefined,
      modelSource: 'step',
    });

    expect(getProviderValidationErrorSource(error)).toMatchObject({
      field: 'provider',
      source: undefined,
    });
  });

  it('does not associate a fragment when engine provider metadata has no source', () => {
    write(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
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

    const message = engineError(() => new WorkflowEngine(
      loadWorkflowFromFile(workflowPath, projectDir),
      projectDir,
      'test task',
      {
        projectCwd: projectDir,
        provider: 'opencode',
      },
    ));

    expect(message).toContain("provider 'opencode' requires model");
    expect(message).not.toContain('step fragment "review"');
  });

  it('attributes a missing OpenCode promotion model to the outer fragment that provides the provider', () => {
    write(projectDir, '.takt/steps/inner.yaml', [
      'instruction: review',
      'promotion:',
      '  - at: 2',
      '    provider: claude',
      '',
    ].join('\n'));
    const outerPath = write(projectDir, '.takt/steps/outer.yaml', [
      'uses: inner',
      'promotion:',
      '  - at: 2',
      '    provider: opencode',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
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

    const message = engineError(() => new WorkflowEngine(
      loadWorkflowFromFile(workflowPath, projectDir),
      projectDir,
      'test task',
      {
        projectCwd: projectDir,
      },
    ));

    expect(message).toContain('workflow promotion only accepts {at: N}');
    expect(message).toContain('step fragment "outer"');
    expect(message).toContain(outerPath);
    expect(message).not.toContain('step fragment "inner"');
  });

  it('retains fragment context while identifying a caller replacement promotion as workflow-defined', () => {
    const fragmentPath = write(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'promotion:',
      '  - at: 2',
      '    provider: claude',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    promotion:',
      '      - at: 2',
      '        provider: opencode',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = engineError(() => new WorkflowEngine(
      loadWorkflowFromFile(workflowPath, projectDir),
      projectDir,
      'test task',
      {
        projectCwd: projectDir,
      },
    ));

    expect(message).toContain('workflow promotion only accepts {at: N}');
    expect(message).toContain(workflowPath);
    expect(message).toContain('step uses fragment "review"');
    expect(message).toContain(fragmentPath);
    expect(message).toContain('defined by the workflow');
  });

  it('attributes a removed workflow-call provider override to the fragment', () => {
    const fragmentPath = write(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: child',
      'overrides:',
      '  provider: opencode',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/parent.yaml', [
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
    const message = engineError(() => new WorkflowEngine(
      loadWorkflowFromFile(workflowPath, projectDir),
      projectDir,
      'test task',
      { projectCwd: projectDir },
    ));

    expect(message).toContain('workflow YAML no longer accepts provider execution settings');
    expect(message).toContain('step fragment "delegate"');
    expect(message).toContain(fragmentPath);
  });

  it('retains fragment context for a removed caller workflow-call override', () => {
    const fragmentPath = write(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: child',
      'overrides:',
      '  provider: claude',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/parent.yaml', [
      'name: parent',
      'initial_step: delegate',
      'max_steps: 1',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    overrides:',
      '      provider: opencode',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
      '',
    ].join('\n'));
    const message = engineError(() => new WorkflowEngine(
      loadWorkflowFromFile(workflowPath, projectDir),
      projectDir,
      'test task',
      { projectCwd: projectDir },
    ));

    expect(message).toContain('workflow YAML no longer accepts provider execution settings');
    expect(message).toContain(workflowPath);
    expect(message).toContain('step uses fragment "delegate"');
    expect(message).toContain(fragmentPath);
    expect(message).toContain('defined by the workflow');
  });
});
