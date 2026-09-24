import { describe, expect, it } from 'vitest';
import {
  normalizeProviderOptions,
  mergeProviderOptions,
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
    runtime_mode: 'exe' as const,
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
        runtimeMode: 'exe',
      },
    });
    expect(mergeProviderOptions(undefined, normalized)).toEqual(normalized);
    expect(denormalizeProviderOptions(normalized)).toEqual(deepseekYaml);
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
