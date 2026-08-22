import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizeProviderOptions,
  mergeProviderOptions,
  resolveTrustedDeepSeekHarnessPaths,
} from '../infra/config/providerOptions.js';
import { denormalizeProviderOptions } from '../infra/config/configNormalizers.js';
import { redactProviderOptions } from '../core/workflow/providerOptionsRedaction.js';
import { StepProviderOptionsObjectSchema } from '../core/models/schema-base.js';

const deepseekYaml = {
  deepseek_harness: {
    python_path: '/opt/python/bin/python3',
    base_url: 'https://api.deepseek.example/v1',
    session_root: '.takt/deepseek-sessions',
    cordis: '.takt/cordis.yml',
    max_tokens: 4096,
    request_timeout_ms: 120_000,
    shutdown_timeout_ms: 2_000,
    runtime_mode: 'exe' as const,
  },
};

describe('DeepSeek Harness provider options', () => {
  it('normalizes every documented YAML option and preserves it through merge', () => {
    const normalized = normalizeProviderOptions(deepseekYaml);

    expect(normalized).toEqual({
      deepseekHarness: {
        pythonPath: '/opt/python/bin/python3',
        baseUrl: 'https://api.deepseek.example/v1',
        sessionRoot: '.takt/deepseek-sessions',
        cordis: '.takt/cordis.yml',
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
        pythonPath: '/usr/bin/python3',
        requestTimeoutMs: 1000,
      },
    })).toEqual({
      deepseekHarness: {
        baseUrl: '[configured]',
        pythonPath: '/usr/bin/python3',
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

  it('rejects a non-loopback base URL from project/workflow origin', () => {
    expect(() => normalizeProviderOptions(deepseekYaml, {
      baseUrlTrust: 'local-loopback-only',
      pathPrefix: 'workflow.provider_options',
      getOrigin: () => 'local',
    })).toThrow('workflow.provider_options.deepseek_harness.base_url');
  });

  it('rejects a Python executable override from project/workflow origin', () => {
    expect(() => normalizeProviderOptions({
      deepseek_harness: { python_path: '/tmp/untrusted-python' },
    }, {
      pythonPathTrust: 'untrusted',
      pathPrefix: 'workflow.provider_options',
    })).toThrow('workflow.provider_options.deepseek_harness.python_path');
  });

  it('allows a user-controlled environment Python executable override', () => {
    expect(normalizeProviderOptions({
      deepseek_harness: { python_path: '/opt/user-python' },
    }, {
      pythonPathTrust: 'local-untrusted',
      getOrigin: () => 'env',
    })).toEqual({
      deepseekHarness: { pythonPath: '/opt/user-python' },
    });
  });

  it('rejects absolute and traversing session roots from project or workflow config', () => {
    for (const sessionRoot of [
      '/tmp/shared-sessions',
      ' /tmp/shared-sessions',
      '../shared-sessions',
      ' ../shared-sessions',
      '..\\\\shared-sessions',
      'C:\\\\shared-sessions',
    ]) {
      expect(() => normalizeProviderOptions({
        deepseek_harness: { session_root: sessionRoot },
      }, {
        pathTrust: 'untrusted',
        pathPrefix: 'workflow.provider_options',
      })).toThrow('project/session boundary');
    }
  });

  it('rejects Cordis selection from project or workflow config', () => {
    expect(() => normalizeProviderOptions({
      deepseek_harness: { cordis: '.takt/cordis.yml' },
    }, {
      pathTrust: 'untrusted',
      cordisTrust: 'untrusted',
      pathPrefix: 'workflow.provider_options',
    })).toThrow('trusted user configuration');
  });

  it('allows a user-controlled environment Cordis override through an untrusted project layer', () => {
    expect(normalizeProviderOptions({
      deepseek_harness: { cordis: '/opt/user-cordis.yml' },
    }, {
      cordisTrust: 'untrusted',
      pathPrefix: 'provider_options',
      getOrigin: () => 'env',
    })).toEqual({
      deepseekHarness: { cordis: '/opt/user-cordis.yml' },
    });
  });

  it('allows trusted environment overrides for session root and Cordis paths', () => {
    expect(normalizeProviderOptions({
      deepseek_harness: {
        session_root: '/tmp/user-deepseek-sessions',
        cordis: '/tmp/user-cordis.yml',
      },
    }, {
      pathTrust: 'local-untrusted',
      cordisTrust: 'local-untrusted',
      getOrigin: () => 'env',
    })).toEqual({
      deepseekHarness: {
        sessionRoot: '/tmp/user-deepseek-sessions',
        cordis: '/tmp/user-cordis.yml',
      },
    });
  });

  it('resolves trusted relative global and environment paths from the execution directory', () => {
    const resolved = resolveTrustedDeepSeekHarnessPaths({
      deepseekHarness: {
        sessionRoot: '../shared-sessions',
        cordis: 'config/cordis.yml',
      },
    }, '/project/worktree', {
      'deepseekHarness.sessionRoot': 'global',
      'deepseekHarness.cordis': 'env',
    });

    expect(resolved).toEqual({
      deepseekHarness: {
        sessionRoot: path.resolve('/project/worktree', '../shared-sessions'),
        cordis: path.resolve('/project/worktree', 'config/cordis.yml'),
      },
    });
  });

  it('preserves absolute trusted global session and Cordis paths', () => {
    expect(normalizeProviderOptions({
      deepseek_harness: {
        session_root: '/var/lib/takt/deepseek-sessions',
        cordis: '/etc/takt/cordis.yml',
      },
    })).toEqual({
      deepseekHarness: {
        sessionRoot: '/var/lib/takt/deepseek-sessions',
        cordis: '/etc/takt/cordis.yml',
      },
    });
  });
});
