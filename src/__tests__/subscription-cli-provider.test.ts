import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../infra/providers/index.js';
import { SubscriptionCliProvider } from '../infra/providers/subscription-cli.js';
import {
  buildSubscriptionCliInvocation,
  buildSubscriptionOnlyEnv,
  callSubscriptionCli,
} from '../infra/subscription-cli/client.js';
import { ProviderTypeSchema } from '../core/models/schema-base.js';
import { isProviderType } from '../shared/types/provider.js';

describe('subscription-only CLI providers', () => {
  it('accepts explicit CLI-only provider names in shared provider type guards and schemas', () => {
    for (const provider of ['codex-cli', 'opencode-cli', 'cursor-cli', 'agy-cli']) {
      expect(isProviderType(provider)).toBe(true);
      expect(ProviderTypeSchema.parse(provider)).toBe(provider);
    }
  });

  it('registers CLI-only providers separately from SDK/API providers', () => {
    ProviderRegistry.resetInstance();
    const registry = ProviderRegistry.getInstance();

    expect(registry.get('codex-cli')).toBeInstanceOf(SubscriptionCliProvider);
    expect(registry.get('opencode-cli')).toBeInstanceOf(SubscriptionCliProvider);
    expect(registry.get('cursor-cli')).toBeInstanceOf(SubscriptionCliProvider);
    expect(registry.get('agy-cli')).toBeInstanceOf(SubscriptionCliProvider);
  });

  it('removes API-key billing environment variables even when inherited or injected', () => {
    const env = buildSubscriptionOnlyEnv(
      {
        PATH: '/bin',
        OPENAI_API_KEY: 'sk-openai',
        TAKT_OPENAI_API_KEY: 'sk-takt-openai',
        ANTHROPIC_API_KEY: 'sk-ant',
        CURSOR_API_KEY: 'cursor-key',
        SAFE_VALUE: 'kept',
      },
      {
        GOOGLE_API_KEY: 'google-key',
        TAKT_OPENCODE_API_KEY: 'opencode-key',
        TAKT_OBSERVABILITY: '{"enabled":true}',
      },
    );

    expect(env.PATH).toBe('/bin');
    expect(env.SAFE_VALUE).toBe('kept');
    expect(env.TAKT_OBSERVABILITY).toBe('{"enabled":true}');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.TAKT_OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.TAKT_OPENCODE_API_KEY).toBeUndefined();
  });

  it('builds a Codex CLI invocation without API-provider fallback or dangerous bypass flags', () => {
    const invocation = buildSubscriptionCliInvocation('codex-cli', 'Review this diff', {
      cwd: '/repo',
      model: 'gpt-5',
      permissionMode: 'readonly',
      commandPath: '/usr/local/bin/codex',
      outputPath: '/tmp/takt-codex-last-message.txt',
    });

    expect(invocation.command).toBe('/usr/local/bin/codex');
    expect(invocation.args).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--cd',
      '/repo',
      '--model',
      'gpt-5',
      '--output-last-message',
      '/tmp/takt-codex-last-message.txt',
      '-',
    ]);
    expect(invocation.args.join(' ')).not.toContain('dangerously-bypass');
    expect(invocation.stdin).toBe('Review this diff');
  });

  it('rejects Codex CLI full permission mode because it would disable local sandboxing', () => {
    expect(() =>
      buildSubscriptionCliInvocation('codex-cli', 'Do the task', {
        cwd: '/repo',
        permissionMode: 'full',
      })
    ).toThrow(/does not support full permission/i);
  });

  it('returns an agent error when invocation validation fails before spawn', async () => {
    const response = await callSubscriptionCli('coder', 'Do the task', {
      provider: 'codex-cli',
      cwd: '/repo',
      permissionMode: 'full',
      commandPath: '/mock/bin/codex',
    });

    expect(response.status).toBe('error');
    expect(response.error).toMatch(/does not support full permission/i);
  });
});
