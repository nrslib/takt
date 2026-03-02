import { describe, expect, it } from 'vitest';
import { OptionsBuilder } from '../core/piece/engine/OptionsBuilder.js';
import type { PieceMovement } from '../core/models/types.js';
import type { PieceEngineOptions } from '../core/piece/types.js';

function createMovement(overrides: Partial<PieceMovement> = {}): PieceMovement {
  return {
    name: 'reviewers',
    personaDisplayName: 'Reviewers',
    instructionTemplate: 'review',
    passPreviousResponse: false,
    ...overrides,
  };
}

function createBuilder(step: PieceMovement, engineOverrides: Partial<PieceEngineOptions> = {}): OptionsBuilder {
  const engineOptions: PieceEngineOptions = {
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
    () => 'default',
    () => 'test piece',
  );
}

describe('OptionsBuilder.buildBaseOptions', () => {
  it('resolves permission mode using provider profiles', () => {
    const step = createMovement();
    const builder = createBuilder(step);

    const options = builder.buildBaseOptions(step);

    expect(options.permissionMode).toBe('full');
  });

  it('applies movement requiredPermissionMode as minimum floor', () => {
    const step = createMovement({ requiredPermissionMode: 'full' });
    const builder = createBuilder(step);

    const options = builder.buildBaseOptions(step);

    expect(options.permissionMode).toBe('full');
  });

  it('uses readonly when provider is not configured', () => {
    const step = createMovement();
    const builder = createBuilder(step, {
      provider: undefined,
      providerProfiles: undefined,
    });

    const options = builder.buildBaseOptions(step);
    expect(options.permissionMode).toBe('readonly');
  });

  it('merges provider options with precedence: global < movement < project', () => {
    const step = createMovement({
      providerOptions: {
        codex: { networkAccess: false },
        claude: { sandbox: { excludedCommands: ['./gradlew'] } },
      },
    });
    const builder = createBuilder(step, {
      providerOptionsSource: 'project',
      providerOptions: {
        codex: { networkAccess: true },
        claude: { sandbox: { allowUnsandboxedCommands: true } },
        opencode: { networkAccess: true },
      },
    });

    const options = builder.buildBaseOptions(step);

    expect(options.providerOptions).toEqual({
      codex: { networkAccess: true },
      opencode: { networkAccess: true },
      claude: {
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });

  it('falls back to global/project provider options when movement has none', () => {
    const step = createMovement();
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
});

describe('OptionsBuilder.resolveStepProviderModel', () => {
  it('should return engine-level provider and model when step has no overrides', () => {
    const step = createMovement();
    const builder = createBuilder(step, { provider: 'claude', model: 'sonnet' });

    const result = builder.resolveStepProviderModel(step);

    expect(result.provider).toBe('claude');
    expect(result.model).toBe('sonnet');
  });

  it('should prioritize persona providers over engine-level provider', () => {
    const step = createMovement({ personaDisplayName: 'coder' });
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
    const step = createMovement({ provider: 'opencode' as 'opencode' });
    const builder = createBuilder(step, { provider: 'claude' });

    const result = builder.resolveStepProviderModel(step);

    expect(result.provider).toBe('opencode');
  });

  it('should prioritize persona providers over step-level provider', () => {
    const step = createMovement({ personaDisplayName: 'coder', provider: 'claude' as 'claude' });
    const builder = createBuilder(step, {
      provider: 'mock',
      personaProviders: { coder: { provider: 'codex' } },
    });

    const result = builder.resolveStepProviderModel(step);

    expect(result.provider).toBe('codex');
  });

  it('should return undefined model when no model is configured', () => {
    const step = createMovement();
    const builder = createBuilder(step, { provider: 'claude', model: undefined });

    const result = builder.resolveStepProviderModel(step);

    expect(result.model).toBeUndefined();
  });

  it('should return undefined provider when no provider is configured', () => {
    const step = createMovement();
    const builder = createBuilder(step, { provider: undefined });

    const result = builder.resolveStepProviderModel(step);

    expect(result.provider).toBeUndefined();
  });

  it('should match buildBaseOptions stepProvider and stepModel', () => {
    const step = createMovement({ personaDisplayName: 'coder' });
    const builder = createBuilder(step, {
      provider: 'claude',
      model: 'sonnet',
      personaProviders: { coder: { provider: 'codex', model: 'o3-mini' } },
    });

    const providerInfo = builder.resolveStepProviderModel(step);
    const baseOptions = builder.buildBaseOptions(step);

    expect(providerInfo.provider).toBe(baseOptions.stepProvider);
    expect(providerInfo.model).toBe(baseOptions.stepModel);
  });
});

describe('OptionsBuilder.buildResumeOptions', () => {
  it('should enforce readonly permission and empty allowedTools for report/status phases', () => {
    // Given
    const step = createMovement({ requiredPermissionMode: 'full' });
    const builder = createBuilder(step);

    // When
    const options = builder.buildResumeOptions(step, 'session-123', { maxTurns: 3 });

    // Then
    expect(options.permissionMode).toBe('readonly');
    expect(options.allowedTools).toEqual([]);
    expect(options.maxTurns).toBe(3);
    expect(options.sessionId).toBe('session-123');
  });
});
