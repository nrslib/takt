import { describe, expect, it } from 'vitest';
import {
  resolveEffectiveProviderOptions,
  resolveEffectiveTeamLeaderPartProviderOptions,
} from '../infra/config/providerOptions.js';
import * as providerOptionsModule from '../infra/config/providerOptions.js';

describe('resolveEffectiveProviderOptions', () => {
  it('env origin keeps config value only for overridden leaf', () => {
    const result = resolveEffectiveProviderOptions(
      'project',
      (path: string) => (path === 'codex.networkAccess' ? 'env' : 'local'),
      {
        codex: { networkAccess: true },
        claude: { allowedTools: ['Read', 'Glob'] },
      },
      {
        codex: { networkAccess: false },
        claude: { allowedTools: ['Read', 'Edit'] },
      },
    );

    expect(result).toEqual({
      codex: { networkAccess: true },
      claude: { allowedTools: ['Read', 'Edit'] },
    });
  });

  it('falls back to step precedence for local/global sources', () => {
    const result = resolveEffectiveProviderOptions(
      'global',
      undefined,
      { claude: { sandbox: { allowUnsandboxedCommands: true } } },
      { claude: { sandbox: { excludedCommands: ['./gradlew'] } } },
    );

    expect(result).toEqual({
      claude: {
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });

  it('env origin は codex.reasoningEffort と claude.effort にも適用される', () => {
    const result = resolveEffectiveProviderOptions(
      'project',
      (path: string) => {
        if (path === 'codex.reasoningEffort' || path === 'claude.effort') {
          return 'env';
        }
        return 'local';
      },
      {
        codex: { reasoningEffort: 'high' },
        claude: { effort: 'medium' },
      },
      {
        codex: { reasoningEffort: 'low' },
        claude: { effort: 'low' },
      },
    );

    expect(result).toEqual({
      codex: { reasoningEffort: 'high' },
      claude: { effort: 'medium' },
    });
  });

  it('空 sandbox object は step の leaf を潰さない', () => {
    const result = resolveEffectiveProviderOptions(
      'project',
      (path: string) => (path === 'claude.sandbox' ? 'env' : 'local'),
      {
        claude: { sandbox: {} },
      },
      {
        claude: { sandbox: { excludedCommands: ['./gradlew'] } },
      },
    );

    expect(result).toEqual({
      claude: {
        sandbox: {
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });
});

describe('resolveEffectiveTeamLeaderPartProviderOptions', () => {
  it('part helper を module export に公開しない', () => {
    expect(providerOptionsModule).not.toHaveProperty('stripClaudeAllowedTools');
  });

  it('non-Claude part では claude.allowedTools を除去しつつ他の providerOptions は維持する', () => {
    const result = resolveEffectiveTeamLeaderPartProviderOptions(
      'project',
      undefined,
      {
        opencode: { networkAccess: true },
        claude: {
          allowedTools: ['Read', 'Glob'],
          sandbox: { allowUnsandboxedCommands: true },
        },
      },
      {
        opencode: { networkAccess: false },
        claude: {
          allowedTools: ['Read', 'Edit'],
          sandbox: { excludedCommands: ['./gradlew'] },
        },
      },
      'opencode',
      undefined,
    );

    expect(result).toEqual({
      opencode: { networkAccess: false },
      claude: {
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });

  it('Claude part で part_allowed_tools 未指定なら merged claude.allowedTools を維持する', () => {
    const result = resolveEffectiveTeamLeaderPartProviderOptions(
      'project',
      undefined,
      {
        claude: {
          allowedTools: ['Read', 'Glob'],
          sandbox: { allowUnsandboxedCommands: true },
        },
      },
      {
        claude: {
          allowedTools: ['Read', 'Edit'],
        },
      },
      'claude',
      undefined,
    );

    expect(result).toEqual({
      claude: {
        allowedTools: ['Read', 'Edit'],
        sandbox: { allowUnsandboxedCommands: true },
      },
    });
  });

  it('part_allowed_tools を runtime で渡す場合は Claude part でも claude.allowedTools を除去する', () => {
    const result = resolveEffectiveTeamLeaderPartProviderOptions(
      'project',
      undefined,
      {
        claude: {
          allowedTools: ['Read', 'Glob'],
          sandbox: { allowUnsandboxedCommands: true },
        },
      },
      {
        claude: {
          allowedTools: ['Read', 'Edit'],
          sandbox: { excludedCommands: ['./gradlew'] },
        },
      },
      'claude',
      ['Read', 'Edit', 'Write'],
    );

    expect(result).toEqual({
      claude: {
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });
});
