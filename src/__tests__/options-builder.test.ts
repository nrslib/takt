import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import type { WorkflowResumePointEntry, WorkflowStep } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';

function createStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: 'reviewers',
    personaDisplayName: 'Reviewers',
    instruction: 'review',
    passPreviousResponse: false,
    ...overrides,
  };
}

type BuilderEngineOverrides = Partial<WorkflowEngineOptions> & {
  workflowName?: string;
  failureDir?: string;
};

interface PhaseContextSources {
  readonly currentWorkflowStack?: readonly WorkflowResumePointEntry[];
  readonly reportsRootDir?: string;
}

function createProcessSafetyByStep(parentRunPid: number): WorkflowEngineOptions['phase1ProcessSafetyByStep'] {
  return {
    implement: { protectedParentRunPid: parentRunPid },
  };
}

function createBuilder(
  step: WorkflowStep,
  engineOverrides: BuilderEngineOverrides = {},
  recordActivity: NonNullable<ConstructorParameters<typeof OptionsBuilder>[14]> = () => {},
  phaseContextSources: PhaseContextSources = {},
): OptionsBuilder {
  const currentWorkflowStack = phaseContextSources.currentWorkflowStack;
  const reportsRootDir = phaseContextSources.reportsRootDir;
  const engineOptions: WorkflowEngineOptions = {
    projectCwd: '/project',
    provider: 'codex',
    providerProfiles: {
      codex: {
        defaultPermissionMode: 'full',
      },
    },
    ...engineOverrides,
  };

  return new OptionsBuilder(
    engineOptions,
    () => '/project',
    () => '/project',
    () => undefined,
    () => '.takt/runs/sample/reports',
    () => 'ja',
    () => [{ name: step.name }],
    () => engineOverrides.workflowName ?? 'default',
    () => 'test workflow',
    currentWorkflowStack === undefined
      ? undefined
      : () => [...currentWorkflowStack],
    () => 'Original workflow task',
    undefined,
    engineOverrides.failureDir === undefined ? undefined : () => engineOverrides.failureDir,
    () => engineOptions.abortSignal,
    recordActivity,
    reportsRootDir === undefined
      ? undefined
      : () => reportsRootDir,
  );
}

describe('OptionsBuilder.buildBaseOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes permission resolution context for provider profile resolution', () => {
    const step = createStep();
    const builder = createBuilder(step);

    const options = builder.buildBaseOptions(step);

    expect(options.permissionMode).toBeUndefined();
    expect(options.permissionResolution).toEqual({
      stepName: 'reviewers',
      requiredPermissionMode: undefined,
      providerProfiles: {
        codex: { defaultPermissionMode: 'full' },
      },
    });
  });

  it('passes runtime defaults permission mode to the actual provider call', () => {
    const step = createStep();
    const builder = createBuilder(step, {
      providerSource: 'runtime-v1',
      providerPermissionMode: 'readonly',
    });

    const options = builder.buildBaseOptions(step);

    expect(options.permissionMode).toBe('readonly');
    expect(options.permissionResolution).toBeUndefined();
  });

  it('passes the winning persona profile permission mode to the actual provider call', () => {
    const step = createStep({ personaDisplayName: 'Reviewers' });
    const builder = createBuilder(step, {
      personaProviders: {
        Reviewers: { provider: 'claude', model: 'review-model', permissionMode: 'edit' },
      },
    });

    const options = builder.buildBaseOptions(step);

    expect(options.resolvedProvider).toBe('claude');
    expect(options.permissionMode).toBe('edit');
  });

  it.each([
    { label: 'same provider', targetProvider: 'codex' as const },
    { label: 'different provider', targetProvider: 'claude' as const },
  ])('does not leak defaults profile capabilities into a plain target profile ($label)', ({ targetProvider }) => {
    const step = createStep({ personaDisplayName: 'Reviewers' });
    const builder = createBuilder(step, {
      provider: 'codex',
      providerSource: 'runtime-v1',
      providerOptionsProviderSource: 'runtime-v1',
      providerOptions: {
        codex: { networkAccess: false },
        claude: { allowedTools: ['Read'] },
      },
      personaProviders: {
        Reviewers: { provider: targetProvider, model: 'target-model' },
      },
    });

    expect(builder.buildAgentOptions(step).providerOptions).toBeUndefined();
  });

  it('does not leak a runtime default profile into a direct step provider override', () => {
    const step = createStep({ provider: 'claude', model: 'step-model' });
    const builder = createBuilder(step, {
      provider: 'codex',
      providerSource: 'runtime-v1',
      providerOptionsProviderSource: 'runtime-v1',
      providerOptions: {
        codex: { networkAccess: false },
        claude: { allowedTools: ['Read'] },
      },
    });

    expect(builder.buildAgentOptions(step).providerOptions).toBeUndefined();
  });

  it('passes only the winning target profile capabilities to the actual provider call', () => {
    const step = createStep({ personaDisplayName: 'Reviewers' });
    const builder = createBuilder(step, {
      provider: 'codex',
      providerSource: 'runtime-v1',
      providerOptionsProviderSource: 'runtime-v1',
      providerOptions: {
        codex: { networkAccess: false },
      },
      personaProviders: {
        Reviewers: {
          provider: 'claude',
          model: 'target-model',
          providerOptions: { claude: { allowedTools: ['Read', 'Glob'] } },
        },
      },
    });

    expect(builder.buildAgentOptions(step).providerOptions).toEqual({
      claude: { allowedTools: ['Read', 'Glob'] },
    });
  });

  it('drops synthesized seat options and permission when a CLI provider override wins', () => {
    const step = createStep({
      provider: 'claude',
      model: 'seat-model',
      internalProviderOptions: {
        codex: { networkAccess: false },
        claude: { allowedTools: ['Read'] },
      },
      internalPermissionMode: 'readonly',
    });
    const builder = createBuilder(step, {
      provider: 'codex',
      providerSource: 'cli',
      model: 'cli-model',
      modelSource: 'cli',
    });

    const options = builder.buildAgentOptions(step);

    expect(options.resolvedProvider).toBe('codex');
    expect(options.resolvedModel).toBe('cli-model');
    expect(options.providerOptions).toBeUndefined();
    expect(options.permissionMode).toBeUndefined();
  });

  it('keeps synthesized seat options and permission when the seat provider wins', () => {
    const step = createStep({
      provider: 'claude',
      model: 'seat-model',
      internalProviderOptions: { claude: { allowedTools: ['Read'] } },
      internalPermissionMode: 'readonly',
    });
    const options = createBuilder(step).buildAgentOptions(step);

    expect(options.providerOptions).toEqual({ claude: { allowedTools: ['Read'] } });
    expect(options.permissionMode).toBe('readonly');
  });

  it('keeps synthesized seat options and permission across a model-only CLI override', () => {
    const step = createStep({
      provider: 'codex',
      model: 'seat-model',
      internalProviderOptions: { codex: { networkAccess: false } },
      internalPermissionMode: 'readonly',
    });
    const options = createBuilder(step, {
      provider: 'codex',
      providerSource: 'runtime-v1',
      model: 'cli-model',
      modelSource: 'cli',
    }).buildAgentOptions(step);

    expect(options.resolvedProvider).toBe('codex');
    expect(options.resolvedModel).toBe('cli-model');
    expect(options.providerOptions).toEqual({ codex: { networkAccess: false } });
    expect(options.permissionMode).toBe('readonly');
  });

  it.each([
    { label: 'persona', personaOptions: { codex: { networkAccess: false } }, tagOptions: undefined },
    { label: 'tag', personaOptions: undefined, tagOptions: { codex: { networkAccess: false } } },
  ])('drops a constrained $label profile when a plain step profile wins', ({ personaOptions, tagOptions }) => {
    const step = createStep({ name: 'reviewers', personaDisplayName: 'Reviewers', tags: ['review'] });
    const builder = createBuilder(step, {
      provider: 'codex',
      providerSource: 'runtime-v1',
      providerOptionsProviderSource: 'runtime-v1',
      personaProviders: personaOptions === undefined ? undefined : {
        Reviewers: { provider: 'codex', model: 'persona-model', providerOptions: personaOptions },
      },
      providerRouting: {
        tags: tagOptions === undefined ? undefined : {
          review: { provider: 'codex', model: 'tag-model', providerOptions: tagOptions },
        },
        steps: { reviewers: { provider: 'claude', model: 'step-model' } },
      },
    });

    expect(builder.buildAgentOptions(step).providerOptions).toBeUndefined();
  });

  it('keeps workflow capability options independent of the winning runtime profile', () => {
    const step = createStep({
      personaDisplayName: 'Reviewers',
      capabilityProviderOptions: { claude: { allowedTools: ['Read'] } },
    });
    const builder = createBuilder(step, {
      provider: 'codex',
      providerSource: 'runtime-v1',
      providerOptionsProviderSource: 'runtime-v1',
      personaProviders: {
        Reviewers: { provider: 'claude', model: 'target-model' },
      },
    });

    expect(builder.buildAgentOptions(step).providerOptions).toEqual({
      claude: { allowedTools: ['Read'] },
    });
  });

  it('keeps legacy persona and step option layering when runtime profiles are not active', () => {
    const step = createStep({
      personaDisplayName: 'Reviewers',
      providerOptions: { codex: { reasoningEffort: 'high' } },
    });
    const builder = createBuilder(step, {
      personaProviders: {
        Reviewers: { provider: 'codex', providerOptions: { codex: { networkAccess: false } } },
      },
    });

    expect(builder.buildAgentOptions(step).providerOptions).toEqual({
      codex: { networkAccess: false, reasoningEffort: 'high' },
    });
  });

  it('includes requiredPermissionMode in permission resolution context', () => {
    const step = createStep({ requiredPermissionMode: 'full' });
    const builder = createBuilder(step);

    const options = builder.buildBaseOptions(step);

    expect(options.permissionResolution).toEqual({
      stepName: 'reviewers',
      requiredPermissionMode: 'full',
      providerProfiles: {
        codex: { defaultPermissionMode: 'full' },
      },
    });
  });

  it('still passes permission resolution context when provider is not configured', () => {
    const step = createStep();
    const builder = createBuilder(step, {
      provider: undefined,
      providerProfiles: undefined,
    });

    const options = builder.buildBaseOptions(step);
    expect(options.permissionResolution).toEqual({
      stepName: 'reviewers',
      requiredPermissionMode: undefined,
      providerProfiles: undefined,
    });
  });

  it('lets step override project provider options when origin resolver is absent', () => {
    const step = createStep({
      providerOptions: {
        codex: { networkAccess: false },
        claude: {
          sandbox: { excludedCommands: ['./gradlew'] },
          allowedTools: ['Read', 'Edit', 'Bash'],
        },
      },
    });
    const builder = createBuilder(step, {
      providerOptionsSource: 'project',
      providerOptions: {
        codex: { networkAccess: true },
        claude: { sandbox: { allowUnsandboxedCommands: true }, allowedTools: ['Read', 'Glob'] },
        opencode: { networkAccess: true },
      },
    });

    const options = builder.buildBaseOptions(step);

    expect(options.providerOptions).toEqual({
      codex: { networkAccess: false },
      opencode: { networkAccess: true },
      claude: {
        sandbox: {
          excludedCommands: ['./gradlew'],
          allowUnsandboxedCommands: true,
        },
        allowedTools: ['Read', 'Edit', 'Bash'],
      },
    });
  });


  it('lets step override when provider options source is global', () => {
    const step = createStep({
      providerOptions: {
        codex: { networkAccess: false },
      },
    });
    const builder = createBuilder(step, {
      providerOptionsSource: 'global',
      providerOptions: {
        codex: { networkAccess: true },
      },
    });

    const options = builder.buildBaseOptions(step);

    expect(options.providerOptions).toEqual({
      codex: { networkAccess: false },
    });
  });

  it('falls back to global/project provider options when step has none', () => {
    const step = createStep();
    const builder = createBuilder(step, {
      providerOptions: {
        codex: { networkAccess: false },
      },
    });

    const options = builder.buildBaseOptions(step);

    expect(options.providerOptions).toEqual({
      codex: { networkAccess: false },
    });
  });

  it('keeps fully resolved persisted runtime options without merging current config layers', () => {
    const step = createStep({
      provider: 'codex',
      model: 'current-model',
      providerOptions: {
        codex: {
          reasoningEffort: 'low',
          networkAccess: false,
        },
      },
    });
    const builder = createBuilder(step, {
      providerOptions: {
        codex: {
          reasoningEffort: 'medium',
          networkAccess: true,
        },
      },
    });
    const persistedRuntime = {
      providerInfoResolution: 'fully_resolved' as const,
      providerInfo: {
        provider: 'codex' as const,
        model: 'persisted-model',
        providerOptions: {
          codex: {
            reasoningEffort: 'high' as const,
          },
        },
      },
    };

    expect(builder.resolveStepProviderModel(step, persistedRuntime)).toEqual(
      persistedRuntime.providerInfo,
    );
    expect(builder.buildAgentOptions(step, persistedRuntime)).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'persisted-model',
      providerOptions: {
        codex: {
          reasoningEffort: 'high',
        },
      },
    });
    expect(builder.buildAgentOptions(step, persistedRuntime).providerOptions)
      .not.toHaveProperty('codex.networkAccess');
  });

  it('lets persona provider_options override project provider options when step has none', () => {
    const step = createStep({ personaDisplayName: 'reviewer' });
    const builder = createBuilder(step, {
      providerOptionsSource: 'project',
      providerOptions: {
        codex: { networkAccess: true, reasoningEffort: 'low' },
        claude: {
          allowedTools: ['Read', 'Glob'],
          sandbox: { allowUnsandboxedCommands: false },
        },
      },
      personaProviders: {
        reviewer: {
          providerOptions: {
            codex: { reasoningEffort: 'high' },
            claude: { allowedTools: ['Read', 'Edit'] },
          },
        },
      },
    });

    const options = builder.buildBaseOptions(step);

    expect(options.providerOptions).toEqual({
      codex: { networkAccess: true, reasoningEffort: 'high' },
      claude: {
        allowedTools: ['Read', 'Edit'],
        sandbox: { allowUnsandboxedCommands: false },
      },
    });
  });

  it('uses nested env origin to keep config value only for the overridden leaf', () => {
    const step = createStep({
      providerOptions: {
        codex: { networkAccess: false },
        claude: { allowedTools: ['Read', 'Edit'] },
      },
    });
    const builder = createBuilder(step, {
      providerOptionsSource: 'project',
      providerOptionsOriginResolver: (path: string) => {
        if (path === 'codex.networkAccess') return 'env';
        if (path === 'providerOptions') return 'local';
        return 'default';
      },
      providerOptions: {
        codex: { networkAccess: true },
        claude: { allowedTools: ['Read', 'Glob'] },
      },
    });

    const options = builder.buildBaseOptions(step);

    expect(options.providerOptions).toEqual({
      codex: { networkAccess: true },
      claude: { allowedTools: ['Read', 'Edit'] },
    });
  });

  it('keeps env-origin config leaf ahead of persona provider_options', () => {
    const step = createStep({ personaDisplayName: 'reviewer' });
    const builder = createBuilder(step, {
      providerOptionsSource: 'project',
      providerOptionsOriginResolver: (path: string) => (
        path === 'codex.reasoningEffort' ? 'env' : 'default'
      ),
      providerOptions: {
        codex: { reasoningEffort: 'low' },
      },
      personaProviders: {
        reviewer: {
          providerOptions: {
            codex: { reasoningEffort: 'high' },
          },
        },
      },
    });

    const options = builder.buildBaseOptions(step);

    expect(options.providerOptions).toEqual({
      codex: { reasoningEffort: 'low' },
    });
  });

  it('buildBaseOptions は takt-default の implement でも process safety を workflowMeta に含めない', () => {
    const step = createStep({ name: 'implement' });
    const builder = createBuilder(step, {
      workflowName: 'takt-default',
      phase1ProcessSafetyByStep: createProcessSafetyByStep(4242),
    });

    const options = builder.buildBaseOptions(step);

    expect(options.workflowMeta).toEqual(expect.objectContaining({
      workflowName: 'takt-default',
      currentStep: 'implement',
    }));
    expect(options.workflowMeta?.processSafety).toBeUndefined();
  });

  it('takt-default の implement では Phase 1 agent options に process safety を workflowMeta に含める', () => {
    const step = createStep({ name: 'implement' });
    const builder = createBuilder(step, {
      workflowName: 'takt-default',
      phase1ProcessSafetyByStep: createProcessSafetyByStep(4242),
    });

    const options = builder.buildAgentOptions(step);

    expect(options.workflowMeta).toEqual(expect.objectContaining({
      workflowName: 'takt-default',
      currentStep: 'implement',
      processSafety: { protectedParentRunPid: 4242 },
    }));
  });

  it('takt-default の implement.part-* でも process safety を workflowMeta に含める', () => {
    const step = createStep({
      name: 'implement.part-1',
      persona: 'coder',
      personaDisplayName: 'coder',
    });
    const builder = createBuilder(step, {
      workflowName: 'takt-default',
      phase1ProcessSafetyByStep: createProcessSafetyByStep(4242),
    });

    const options = builder.buildAgentOptions(step, {
      teamLeaderPart: {
        processSafety: { protectedParentRunPid: 4242 },
      },
    });

    expect(options.workflowMeta).toEqual(expect.objectContaining({
      workflowName: 'takt-default',
      currentStep: 'implement.part-1',
      processSafety: { protectedParentRunPid: 4242 },
    }));
  });

  it('takt-default の非 implement step では process safety を workflowMeta に含めない', () => {
    const step = createStep({ name: 'reviewers' });
    const builder = createBuilder(step, {
      workflowName: 'takt-default',
      phase1ProcessSafetyByStep: createProcessSafetyByStep(4242),
    });

    const options = builder.buildAgentOptions(step);

    expect(options.workflowMeta?.processSafety).toBeUndefined();
  });

  it('対象外の workflow/step では process safety を workflowMeta に含めない', () => {
    const step = createStep({ name: 'reviewers' });
    const builder = createBuilder(step, {
      workflowName: 'custom-workflow',
      phase1ProcessSafetyByStep: createProcessSafetyByStep(4242),
    });

    const options = builder.buildBaseOptions(step);

    expect(options.workflowMeta?.processSafety).toBeUndefined();
  });
});

describe('OptionsBuilder.resolveStepProviderModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return engine-level provider and model when step has no overrides', () => {
    const step = createStep();
    const builder = createBuilder(step, { provider: 'claude', model: 'sonnet' });

    const result = builder.resolveStepProviderModel(step);

    expect(result.provider).toBe('claude');
    expect(result.model).toBe('sonnet');
  });

  it('should prioritize persona providers over engine-level provider', () => {
    const step = createStep({ personaDisplayName: 'coder' });
    const builder = createBuilder(step, {
      provider: 'claude',
      model: 'sonnet',
      personaProviders: { coder: { provider: 'codex', model: 'o3-mini' } },
    });

    const result = builder.resolveStepProviderModel(step);

    expect(result.provider).toBe('codex');
    expect(result.model).toBe('o3-mini');
  });

  it('should prioritize step-level provider over engine-level provider', () => {
    const step = createStep({ provider: 'opencode' as 'opencode' });
    const builder = createBuilder(step, { provider: 'claude' });

    const result = builder.resolveStepProviderModel(step);

    expect(result.provider).toBe('opencode');
  });

  it('should keep explicit step model omission instead of falling back to engine model', () => {
    const step = createStep({
      provider: 'cursor',
      model: undefined,
      modelSpecified: true,
    });
    const builder = createBuilder(step, { provider: 'cursor', model: 'global-model' });

    const result = builder.resolveStepProviderModel(step);
    const baseOptions = builder.buildBaseOptions(step);

    expect(result).toEqual(expect.objectContaining({
      provider: 'cursor',
      model: undefined,
      modelSource: 'step',
    }));
    expect(baseOptions.resolvedModel).toBeUndefined();
  });

  it('should prioritize step-level provider over persona providers', () => {
    const step = createStep({ personaDisplayName: 'coder', provider: 'claude' as 'claude' });
    const builder = createBuilder(step, {
      provider: 'mock',
      personaProviders: { coder: { provider: 'codex' } },
    });

    const result = builder.resolveStepProviderModel(step);

    expect(result.provider).toBe('claude');
  });

  it('should return undefined model when no model is configured', () => {
    const step = createStep();
    const builder = createBuilder(step, { provider: 'claude', model: undefined });

    const result = builder.resolveStepProviderModel(step);

    expect(result.model).toBeUndefined();
  });

  it('should return undefined provider when no provider is configured', () => {
    const step = createStep();
    const builder = createBuilder(step, { provider: undefined });

    const result = builder.resolveStepProviderModel(step);

    expect(result.provider).toBeUndefined();
  });

  it('should match buildBaseOptions resolvedProvider and resolvedModel', () => {
    const step = createStep({ personaDisplayName: 'coder' });
    const builder = createBuilder(step, {
      provider: 'claude',
      model: 'sonnet',
      personaProviders: { coder: { provider: 'codex', model: 'o3-mini' } },
    });

    const providerInfo = builder.resolveStepProviderModel(step);
    const baseOptions = builder.buildBaseOptions(step);

    expect(providerInfo.provider).toBe(baseOptions.resolvedProvider);
    expect(providerInfo.model).toBe(baseOptions.resolvedModel);
  });

  it('should prefer runtime provider info over persona and engine resolution', () => {
    const step = createStep({ personaDisplayName: 'loop-judge', provider: 'opencode', model: 'opencode/model-a' });
    const builder = createBuilder(step, {
      provider: 'claude',
      model: 'sonnet',
      personaProviders: { 'loop-judge': { provider: 'opencode', model: 'opencode/model-b' } },
    });

    const result = builder.resolveStepProviderModel(step, {
      providerInfo: { provider: 'codex', model: 'gpt-5.2-codex' },
    });

    expect(result).toEqual({
      provider: 'codex',
      model: 'gpt-5.2-codex',
    });
  });
});

describe('OptionsBuilder auto routing deterministic completion', () => {
  const autoRouting: WorkflowEngineOptions['autoRouting'] = {
    strategy: 'balanced',
    router: { provider: 'claude-sdk', model: 'router-model' },
    candidates: [
      {
        name: 'coding',
        description: 'Implementation and tests',
        provider: 'codex',
        model: 'default-candidate-model',
        routingTier: 'medium',
      },
    ],
    defaultPool: 'general',
    candidatePools: { general: { candidates: ['coding'], fallback: 'coding' } },
    poolRules: { steps: { implement: 'general', 'findings-manager': 'general' } },
    rules: { steps: { implement: 'coding' } },
  };

  function createManagerLikeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
    return createStep({
      name: 'findings-manager',
      structuredOutput: {
        schemaRef: 'takt.findings.manager',
        schema: { type: 'object' },
      },
      ...overrides,
    });
  }

  it('resolveStepProviderModel applies auto routing rules before the strategy default', () => {
    const step = createManagerLikeStep({ name: 'implement' });
    const builder = createBuilder(step, { provider: 'codex', providerSource: 'global', autoRouting });

    expect(builder.resolveStepProviderModel(step)).toMatchObject({
      provider: 'codex',
      providerSource: 'auto.rules',
    });
  });

  it('resolveStepProviderModel prefers runtime providerInfo routed by the run loop over the deterministic completion', () => {
    const step = createManagerLikeStep();
    const builder = createBuilder(step, { provider: 'codex', providerSource: 'global', autoRouting });

    const resolved = builder.resolveStepProviderModel(step, {
      providerInfo: { provider: 'claude', model: 'sonnet', providerSource: 'auto.dynamic', modelSource: 'auto.dynamic' },
    });

    expect(resolved).toMatchObject({ provider: 'claude', model: 'sonnet', providerSource: 'auto.dynamic' });
  });

  it('resolveStepProviderModel does not override a provider resolved by persona providers', () => {
    const step = createManagerLikeStep({ personaDisplayName: 'findings-manager' });
    const builder = createBuilder(step, {
      provider: 'codex',
      providerSource: 'global',
      autoRouting,
      personaProviders: { 'findings-manager': { provider: 'claude', model: 'sonnet' } },
    });

    expect(builder.resolveStepProviderModel(step)).toMatchObject({
      provider: 'claude',
      model: 'sonnet',
      providerSource: 'persona_providers',
    });
  });

  it('resolveStepProviderModelBeforeAutoRouting leaves the provider unresolved so the AI router keeps its say', () => {
    const step = createManagerLikeStep();
    const builder = createBuilder(step, { provider: 'codex', providerSource: 'global', autoRouting });

    expect(builder.resolveStepProviderModelBeforeAutoRouting(step).provider).toBeUndefined();
  });
});

describe('OptionsBuilder.buildResumeOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should enforce readonly permission and empty allowedTools for report/status phases', () => {
    // Given
    const step = createStep({ requiredPermissionMode: 'full' });
    const builder = createBuilder(step, { bypassPermissions: true });

    // When
    const options = builder.buildResumeOptions(step, 'session-123', { maxTurns: 3 });

    // Then
    expect(options.permissionMode).toBe('readonly');
    expect(options.permissionResolution).toBeUndefined();
    expect(options.bypassPermissions).toBeUndefined();
    expect(options.allowedTools).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(options, 'maxTurns')).toBe(true);
    expect(options.maxTurns).toBe(3);
    expect(options.sessionId).toBe('session-123');
  });

  it('report/status phase では takt-default の implement でも process safety を付与しない', () => {
    const step = createStep({ name: 'implement' });
    const builder = createBuilder(step, {
      workflowName: 'takt-default',
      phase1ProcessSafetyByStep: createProcessSafetyByStep(4242),
    });

    const options = builder.buildResumeOptions(step, 'session-123', { maxTurns: 3 });

    expect(options.workflowMeta?.processSafety).toBeUndefined();
  });

  it('never requests the step structured output on report/status phases', () => {
    // Given: structured_output は Phase 1 の遷移判定用。Phase 2 で要求すると provider が
    // スキーマどおりの JSON を返し、それが report file になる（issue #1242）
    // report fallback は primary が opencode のときだけ成立するので、fallback 分岐まで
    // 到達させるために step provider を opencode にする
    const step = createStep({
      provider: 'opencode',
      model: 'opencode/qwen3-coder-next',
      structuredOutput: {
        schemaRef: 'researcher-status',
        schema: {
          type: 'object',
          properties: { status: { type: 'string' } },
          required: ['status'],
          additionalProperties: false,
        },
      },
    });
    const builder = createBuilder(step, {
      reportFallbackProvider: { provider: 'mock', model: 'mock-report-model' },
    });

    // When
    const resumeOptions = builder.buildResumeOptions(step, 'session-123', { maxTurns: 3 });
    const newSessionOptions = builder.buildNewSessionReportOptions(step, {
      allowedTools: [],
      maxTurns: 3,
    });
    const fallbackOptions = builder.buildFallbackReportOptions(step, newSessionOptions, {
      allowedTools: [],
      maxTurns: 3,
    });

    // Then
    // fallback 分岐が実際に実行されたことを先に固定する。optional chaining のままだと
    // buildFallbackReportOptions が undefined を返しても outputSchema の検証が通ってしまう。
    if (fallbackOptions === undefined) {
      throw new Error('Expected fallback report options');
    }
    expect(fallbackOptions.resolvedProvider).toBe('mock');
    expect(resumeOptions.outputSchema).toBeUndefined();
    expect(newSessionOptions.outputSchema).toBeUndefined();
    expect(fallbackOptions.outputSchema).toBeUndefined();
  });

  it('read-only phase options retain the workflow deadline activity callback', () => {
    const step = createStep({ provider: 'opencode', model: 'opencode/report-model' });
    const recordActivity = vi.fn();
    const builder = createBuilder(step, {
      reportFallbackProvider: { provider: 'mock', model: 'mock-report-model' },
    }, recordActivity);
    const resumeOptions = builder.buildResumeOptions(step, 'session-123', { maxTurns: 3 });
    const newSessionOptions = builder.buildNewSessionReportOptions(step, {
      allowedTools: [],
      maxTurns: 3,
    });
    const fallbackOptions = builder.buildFallbackReportOptions(step, newSessionOptions, {
      allowedTools: [],
      maxTurns: 3,
    });

    if (fallbackOptions === undefined) {
      throw new Error('Expected fallback report options');
    }
    resumeOptions.onActivity?.({ kind: 'attempt_started' });
    newSessionOptions.onActivity?.({ kind: 'attempt_started' });
    fallbackOptions.onActivity?.({ kind: 'attempt_started' });

    expect(recordActivity).toHaveBeenCalledTimes(3);
    expect(recordActivity).toHaveBeenNthCalledWith(1, {
      kind: 'attempt_started',
      executionUnitKey: step.name,
    });
    expect(recordActivity).toHaveBeenNthCalledWith(2, {
      kind: 'attempt_started',
      executionUnitKey: step.name,
    });
    expect(recordActivity).toHaveBeenNthCalledWith(3, {
      kind: 'attempt_started',
      executionUnitKey: step.name,
    });
  });

  it('removes report/status phase maxTurns when provider does not support it', () => {
    const step = createStep({ provider: 'claude-terminal' });
    const builder = createBuilder(step);

    const options = builder.buildResumeOptions(step, 'session-123', { maxTurns: 3 });

    expect(options.resolvedProvider).toBe('claude-terminal');
    expect(Object.prototype.hasOwnProperty.call(options, 'maxTurns')).toBe(false);
    expect(options.maxTurns).toBeUndefined();
  });

  it('removes report/status phase maxTurns for OpenCode because the SDK prompt payload does not support it', () => {
    const step = createStep({ provider: 'opencode', model: 'opencode/big-pickle' });
    const builder = createBuilder(step);

    const options = builder.buildResumeOptions(step, 'session-123', { maxTurns: 3 });

    expect(options.resolvedProvider).toBe('opencode');
    expect(Object.prototype.hasOwnProperty.call(options, 'maxTurns')).toBe(false);
    expect(options.maxTurns).toBeUndefined();
  });
});

describe('OptionsBuilder.buildNewSessionReportOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('new session の report phase でも process safety を付与しない', () => {
    const step = createStep({ name: 'implement' });
    const builder = createBuilder(step, {
      workflowName: 'takt-default',
      phase1ProcessSafetyByStep: createProcessSafetyByStep(4242),
    });

    const options = builder.buildNewSessionReportOptions(step, {
      allowedTools: ['Write'],
      maxTurns: 3,
    });

    expect(options.workflowMeta?.processSafety).toBeUndefined();
  });

  it('should enforce readonly permission without provider profile escalation for new-session report phase', () => {
    const step = createStep({ requiredPermissionMode: 'full' });
    const builder = createBuilder(step, {
      bypassPermissions: true,
      providerProfiles: {
        codex: { defaultPermissionMode: 'full' },
      },
    });

    const options = builder.buildNewSessionReportOptions(step, {
      allowedTools: [],
      maxTurns: 3,
    });

    expect(options.permissionMode).toBe('readonly');
    expect(options.permissionResolution).toBeUndefined();
    expect(options.bypassPermissions).toBeUndefined();
  });

  it('removes new-session report phase maxTurns when provider does not support it', () => {
    const step = createStep({ provider: 'claude-terminal' });
    const builder = createBuilder(step);

    const options = builder.buildNewSessionReportOptions(step, {
      allowedTools: [],
      maxTurns: 3,
    });

    expect(options.resolvedProvider).toBe('claude-terminal');
    expect(options.allowedTools).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(options, 'maxTurns')).toBe(false);
    expect(options.maxTurns).toBeUndefined();
  });

  it('removes new-session report phase maxTurns for OpenCode because the SDK prompt payload does not support it', () => {
    const step = createStep({ provider: 'opencode', model: 'opencode/big-pickle' });
    const builder = createBuilder(step);

    const options = builder.buildNewSessionReportOptions(step, {
      allowedTools: [],
      maxTurns: 3,
    });

    expect(options.resolvedProvider).toBe('opencode');
    expect(options.allowedTools).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(options, 'maxTurns')).toBe(false);
    expect(options.maxTurns).toBeUndefined();
  });
});

describe('OptionsBuilder.buildFallbackReportOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should build configured report fallback options without reusing the OpenCode model or session', () => {
    // Given
    const step = createStep({
      provider: 'opencode',
      model: 'opencode/qwen3-coder-next',
      requiredPermissionMode: 'full',
    });
    const builder = createBuilder(step, {
      bypassPermissions: true,
      reportFallbackProvider: {
        provider: 'mock',
        model: 'mock-report-model',
      },
    });

    // When
    const options = builder.buildFallbackReportOptions(step, {
      cwd: '/project',
      resolvedProvider: 'opencode',
      resolvedModel: 'opencode/qwen3-coder-next',
    }, {
      allowedTools: [],
      maxTurns: 3,
    });

    // Then
    expect(options).toBeDefined();
    if (options === undefined) {
      throw new Error('Expected fallback report options');
    }
    expect(options.resolvedProvider).toBe('mock');
    expect(options.resolvedModel).toBe('mock-report-model');
    expect(options.sessionId).toBeUndefined();
    expect(options.permissionMode).toBe('readonly');
    expect(options.permissionResolution).toBeUndefined();
    expect(options.bypassPermissions).toBeUndefined();
    expect(options.allowedTools).toEqual([]);
    expect(options.maxTurns).toBe(3);
    expect('providerSource' in options).toBe(false);
    expect('modelSource' in options).toBe(false);
  });

  it('should not build report fallback options when no report fallback provider is configured', () => {
    // Given
    const step = createStep({ provider: 'opencode', model: 'opencode/qwen3-coder-next' });
    const builder = createBuilder(step);

    // When
    const options = builder.buildFallbackReportOptions(step, {
      cwd: '/project',
      resolvedProvider: 'opencode',
      resolvedModel: 'opencode/qwen3-coder-next',
    }, {
      allowedTools: [],
      maxTurns: 3,
    });

    // Then
    expect(options).toBeUndefined();
  });

  it('should not build report fallback options when the failed report provider is not OpenCode', () => {
    // Given
    const step = createStep({ provider: 'codex' });
    const builder = createBuilder(step, {
      reportFallbackProvider: {
        provider: 'mock',
        model: 'mock-report-model',
      },
    });

    // When
    const options = builder.buildFallbackReportOptions(step, {
      cwd: '/project',
      resolvedProvider: 'codex',
    }, {
      allowedTools: [],
      maxTurns: 3,
    });

    // Then
    expect(options).toBeUndefined();
  });

  it('should not build report fallback options when fallback provider matches the failed primary provider', () => {
    // Given
    const step = createStep({ provider: 'opencode', model: 'opencode/qwen3-coder-next' });
    const builder = createBuilder(step, {
      reportFallbackProvider: {
        provider: 'opencode',
        model: 'opencode/report-model',
      },
    });

    // When
    const options = builder.buildFallbackReportOptions(step, {
      cwd: '/project',
      resolvedProvider: 'opencode',
      resolvedModel: 'opencode/qwen3-coder-next',
    }, {
      allowedTools: [],
      maxTurns: 3,
    });

    // Then
    expect(options).toBeUndefined();
  });

  it('should expose configured report fallback options through report phase context', () => {
    // Given
    const step = createStep({ provider: 'opencode', model: 'opencode/qwen3-coder-next' });
    const onProviderStream = vi.fn();
    const builder = createBuilder(step, {
      reportFallbackProvider: {
        provider: 'codex',
        model: 'gpt-5.1-mini',
      },
      onProviderStream,
      structuredCaller: {
        judgeStatus: vi.fn(),
      },
    });
    const state = {
      currentStep: step.name,
      stepCount: 1,
      history: [],
      personaSessions: new Map<string, string>([
        ['reviewers:opencode', 'opencode-session'],
      ]),
    };

    // When
    const ctx = builder.buildPhaseRunnerContext(step, state, 'Phase 1 response', vi.fn());
    ctx.onStream?.({ type: 'text', data: { text: 'Phase 2 response' } });
    const options = ctx.buildFallbackReportOptions(step, {
      cwd: '/project',
      resolvedProvider: 'opencode',
      resolvedModel: 'opencode/qwen3-coder-next',
    }, {
      allowedTools: [],
      maxTurns: 3,
    });

    // Then
    expect(ctx.task).toBe('Original workflow task');
    expect(ctx.lastResponse).toBe('Phase 1 response');
    expect(ctx.getSessionId('reviewers:opencode')).toBe('opencode-session');
    expect(ctx.resolveStepProviderModel(step)).toMatchObject({
      provider: 'opencode',
      model: 'opencode/qwen3-coder-next',
    });
    expect(onProviderStream).toHaveBeenCalledWith({
      step: 'reviewers',
      provider: 'opencode',
      providerModel: 'opencode/qwen3-coder-next',
    }, {
      type: 'text',
      data: { text: 'Phase 2 response' },
    });
    expect(options).toBeDefined();
    if (options === undefined) {
      throw new Error('Expected fallback report options');
    }
    expect(options).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5.1-mini',
      permissionMode: 'readonly',
      allowedTools: [],
      maxTurns: 3,
      sessionId: undefined,
    });
  });

  it('should expose report resolution coordinates through status judgment context', () => {
    const step = createStep({ name: 'final-gate' });
    const currentWorkflowStack: WorkflowResumePointEntry[] = [{
      workflow: 'review-gate',
      workflow_ref: 'review-gate',
      step: 'final-gate',
      kind: 'agent',
      occurrence: 1,
    }];
    const builder = createBuilder(step, {
      structuredCaller: { judgeStatus: vi.fn() },
    }, undefined, {
      currentWorkflowStack,
      reportsRootDir: '/project/.takt/runs/target-run/reports',
    });
    const state = {
      currentStep: step.name,
      stepCount: 1,
      history: [],
      personaSessions: new Map<string, string>(),
    };

    const ctx = builder.buildPhaseRunnerContext(step, state, 'Phase 1 response', vi.fn());

    expect(ctx.reportsRootDir).toBe('/project/.takt/runs/target-run/reports');
    expect(ctx.resumeReportConsumerKey).toBe(
      '{"workflow":"review-gate","step":"final-gate","calls":[]}',
    );
  });
});

describe('OptionsBuilder.buildAgentOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses merged providerOptions.claude.allowedTools when step.allowedTools is absent', () => {
    // Given
    const step = createStep({
      providerOptions: {
        claude: { allowedTools: ['Read', 'Edit', 'Bash'] },
      },
    });
    const builder = createBuilder(step, {
      provider: 'claude',
      providerOptions: {
        claude: { allowedTools: ['Read', 'Glob'] },
      },
    });

    // When
    const options = builder.buildAgentOptions(step);

    // Then
    expect(options.allowedTools).toEqual(['Read', 'Edit', 'Bash']);
  });

  it('removes write and command tools when output contracts exist and edit is not enabled', () => {
    // Given
    const step = createStep({
      outputContracts: [{ name: 'report.md', format: 'markdown', useJudge: true }],
      providerOptions: {
        claude: { allowedTools: ['Read', 'Write', 'Bash'] },
      },
      edit: false,
    });
    const builder = createBuilder(step, { provider: 'claude' });

    // When
    const options = builder.buildAgentOptions(step);

    // Then
    expect(options.allowedTools).toEqual(['Read']);
  });

  it('removes command tools when edit is false without output contracts', () => {
    const step = createStep({
      providerOptions: {
        claude: { allowedTools: ['Read', 'bash', ' Bash '] },
      },
      edit: false,
    });
    const builder = createBuilder(step, { provider: 'claude' });

    const options = builder.buildAgentOptions(step);

    expect(options.allowedTools).toEqual(['Read']);
  });

  it('removes OpenCode command tools when edit is false without output contracts', () => {
    const step = createStep({
      provider: 'opencode',
      model: 'opencode/big-pickle',
      providerOptions: {
        opencode: { allowedTools: ['read', 'bash', ' Bash ', 'edit', 'grep'] },
      },
      edit: false,
    });
    const builder = createBuilder(step, { provider: 'opencode' });

    const options = builder.buildAgentOptions(step);

    expect(options.allowedTools).toEqual(['read', 'bash', ' Bash ', 'grep']);
  });

  it('silently drops claude allowedTools when configured for a non-claude provider', () => {
    const step = createStep({
      provider: 'codex',
      providerOptions: {
        claude: { allowedTools: ['Read', 'Edit', 'Bash'] },
      },
    });
    const builder = createBuilder(step, {
      provider: 'claude',
    });

    const options = builder.buildAgentOptions(step);

    expect(options.allowedTools).toBeUndefined();
  });

  it('keeps claude allowedTools when the provider is mock', () => {
    const step = createStep({
      provider: 'mock',
      providerOptions: {
        claude: { allowedTools: ['Read', 'Edit'] },
      },
    });
    const builder = createBuilder(step, {
      provider: 'mock',
    });

    expect(builder.buildAgentOptions(step).allowedTools).toEqual(['Read', 'Edit']);
  });

  it('drops mcpServers silently for providers without MCP support', () => {
    const step = createStep({
      provider: 'cursor',
      mcpServers: {
        playwright: {
          type: 'sse',
          url: 'https://example.test/mcp',
        },
      },
    });
    const builder = createBuilder(step, {
      provider: 'cursor',
    });

    const options = builder.buildAgentOptions(step);

    expect(options.mcpServers).toBeUndefined();
  });

  it('keeps mcpServers when provider supports MCP', () => {
    const step = createStep({
      provider: 'claude',
      mcpServers: {
        playwright: {
          type: 'sse',
          url: 'https://example.test/mcp',
        },
      },
    });
    const builder = createBuilder(step, {
      provider: 'claude',
    });

    const options = builder.buildAgentOptions(step);

    expect(options.mcpServers).toEqual({
      playwright: {
        type: 'sse',
        url: 'https://example.test/mcp',
      },
    });
  });

  it('passes session mcpServers to agent options when provider supports MCP', () => {
    const step = createStep({ provider: 'claude' });
    const builder = createBuilder(step, {
      provider: 'claude',
      mcpServers: {
        docs: { type: 'stdio', command: 'docs-mcp' },
      },
    });

    const options = builder.buildAgentOptions(step);

    expect(options.mcpServers).toEqual({
      docs: { type: 'stdio', command: 'docs-mcp' },
    });
  });

  it('merges session and step mcpServers when names do not overlap', () => {
    const step = createStep({
      provider: 'claude',
      mcpServers: {
        playwright: { type: 'stdio', command: 'playwright-mcp' },
      },
    });
    const builder = createBuilder(step, {
      provider: 'claude',
      mcpServers: {
        docs: { type: 'stdio', command: 'docs-mcp' },
      },
    });

    const options = builder.buildAgentOptions(step);

    expect(options.mcpServers).toEqual({
      docs: { type: 'stdio', command: 'docs-mcp' },
      playwright: { type: 'stdio', command: 'playwright-mcp' },
    });
  });

  it('fails fast when session and step mcpServers use the same name', () => {
    const step = createStep({
      provider: 'claude',
      mcpServers: {
        docs: { type: 'stdio', command: 'step-docs-mcp' },
      },
    });
    const builder = createBuilder(step, {
      provider: 'claude',
      mcpServers: {
        docs: { type: 'stdio', command: 'session-docs-mcp' },
      },
    });

    expect(() => builder.buildAgentOptions(step)).toThrow(
      /MCP server "docs" is defined by both session and step "reviewers"/,
    );
  });

  it('fails fast for session mcpServers when provider does not support MCP', () => {
    const step = createStep({ provider: 'cursor' });
    const builder = createBuilder(step, {
      provider: 'cursor',
      mcpServers: {
        docs: { type: 'stdio', command: 'docs-mcp' },
      },
    });

    expect(() => builder.buildAgentOptions(step)).toThrow(
      /Provider "cursor" does not support session MCP servers for step "reviewers"/,
    );
  });

  it('resolves mcpServers for structured team leader planning calls', () => {
    const step = createStep({
      provider: 'claude',
      mcpServers: {
        playwright: { type: 'stdio', command: 'playwright-mcp' },
      },
    });
    const builder = createBuilder(step, {
      provider: 'claude',
      mcpServers: {
        docs: { type: 'stdio', command: 'docs-mcp' },
      },
    });

    expect(builder.resolveMcpServersForStep(step, 'claude')).toEqual({
      docs: { type: 'stdio', command: 'docs-mcp' },
      playwright: { type: 'stdio', command: 'playwright-mcp' },
    });
  });

  it('fails fast for structured team leader planning when session mcpServers are unsupported', () => {
    const step = createStep({ provider: 'cursor' });
    const builder = createBuilder(step, {
      provider: 'cursor',
      mcpServers: {
        docs: { type: 'stdio', command: 'docs-mcp' },
      },
    });

    expect(() => builder.resolveMcpServersForStep(step, 'cursor')).toThrow(
      /Provider "cursor" does not support session MCP servers for step "reviewers"/,
    );
  });

  it('fails fast when structured_output is used without a resolved provider', () => {
    const step = createStep({
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const builder = createBuilder(step, { provider: undefined });

    expect(() => builder.buildAgentOptions(step)).toThrow(
      /structured_output.*provider is not resolved/i,
    );
  });

  it('drops team leader part_allowed_tools silently for providers without tool-allowlist support', () => {
    const step = createStep();
    const builder = createBuilder(step, {
      provider: 'cursor',
      model: 'cursor-fast',
    });

    const options = builder.buildAgentOptions(step, {
      providerInfo: {
        provider: 'cursor',
        model: 'cursor-fast',
      },
      teamLeaderPart: {
        partAllowedTools: ['Read', 'Edit'],
      },
    });

    expect(options.allowedTools).toBeUndefined();
  });

  it('uses already resolved provider and model for capability checks', () => {
    const step = createStep({
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const builder = createBuilder(step, { provider: 'cursor', model: 'cursor-fast' });

    const options = builder.buildAgentOptions(step);

    expect(options.resolvedProvider).toBe('cursor');
    expect(options.resolvedModel).toBe('cursor-fast');
    expect(options.outputSchema).toBeUndefined();
  });

  it('keeps provider unresolved instead of re-reading config sources', () => {
    const step = createStep();
    const builder = createBuilder(step, { provider: undefined, model: undefined });

    const providerInfo = builder.resolveStepProviderModel(step);

    expect(providerInfo).toEqual({
      provider: undefined,
      model: undefined,
    });
  });

  it('centralizes team leader part providerOptions resolution for non-Claude providers', () => {
    const step = createStep({
      providerOptions: {
        opencode: { networkAccess: false },
        claude: {
          allowedTools: ['Read', 'Edit', 'Bash'],
          sandbox: { excludedCommands: ['./gradlew'] },
        },
      },
    });
    const builder = createBuilder(step, {
      providerOptions: {
        opencode: { networkAccess: true },
        claude: {
          sandbox: { allowUnsandboxedCommands: true },
        },
      },
    });

    const options = builder.buildAgentOptions(step, {
      providerInfo: {
        provider: 'opencode',
        model: 'opencode/zai-coding-plan/glm-5.1',
      },
      teamLeaderPart: {},
    });

    expect(options.providerOptions).toEqual({
      opencode: { networkAccess: false },
      claude: {
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['./gradlew'],
        },
      },
    });
    expect(options.allowedTools).toBeUndefined();
  });

  it('keeps merged claude allowedTools for Claude team leader parts when part_allowed_tools is omitted', () => {
    const step = createStep({
      providerOptions: {
        claude: {
          allowedTools: ['Read', 'Edit', 'Bash'],
        },
      },
    });
    const builder = createBuilder(step, {
      provider: 'claude',
      providerOptions: {
        claude: {
          sandbox: { allowUnsandboxedCommands: true },
        },
      },
    });

    const options = builder.buildAgentOptions(step, {
      providerInfo: {
        provider: 'claude',
        model: 'sonnet',
      },
      teamLeaderPart: {},
    });

    expect(options.providerOptions).toEqual({
      claude: {
        allowedTools: ['Read', 'Edit', 'Bash'],
        sandbox: { allowUnsandboxedCommands: true },
      },
    });
    expect(options.allowedTools).toEqual(['Read', 'Edit', 'Bash']);
  });
});
