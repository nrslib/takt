import { describe, expect, it } from 'vitest';
import type { StepProviderOptions } from '../core/models/index.js';
import {
  buildRawTaktProvidersOrThrow,
  denormalizeProviderOptions,
} from '../infra/config/configNormalizers.js';
import {
  mergeProviderOptions,
  normalizeProviderOptions,
  PROVIDER_OPTION_PATHS,
  resolveEffectiveProviderOptions,
} from '../infra/config/providerOptions.js';

function asProviderOptions(value: unknown): StepProviderOptions {
  return value as StepProviderOptions;
}

describe('claude_terminal provider_options normalization', () => {
  it('Given snake_case claude_terminal options, When normalizeProviderOptions, Then camelCase options are returned', () => {
    const normalized = normalizeProviderOptions({
      claude_terminal: {
        backend: 'tmux',
        timeout_ms: 900000,
        keep_session: false,
        transcript_poll_interval_ms: 500,
      },
    });

    expect(normalized).toEqual({
      claudeTerminal: {
        backend: 'tmux',
        timeoutMs: 900000,
        keepSession: false,
        transcriptPollIntervalMs: 500,
      },
    });
  });

  it('Given camelCase claudeTerminal options, When denormalizeProviderOptions, Then snake_case options are persisted', () => {
    const denormalized = denormalizeProviderOptions(asProviderOptions({
      claudeTerminal: {
        backend: 'tmux',
        timeoutMs: 900000,
        keepSession: false,
        transcriptPollIntervalMs: 500,
      },
    }));

    expect(denormalized).toEqual({
      claude_terminal: {
        backend: 'tmux',
        timeout_ms: 900000,
        keep_session: false,
        transcript_poll_interval_ms: 500,
      },
    });
  });

  it('Given claudeTerminal options in multiple layers, When mergeProviderOptions, Then later sources override only specified fields', () => {
    const merged = mergeProviderOptions(
      asProviderOptions({
        claudeTerminal: {
          backend: 'tmux',
          timeoutMs: 900000,
          keepSession: true,
          transcriptPollIntervalMs: 1000,
        },
      }),
      asProviderOptions({
        claudeTerminal: {
          timeoutMs: 300000,
          keepSession: false,
        },
      }),
    );

    expect(merged).toEqual({
      claudeTerminal: {
        backend: 'tmux',
        timeoutMs: 300000,
        keepSession: false,
        transcriptPollIntervalMs: 1000,
      },
    });
  });

  it('Given config, persona, and step claudeTerminal options, When resolving effective options, Then source precedence is preserved', () => {
    const resolved = resolveEffectiveProviderOptions(
      'project',
      undefined,
      asProviderOptions({
        claudeTerminal: {
          backend: 'tmux',
          timeoutMs: 900000,
          keepSession: true,
        },
      }),
      asProviderOptions({
        claudeTerminal: {
          keepSession: false,
        },
      }),
      asProviderOptions({
        claudeTerminal: {
          transcriptPollIntervalMs: 500,
        },
      }),
    );

    expect(resolved).toEqual({
      claudeTerminal: {
        backend: 'tmux',
        timeoutMs: 900000,
        keepSession: false,
        transcriptPollIntervalMs: 500,
      },
    });
  });

  it('Given provider option trace paths, When listing paths, Then claudeTerminal leaves are included', () => {
    expect(PROVIDER_OPTION_PATHS).toEqual(expect.arrayContaining([
      'claudeTerminal.backend',
      'claudeTerminal.timeoutMs',
      'claudeTerminal.keepSession',
      'claudeTerminal.transcriptPollIntervalMs',
    ]));
  });

  it('Given takt_providers assistant uses claude-terminal, When raw config is built, Then provider id is preserved', () => {
    const raw = buildRawTaktProvidersOrThrow({
      assistant: {
        provider: 'claude-terminal',
        model: 'opus',
      },
    });

    expect(raw).toEqual({
      assistant: {
        provider: 'claude-terminal',
        model: 'opus',
      },
    });
  });
});
