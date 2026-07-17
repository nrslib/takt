import { describe, expect, it } from 'vitest';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import type { WorkflowStep } from '../core/models/types.js';
import type { RuntimeStepResolution, WorkflowEngineOptions } from '../core/workflow/types.js';

function createStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: 'implement',
    kind: 'agent',
    persona: 'coder',
    personaDisplayName: 'coder',
    instruction: 'Implement the feature',
    passPreviousResponse: true,
    ...overrides,
  } as WorkflowStep;
}

function createBuilder(engineOverrides: Partial<WorkflowEngineOptions>): OptionsBuilder {
  return new OptionsBuilder(
    {
      projectCwd: '/project',
      provider: 'mock',
      providerSource: 'project',
      ...engineOverrides,
    } as WorkflowEngineOptions,
    () => '/project',
    () => '/project',
    () => undefined,
    () => '.takt/runs/auto-routing/reports',
    () => 'ja',
    () => [{ name: 'implement' }],
    () => 'auto-routing-provider-options',
    () => 'Auto routing provider options test workflow',
  );
}

function createAutoRuntime(): RuntimeStepResolution {
  return {
    providerInfo: {
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'auto.rules',
      modelSource: 'auto.rules',
      providerOptions: {
        codex: {
          networkAccess: true,
          reasoningEffort: 'high',
        },
      },
      providerOptionsSources: {
        'codex.networkAccess': 'auto.rules',
        'codex.reasoningEffort': 'auto.rules',
      },
    },
  };
}

describe('auto routing provider_options merge', () => {
  it('Given auto candidate provider_options and an env-origin config leaf, When building options, Then the env-origin leaf still wins', () => {
    const builder = createBuilder({
      providerOptionsSource: 'project',
      providerOptionsOriginResolver: (path) => (path === 'codex.reasoningEffort' ? 'env' : 'local'),
      providerOptions: {
        codex: {
          networkAccess: false,
          reasoningEffort: 'low',
        },
      },
    });

    const options = builder.buildBaseOptions(createStep(), undefined, createAutoRuntime());

    expect(options.resolvedProvider).toBe('codex');
    expect(options.resolvedModel).toBe('gpt-5');
    expect(options.providerOptions).toEqual({
      codex: {
        networkAccess: true,
        reasoningEffort: 'low',
      },
    });
  });

  it('Given auto candidate provider_options, When resolving provider info, Then provider option sources preserve auto source only for candidate-owned leaves', () => {
    const builder = createBuilder({
      providerOptionsSource: 'project',
      providerOptionsOriginResolver: (path) => (path === 'codex.reasoningEffort' ? 'env' : 'local'),
      providerOptions: {
        codex: {
          networkAccess: false,
          reasoningEffort: 'low',
        },
      },
    });

    const providerInfo = builder.resolveStepProviderModel(createStep(), createAutoRuntime());

    expect(providerInfo.providerOptionsSources).toEqual({
      'codex.networkAccess': 'auto.rules',
      'codex.reasoningEffort': 'env',
    });
  });
});
