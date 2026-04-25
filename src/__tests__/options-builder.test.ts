import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import type { WorkflowStep } from '../core/models/types.js';
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
};

function createProcessSafetyByStep(parentRunPid: number): WorkflowEngineOptions['phase1ProcessSafetyByStep'] {
  return {
    implement: { protectedParentRunPid: parentRunPid },
  };
}

function createBuilder(step: WorkflowStep, engineOverrides: BuilderEngineOverrides = {}): OptionsBuilder {
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

  it('should prioritize persona providers over step-level provider', () => {
    const step = createStep({ personaDisplayName: 'coder', provider: 'claude' as 'claude' });
    const builder = createBuilder(step, {
      provider: 'mock',
      personaProviders: { coder: { provider: 'codex' } },
    });

    const result = builder.resolveStepProviderModel(step);

    expect(result.provider).toBe('codex');
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

describe('OptionsBuilder.buildResumeOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should enforce readonly permission and empty allowedTools for report/status phases', () => {
    // Given
    const step = createStep({ requiredPermissionMode: 'full' });
    const builder = createBuilder(step);

    // When
    const options = builder.buildResumeOptions(step, 'session-123', { maxTurns: 3 });

    // Then
    expect(options.permissionMode).toBe('readonly');
    expect(options.allowedTools).toEqual([]);
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

  it('removes Write when output contracts exist and edit is not enabled', () => {
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
    expect(options.allowedTools).toEqual(['Read', 'Bash']);
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
