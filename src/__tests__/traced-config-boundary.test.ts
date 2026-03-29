import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TracedValue } from 'traced-config';
import { applyLegacyEnvSpecs } from '../infra/config/traced/tracedConfigLegacyEnvAdapter.js';
import { loadTraceEntriesViaRuntime } from '../infra/config/traced/tracedConfigRuntimeBridge.js';

describe('traced config boundaries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TAKT_LOG_LEVEL;
    delete process.env.TAKT_LOGGING_LEVEL;
  });

  it('legacy env adapter applies only unblocked legacy overrides', () => {
    process.env.TAKT_LOG_LEVEL = 'debug';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rawConfig: Record<string, unknown> = {};
    const traceEntries = new Map<string, TracedValue<unknown>>();

    applyLegacyEnvSpecs(rawConfig, traceEntries, [{
      env: 'TAKT_LOG_LEVEL',
      path: 'logging.level',
      type: 'string',
      blockedBy: ['TAKT_LOGGING_LEVEL'],
      warning: 'deprecated',
    }]);

    expect(rawConfig).toEqual({ logging: { level: 'debug' } });
    expect(traceEntries.get('logging.level')?.origin).toBe('env');
    expect(warnSpy).toHaveBeenCalledWith('deprecated');
  });

  it('runtime bridge loads traced origins through isolated schema groups', () => {
    const traceEntries = loadTraceEntriesViaRuntime({
      'provider_options': {
        doc: 'provider_options',
        format: 'json',
        env: 'TAKT_PROVIDER_OPTIONS',
        sources: { local: true, global: false, env: false, cli: false },
      },
      'provider_options.codex.network_access': {
        doc: 'provider_options.codex.network_access',
        format: Boolean,
        env: 'TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS',
        sources: { local: true, global: false, env: true, cli: false },
      },
    }, 'local', {
      provider_options: {
        codex: {
          network_access: false,
        },
      },
    });

    expect(traceEntries.get('provider_options.codex.network_access')?.origin).toBe('local');
  });
});
