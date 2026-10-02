import { describe, expect, it } from 'vitest';
import type { AutoRoutingConfig } from '../core/models/config-types.js';
import type { NormalAgentWorkflowStep, WorkflowConfig, WorkflowStep } from '../core/models/index.js';
import { resolveStepProviderModel } from '../core/workflow/provider-resolution.js';
import { resolveWorkflowCallChildProviderModel } from '../core/workflow/workflow-call-provider-context.js';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { resolveAutoRoutingCandidateProviderInfo } from '../core/workflow/auto-routing/resolver.js';
import type { StepProviderModelInput } from '../core/workflow/provider-resolution.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { validateWorkflowConfig } from '../core/workflow/engine/WorkflowValidator.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

function createStep(
  tags: string[] = [],
  overrides: Partial<StepProviderModelInput['step']> = {},
): StepProviderModelInput['step'] {
  return {
    name: 'plan',
    provider: undefined,
    model: undefined,
    personaDisplayName: 'coder',
    tags,
    ...overrides,
  };
}

function createOptionsBuilder(engineOptions: WorkflowEngineOptions): OptionsBuilder {
  return new OptionsBuilder(
    engineOptions,
    () => '/project',
    () => '/project',
    () => undefined,
    () => '.takt/runs/provider-model-selection/reports',
    () => 'en',
    () => [{ name: 'plan' }],
    () => 'provider-model-selection',
    () => 'Provider model selection test',
  );
}

function createPlanStep(overrides: Partial<NormalAgentWorkflowStep> = {}): NormalAgentWorkflowStep {
  return {
    name: 'plan',
    persona: 'planner',
    personaDisplayName: 'planner',
    edit: false,
    instruction: 'Review the requested work',
    passPreviousResponse: true,
    rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
    ...overrides,
  };
}

describe('workflow step model selection', () => {
  it('Given a tag model owned by another provider, When the CLI selects Copilot, Then it drops the tag model', () => {
    const result = resolveStepProviderModel({
      step: createStep(['plan']),
      provider: 'copilot',
      providerSource: 'cli',
      providerRouting: {
        tags: { plan: { provider: 'claude', model: 'opus' } },
      },
    });

    expect(result).toMatchObject({
      provider: 'copilot',
      providerSource: 'cli',
      model: undefined,
      modelSource: 'default',
    });
  });

  it('Given a provider-only step route and a tag model for Claude, When the step resolves, Then it does not use the tag model', () => {
    const result = resolveStepProviderModel({
      step: createStep(['plan']),
      providerRouting: {
        steps: { plan: { provider: 'copilot' } },
        tags: { plan: { provider: 'claude', model: 'opus' } },
      },
    });

    expect(result).toMatchObject({
      provider: 'copilot',
      providerSource: 'provider_routing.steps',
      model: undefined,
      modelSource: 'default',
    });
  });

  it('Given a mismatched first tag model and a lower global model, When resolving, Then it does not fall through to the global model', () => {
    const result = resolveStepProviderModel({
      step: createStep(['plan']),
      provider: 'copilot',
      providerSource: 'cli',
      model: 'gpt-5',
      modelSource: 'global',
      providerRouting: {
        tags: { plan: { provider: 'claude', model: 'opus' } },
      },
    });

    expect(result).toMatchObject({
      provider: 'copilot',
      providerSource: 'cli',
      model: undefined,
      modelSource: 'default',
    });
  });

  it('Given a matching tag provider and model, When resolving without overrides, Then it uses the tag model', () => {
    const result = resolveStepProviderModel({
      step: createStep(['plan']),
      providerRouting: {
        tags: { plan: { provider: 'claude', model: 'opus' } },
      },
    });

    expect(result).toMatchObject({
      provider: 'claude',
      providerSource: 'provider_routing.tags',
      model: 'opus',
      modelSource: 'provider_routing.tags',
    });
  });

  it('Given a Claude tag model, When the CLI selects Claude SDK, Then the model is dropped', () => {
    const result = resolveStepProviderModel({
      step: createStep(['plan']),
      provider: 'claude-sdk',
      providerSource: 'cli',
      providerRouting: {
        tags: { plan: { provider: 'claude', model: 'opus' } },
      },
    });

    expect(result).toMatchObject({
      provider: 'claude-sdk',
      providerSource: 'cli',
      model: undefined,
      modelSource: 'default',
    });
  });

  it('Given a CLI model and a mismatched lower tag model, When the CLI selects Copilot, Then it uses the CLI model', () => {
    const result = resolveStepProviderModel({
      step: createStep(['plan']),
      provider: 'copilot',
      providerSource: 'cli',
      model: 'gpt-5',
      modelSource: 'cli',
      providerRouting: {
        tags: { plan: { provider: 'claude', model: 'opus' } },
      },
    });

    expect(result).toMatchObject({
      provider: 'copilot',
      providerSource: 'cli',
      model: 'gpt-5',
      modelSource: 'cli',
    });
  });

  it('does not let a provider-only CLI override suppress a matching routing model', () => {
    const result = resolveStepProviderModel({
      step: createStep(['plan']),
      provider: 'claude',
      providerSource: 'cli',
      model: undefined,
      modelSource: 'cli',
      providerRouting: {
        tags: { plan: { provider: 'claude', model: 'opus' } },
      },
    });

    expect(result).toMatchObject({
      provider: 'claude',
      providerSource: 'cli',
      model: 'opus',
      modelSource: 'provider_routing.tags',
    });
  });

  it.each([
    {
      label: 'step routing',
      providerRouting: { steps: { plan: { provider: 'claude', model: 'opus' } } },
      step: createStep(),
    },
    {
      label: 'persona routing',
      providerRouting: { personas: { coder: { provider: 'claude', model: 'opus' } } },
      step: createStep([], { providerRoutingPersonaKey: 'coder' }),
    },
    {
      label: 'persona provider mapping',
      personaProviders: { coder: { provider: 'claude', model: 'opus' } },
      step: createStep([], { personaDisplayName: 'coder' }),
    },
  ] as const)('Given a Claude model in $label, When the CLI selects Copilot, Then it drops that model', ({
    step,
    providerRouting,
    personaProviders,
  }) => {
    const result = resolveStepProviderModel({
      step,
      provider: 'copilot',
      providerSource: 'cli',
      providerRouting,
      personaProviders,
    });

    expect(result).toMatchObject({
      provider: 'copilot',
      providerSource: 'cli',
      model: undefined,
      modelSource: 'default',
    });
  });

  it('Given a model-bearing tag followed by a provider-only tag, When tags are combined, Then it compares against the model tag provider', () => {
    const result = resolveStepProviderModel({
      step: createStep(['model-owner', 'provider-override']),
      providerRouting: {
        tags: {
          'model-owner': { provider: 'claude', model: 'opus' },
          'provider-override': { provider: 'copilot' },
        },
      },
    });

    expect(result).toMatchObject({
      provider: 'copilot',
      providerSource: 'provider_routing.tags',
      model: undefined,
      modelSource: 'default',
    });
  });

  it('Given a later model-only tag, When tags are combined, Then it passes that model without provider matching', () => {
    const result = resolveStepProviderModel({
      step: createStep(['provider-owner', 'model-only']),
      providerRouting: {
        tags: {
          'provider-owner': { provider: 'claude' },
          'model-only': { model: 'gpt-5' },
        },
      },
    });

    expect(result).toMatchObject({
      provider: 'claude',
      providerSource: 'provider_routing.tags',
      model: 'gpt-5',
      modelSource: 'provider_routing.tags',
    });
  });

  it('Given a parent config model owned by Claude, When workflow_call passes it to a Copilot-routed child, Then the child drops the model', () => {
    const inheritedProviderInfo = resolveWorkflowCallChildProviderModel({
      model: 'opus',
      modelSource: 'global',
      modelProvider: 'claude',
    });
    const childProviderInfo = resolveStepProviderModel({
      ...inheritedProviderInfo,
      step: createStep([], { name: 'child' }),
      providerRouting: {
        steps: { child: { provider: 'copilot' } },
      },
    });

    expect(childProviderInfo).toMatchObject({
      provider: 'copilot',
      providerSource: 'provider_routing.steps',
      model: undefined,
      modelSource: 'default',
    });
  });
});

describe('model routing consumers', () => {
  it('passes no model to the provider call when the winning provider differs from the tag model provider', () => {
    const engineOptions: WorkflowEngineOptions = {
      projectCwd: '/project',
      provider: 'copilot',
      providerSource: 'cli',
      providerRouting: {
        tags: { plan: { provider: 'claude', model: 'opus' } },
      },
    };
    const step: WorkflowStep = createPlanStep({ tags: ['plan'] });
    const options = createOptionsBuilder(engineOptions).buildBaseOptions(step);

    expect(options.resolvedProvider).toBe('copilot');
    expect(options.resolvedModel).toBeUndefined();
  });

  it('allows the OpenCode runtime default after a mismatched routing model is dropped', () => {
    const workflow: WorkflowConfig = {
      name: 'provider-model-validation',
      description: 'Provider model validation',
      maxSteps: 1,
      initialStep: 'plan',
      steps: [createPlanStep({ tags: ['plan'] })],
    };

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: '/project',
      provider: 'opencode',
      providerSource: 'cli',
      providerRouting: {
        tags: { plan: { provider: 'claude', model: 'opus' } },
      },
    })).not.toThrow();

    const options = createOptionsBuilder({
      projectCwd: '/project',
      provider: 'opencode',
      providerSource: 'cli',
      providerRouting: { tags: { plan: { provider: 'claude', model: 'opus' } } },
    }).buildAgentOptions(createPlanStep({ tags: ['plan'] }));
    expect(options).toMatchObject({ resolvedProvider: 'opencode', allowDefaultModel: true });
    expect(options.resolvedModel).toBeUndefined();
  });

  it('does not allow the OpenCode runtime default when no model was resolved', () => {
    const step = createPlanStep();
    const engineOptions: WorkflowEngineOptions = {
      projectCwd: '/project',
      provider: 'opencode',
      providerSource: 'cli',
    };

    expect(() => validateWorkflowConfig({
      name: 'provider-model-validation',
      description: 'Provider model validation',
      maxSteps: 1,
      initialStep: 'plan',
      steps: [step],
    }, engineOptions)).toThrow(/requires model/);

    const options = createOptionsBuilder(engineOptions).buildAgentOptions(step);
    expect(options.resolvedModel).toBeUndefined();
    expect(options.allowDefaultModel).toBeUndefined();
  });

  it('passes a model-only alias to an auto-routed provider without compatibility rejection', () => {
    const autoRouting: AutoRoutingConfig = {
      strategy: 'balanced',
      router: { provider: 'mock', model: 'router-model' },
      candidates: [{
        name: 'coding',
        description: 'Implementation',
        provider: 'codex',
        model: 'gpt-5',
        routingTier: 'medium',
      }],
      defaultPool: 'general',
      candidatePools: { general: { candidates: ['coding'], fallback: 'coding' } },
    };
    const candidate = autoRouting.candidates[0]!;
    const result = resolveAutoRoutingCandidateProviderInfo(
      candidate,
      'auto.dynamic',
      autoRouting,
      { provider: undefined, model: 'opus', modelSource: 'global' },
    );

    expect(result).toMatchObject({
      provider: 'codex',
      model: 'opus',
      modelSource: 'global',
    });
  });

  it('drops an auto-routed candidate model when the first model belongs to another provider', () => {
    const autoRouting: AutoRoutingConfig = {
      strategy: 'balanced',
      router: { provider: 'mock', model: 'router-model' },
      candidates: [{
        name: 'coding',
        description: 'Implementation',
        provider: 'codex',
        model: 'gpt-5',
        routingTier: 'medium',
      }],
      defaultPool: 'general',
      candidatePools: { general: { candidates: ['coding'], fallback: 'coding' } },
    };
    const candidate = autoRouting.candidates[0]!;
    const result = resolveAutoRoutingCandidateProviderInfo(
      candidate,
      'auto.dynamic',
      autoRouting,
      {
        provider: undefined,
        model: 'opus',
        modelSource: 'global',
        modelProvider: 'claude',
      },
    );

    expect(result).toMatchObject({
      provider: 'codex',
      model: undefined,
      modelSource: 'default',
    });
  });

  it('drops an explicit Claude model without error when auto-routing selects OpenCode', () => {
    const autoRouting: AutoRoutingConfig = {
      strategy: 'balanced',
      router: { provider: 'mock', model: 'router-model' },
      candidates: [{
        name: 'coding',
        description: 'Implementation',
        provider: 'opencode',
        model: 'probe/candidate',
        routingTier: 'medium',
      }],
      defaultPool: 'general',
      candidatePools: { general: { candidates: ['coding'], fallback: 'coding' } },
    };
    const candidate = autoRouting.candidates[0]!;

    const result = resolveAutoRoutingCandidateProviderInfo(
      candidate,
      'auto.dynamic',
      autoRouting,
      {
        provider: undefined,
        model: 'probe/explicit',
        modelSource: 'global',
        modelProvider: 'claude',
      },
    );

    expect(result).toMatchObject({
      provider: 'opencode',
      model: undefined,
      modelSource: 'default',
    });
    expect(result.model).not.toBe(candidate.model);
  });

  it('retains the same auto-routed OpenCode model when its explicit owner matches', () => {
    const autoRouting: AutoRoutingConfig = {
      strategy: 'balanced',
      router: { provider: 'mock', model: 'router-model' },
      candidates: [{
        name: 'coding',
        description: 'Implementation',
        provider: 'opencode',
        model: 'probe/candidate',
        routingTier: 'medium',
      }],
      defaultPool: 'general',
      candidatePools: { general: { candidates: ['coding'], fallback: 'coding' } },
    };
    const candidate = autoRouting.candidates[0]!;
    const result = resolveAutoRoutingCandidateProviderInfo(
      candidate,
      'auto.dynamic',
      autoRouting,
      {
        provider: undefined,
        model: 'probe/explicit',
        modelSource: 'global',
        modelProvider: 'opencode',
      },
    );

    expect(result).toMatchObject({
      provider: 'opencode',
      model: 'probe/explicit',
      modelSource: 'global',
    });
  });
});
