import { describe, expect, it } from 'vitest';
import {
  normalizeProviderOptions,
  mergeProviderOptions,
  assertAllowedNormalizedProviderBaseUrls,
} from '../infra/config/providerOptions.js';
import {
  buildRawTaktProvidersOrThrow,
  denormalizeProviderOptions,
} from '../infra/config/configNormalizers.js';
import { redactProviderOptions } from '../core/workflow/providerOptionsRedaction.js';
import { StepProviderOptionsObjectSchema } from '../core/models/schema-base.js';

const deepseekYaml = {
  deepseek_harness: {
    base_url: 'https://api.deepseek.example/v1',
    max_tokens: 4096,
    request_timeout_ms: 120_000,
    shutdown_timeout_ms: 2_000,
  },
};

describe('DeepSeek Harness provider options', () => {
  it('rejects legacy serialization instead of silently losing effort', () => {
    const providerOptions = { deepseekHarness: { reasoningEffort: 'high' as const } };
    expect(() => denormalizeProviderOptions(providerOptions)).toThrow(/reasoning_effort/iu);
    expect(() => buildRawTaktProvidersOrThrow({
      selector: { provider: 'deepseek-harness', model: 'deepseek-v4-flash', providerOptions },
    })).toThrow(/reasoning_effort/iu);
  });

  it('normalizes every documented YAML option and preserves it through merge', () => {
    const normalized = normalizeProviderOptions(deepseekYaml);

    expect(normalized).toEqual({
      deepseekHarness: {
        baseUrl: 'https://api.deepseek.example/v1',
        maxTokens: 4096,
        requestTimeoutMs: 120_000,
        shutdownTimeoutMs: 2_000,
      },
    });
    expect(mergeProviderOptions(undefined, normalized)).toEqual(normalized);
    expect(denormalizeProviderOptions(normalized)).toEqual(deepseekYaml);
  });

  it('normalizes, merges, and serializes Git plugin objects with their id and config', () => {
    const raw = {
      deepseek_harness: {
        plugins: [{
          id: 'acme-plugin',
          source: 'git:https://example.test/acme/plugin.git',
          ref: 'v1.2.3',
          config: { enabled: true, label: 'custom' },
        }],
      },
    };

    const normalized = normalizeProviderOptions(raw);
    expect(normalized).toEqual({
      deepseekHarness: {
        plugins: [{
          id: 'acme-plugin',
          source: 'git:https://example.test/acme/plugin.git',
          ref: 'v1.2.3',
          config: { enabled: true, label: 'custom' },
        }],
      },
    });
    expect(mergeProviderOptions(undefined, normalized)).toEqual(normalized);
    expect(denormalizeProviderOptions(normalized)).toEqual(raw);
  });

  it.each(['local', 'default'] as const)('rejects executable plugins from %s origin', (origin) => {
    const plugins = [{ id: 'unsafe', source: 'https://example.test/plugin.git', config: { token: 'SECRET' } }];
    const policy = { baseUrlTrust: 'local-loopback-only' as const, getOrigin: () => origin };
    expect(() => normalizeProviderOptions({ deepseek_harness: { plugins } }, policy))
      .toThrow('provider_options.deepseek_harness.plugins is not allowed');
    expect(() => assertAllowedNormalizedProviderBaseUrls({ deepseekHarness: { plugins } }, policy))
      .toThrow('provider_options.deepseek_harness.plugins is not allowed');
    expect(() => normalizeProviderOptions({ deepseek_harness: { plugins } }, { getOrigin: () => origin }))
      .toThrow('provider_options.deepseek_harness.plugins is not allowed');
  });

  it.each(['global', 'env', 'cli'] as const)('preserves plugins from trusted %s origin', (origin) => {
    const plugins = [{ id: 'trusted', source: 'https://example.test/plugin.git', config: { token: 'SECRET' } }];
    expect(normalizeProviderOptions({ deepseek_harness: { plugins } }, {
      baseUrlTrust: 'local-loopback-only', getOrigin: () => origin,
    })).toEqual({ deepseekHarness: { plugins } });
  });

  it('rejects workflow plugins but permits disabling them with an empty list', () => {
    const policy = { baseUrlTrust: 'loopback-only' as const, pathPrefix: 'profile.options' };
    expect(() => normalizeProviderOptions({ deepseek_harness: {
      plugins: [{ id: 'unsafe', source: 'https://example.test/plugin.git' }],
    } }, policy)).toThrow('profile.options.deepseek_harness.plugins is not allowed');
    expect(normalizeProviderOptions({ deepseek_harness: { plugins: [] } }, policy))
      .toEqual({ deepseekHarness: { plugins: [] } });
  });

  it('redacts a configured DeepSeek base URL without dropping runtime options', () => {
    expect(redactProviderOptions({
      deepseekHarness: {
        baseUrl: 'https://user:secret@example.test/v1',
        requestTimeoutMs: 1000,
      },
    })).toEqual({
      deepseekHarness: {
        baseUrl: '[configured]',
        requestTimeoutMs: 1000,
      },
    });
  });

  it('redacts plugin source credentials from provider option output', () => {
    const redacted = redactProviderOptions({
      deepseekHarness: {
        plugins: [{
          id: 'private-plugin',
          source: 'git:https://user:secret@example.test/plugin.git?access_token=token-value',
        }],
      },
    });

    expect(redacted?.deepseekHarness?.plugins?.[0]?.source)
      .toBe('git:https://[configured]@example.test/plugin.git?access_token=[configured]');

    const scpRedacted = redactProviderOptions({
      deepseekHarness: {
        plugins: [{
          id: 'private-plugin',
          source: 'git:private-user@example.test:team/plugin.git',
        }],
      },
    });
    expect(scpRedacted?.deepseekHarness?.plugins?.[0]?.source)
      .toBe('git:[configured]@example.test:team/plugin.git');
  });

  it('rejects unknown options and Node timer values above the supported maximum', () => {
    expect(() => StepProviderOptionsObjectSchema.parse({
      deepseek_harness: {
        request_timeout_ms: 2_147_483_648,
      },
    })).toThrow();
    expect(() => StepProviderOptionsObjectSchema.parse({
      deepseek_harness: {
        unsupported: true,
      },
    })).toThrow();
  });

  it('rejects reasoning_effort from legacy provider_options configuration', () => {
    expect(() => normalizeProviderOptions({
      deepseek_harness: {
        reasoning_effort: 'high',
      },
    })).toThrow(/reasoning_effort/iu);
  });

  it('rejects a non-loopback base URL from project/workflow origin', () => {
    expect(() => normalizeProviderOptions(deepseekYaml, {
      baseUrlTrust: 'local-loopback-only',
      pathPrefix: 'workflow.provider_options',
      getOrigin: () => 'local',
    })).toThrow('workflow.provider_options.deepseek_harness.base_url');
  });

  it('rejects the removed Python executable override in selector configuration', () => {
    expect(() => buildRawTaktProvidersOrThrow({
      selector: {
        provider: 'deepseek-harness',
        providerOptions: {
          deepseekHarness: { pythonPath: '/tmp/removed-python' },
        } as never,
      },
    })).toThrow(/pythonPath|python_path/);
  });

});
