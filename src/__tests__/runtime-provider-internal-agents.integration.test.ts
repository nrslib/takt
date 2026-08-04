import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { resolveRuntimeInternalAgentProvider } from '../infra/config/runtime-provider/internal-agents.js';
import { resolveSelectorProviderForProject } from '../infra/config/selectorProviderResolution.js';
import { resolveAssistantProviderModel } from '../features/interactive/assistantConfig.js';
import { initializeSession } from '../features/interactive/sessionInitialization.js';
import {
  getGlobalConfigDir,
  getGlobalConfigPath,
  getProjectConfigDir,
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { RUNTIME_PROVIDER_FILENAME } from '../infra/config/runtime-provider/constants.js';

/**
 * Integration coverage for the internal-agent (selector/assistant) seams reading the runtime.yaml
 * `targets.internal_agents` ladder (issue #1136, Unit A). When an active runtime section exists:
 * - an explicit `internal_agents.<agent>` profile wins,
 * - an absent entry falls back to the `defaults` profile,
 * - and legacy mode (no active section) leaves resolution to `taktProviders`.
 */

let projectCwd: string;

function writeGlobalConfig(lines: string[]): void {
  writeFileSync(getGlobalConfigPath(), `${lines.join('\n')}\n`);
}

function writeGlobalRuntimeFile(content: unknown): void {
  writeFileSync(join(getGlobalConfigDir(), RUNTIME_PROVIDER_FILENAME), stringifyYaml(content));
}

function invalidate(): void {
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
}

describe('runtime.yaml internal_agents resolution', () => {
  beforeEach(() => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-internal-agents-project-'));
    mkdirSync(getProjectConfigDir(projectCwd), { recursive: true });
    writeGlobalConfig(['language: en']);
    invalidate();
  });

  afterEach(() => {
    rmSync(projectCwd, { recursive: true, force: true });
    invalidate();
  });

  it('resolves an explicit internal_agents.selector profile', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'opencode', model: 'qwen' },
          router: { provider: 'codex', model: 'gpt-router', options: { reasoning_effort: 'high' } },
        },
        targets: { internal_agents: { selector: { profile: 'router' } } },
      },
    });
    invalidate();

    expect(resolveRuntimeInternalAgentProvider(projectCwd, 'selector')).toEqual({
      provider: 'codex',
      model: 'gpt-router',
      providerOptions: { codex: { reasoningEffort: 'high' } },
    });

    const selector = resolveSelectorProviderForProject(projectCwd);
    expect(selector.provider).toBe('codex');
    expect(selector.model).toBe('gpt-router');
    expect(selector.providerSource).toBe('runtime-v1');
    expect(selector.providerOptions).toEqual({ codex: { reasoningEffort: 'high' } });
  });

  it('falls back to the defaults profile when internal_agents.assistant is absent', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'gpt-default' } },
      },
    });
    invalidate();

    expect(resolveRuntimeInternalAgentProvider(projectCwd, 'assistant')).toEqual({
      provider: 'codex',
      model: 'gpt-default',
    });
    expect(resolveAssistantProviderModel(projectCwd)).toEqual({
      runtimeManaged: true,
      provider: 'codex',
      model: 'gpt-default',
    });
  });

  it('resolves an explicit internal_agents.assistant profile over the defaults profile', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default' },
          helper: { provider: 'claude', model: 'sonnet' },
        },
        targets: { internal_agents: { assistant: { profile: 'helper' } } },
      },
    });
    invalidate();

    expect(resolveAssistantProviderModel(projectCwd)).toEqual({
      runtimeManaged: true,
      provider: 'claude',
      model: 'sonnet',
    });
  });

  it('returns undefined in legacy mode so taktProviders resolution stays in effect', () => {
    writeGlobalConfig([
      'language: en',
      'takt_providers:',
      '  selector:',
      '    provider: opencode',
      '    model: opencode/big-pickle',
    ]);
    invalidate();

    expect(resolveRuntimeInternalAgentProvider(projectCwd, 'selector')).toBeUndefined();

    const selector = resolveSelectorProviderForProject(projectCwd);
    expect(selector.provider).toBe('opencode');
    expect(selector.model).toBe('opencode/big-pickle');
    expect(selector.providerSource).toBe('global');
  });

  // Unit A: the assistant seam carries runtime profile options and drops them symmetrically with
  // the selector seam on a CLI provider override.
  it('carries the assistant profile options and drops them on a provider override', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default' },
          helper: { provider: 'codex', model: 'gpt-helper', options: { reasoning_effort: 'high' } },
        },
        targets: { internal_agents: { assistant: { profile: 'helper' } } },
      },
    });
    invalidate();

    expect(resolveAssistantProviderModel(projectCwd)).toEqual({
      runtimeManaged: true,
      provider: 'codex',
      model: 'gpt-helper',
      providerOptions: { codex: { reasoningEffort: 'high' } },
    });
    // A CLI provider override adopts the override and drops the runtime-tied model + options.
    expect(resolveAssistantProviderModel(projectCwd, { provider: 'claude' })).toEqual({
      runtimeManaged: true,
      provider: 'claude',
    });
    // A model-only override keeps the runtime provider and its options.
    expect(resolveAssistantProviderModel(projectCwd, { model: 'sonnet' })).toEqual({
      runtimeManaged: true,
      provider: 'codex',
      model: 'sonnet',
      providerOptions: { codex: { reasoningEffort: 'high' } },
    });
  });

  // Unit A: the runtime assistant options reach the interactive session context (the unit the
  // aiCaller consumes), and a CLI provider override drops them there too.
  it('flows the runtime assistant profile options into the session provider options', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default', options: { reasoning_effort: 'high' } },
        },
      },
    });
    invalidate();

    const ctx = initializeSession(projectCwd, 'interactive');
    expect(ctx.providerType).toBe('codex');
    expect(ctx.model).toBe('gpt-default');
    expect(ctx.providerOptions).toEqual({ codex: { reasoningEffort: 'high' } });

    const overridden = initializeSession(projectCwd, 'interactive', { provider: 'claude' });
    expect(overridden.providerType).toBe('claude');
    expect(overridden.providerOptions).toBeUndefined();
  });

  // Unit D: the selector seam adopts CLI/env provider overrides and drops the runtime model/options.
  it('adopts a CLI provider override and drops the runtime selector model/options', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default', options: { reasoning_effort: 'high' } },
        },
      },
    });
    invalidate();

    const selector = resolveSelectorProviderForProject(projectCwd, {
      provider: 'claude',
      providerSource: 'cli',
    });
    expect(selector.provider).toBe('claude');
    expect(selector.providerSource).toBe('cli');
    expect(selector.model).toBeUndefined();
    expect(selector.providerOptions).toBeUndefined();
  });

  it('treats an env-source provider as a selector override', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'gpt-default' } },
      },
    });
    const previous = process.env.TAKT_PROVIDER;
    process.env.TAKT_PROVIDER = 'claude';
    invalidate();
    try {
      const selector = resolveSelectorProviderForProject(projectCwd);
      expect(selector.provider).toBe('claude');
      expect(selector.providerSource).toBe('env');
      expect(selector.model).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.TAKT_PROVIDER;
      } else {
        process.env.TAKT_PROVIDER = previous;
      }
      invalidate();
    }
  });

  // Unit A: the assistant seam adopts an env-source provider override and drops the runtime
  // assistant model/options, symmetric with the selector env override above.
  it('treats an env-source provider as an assistant override and drops the runtime model/options', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default', options: { reasoning_effort: 'high' } },
        },
      },
    });
    const previous = process.env.TAKT_PROVIDER;
    process.env.TAKT_PROVIDER = 'claude';
    invalidate();
    try {
      expect(resolveAssistantProviderModel(projectCwd)).toEqual({
        runtimeManaged: true,
        provider: 'claude',
      });
    } finally {
      if (previous === undefined) {
        delete process.env.TAKT_PROVIDER;
      } else {
        process.env.TAKT_PROVIDER = previous;
      }
      invalidate();
    }
  });

  // Unit A: an env-source model-only override keeps the runtime assistant provider and its options.
  it('treats an env-source model as an assistant override that keeps the runtime provider/options', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default', options: { reasoning_effort: 'high' } },
        },
      },
    });
    const previous = process.env.TAKT_MODEL;
    process.env.TAKT_MODEL = 'gpt-env';
    invalidate();
    try {
      expect(resolveAssistantProviderModel(projectCwd)).toEqual({
        runtimeManaged: true,
        provider: 'codex',
        model: 'gpt-env',
        providerOptions: { codex: { reasoningEffort: 'high' } },
      });
    } finally {
      if (previous === undefined) {
        delete process.env.TAKT_MODEL;
      } else {
        process.env.TAKT_MODEL = previous;
      }
      invalidate();
    }
  });

  // Unit A: a CLI provider override wins over a coexisting env provider (cli > env > runtime).
  it('prefers a CLI assistant provider override over a coexisting env provider', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default', options: { reasoning_effort: 'high' } },
        },
      },
    });
    const previous = process.env.TAKT_PROVIDER;
    process.env.TAKT_PROVIDER = 'claude';
    invalidate();
    try {
      expect(resolveAssistantProviderModel(projectCwd, { provider: 'opencode' })).toEqual({
        runtimeManaged: true,
        provider: 'opencode',
      });
    } finally {
      if (previous === undefined) {
        delete process.env.TAKT_PROVIDER;
      } else {
        process.env.TAKT_PROVIDER = previous;
      }
      invalidate();
    }
  });

  // Unit A: the env assistant provider override reaches the interactive session context and drops
  // the runtime provider options there too (the unit the aiCaller consumes).
  it('flows an env assistant provider override into the session and drops the runtime options', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default', options: { reasoning_effort: 'high' } },
        },
      },
    });
    const previous = process.env.TAKT_PROVIDER;
    process.env.TAKT_PROVIDER = 'claude';
    invalidate();
    try {
      const ctx = initializeSession(projectCwd, 'interactive');
      expect(ctx.providerType).toBe('claude');
      expect(ctx.providerOptions).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.TAKT_PROVIDER;
      } else {
        process.env.TAKT_PROVIDER = previous;
      }
      invalidate();
    }
  });

  // Unit B: the selector/assistant seams consume the shared mixed-config gate and fail fast when a
  // legacy config.yaml provider coexists with an active runtime section.
  it('fails fast when an active runtime section coexists with a legacy config.yaml provider', () => {
    writeGlobalConfig(['language: en', 'provider: opencode', 'model: opencode/big-pickle']);
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'gpt-default' } },
      },
    });
    invalidate();

    expect(() => resolveRuntimeInternalAgentProvider(projectCwd, 'selector'))
      .toThrow(/config\.yaml:provider.*provider\.defaults \+ provider\.profiles/s);
    expect(() => resolveSelectorProviderForProject(projectCwd))
      .toThrow(/Mixed provider configuration/);
    expect(() => resolveAssistantProviderModel(projectCwd))
      .toThrow(/Mixed provider configuration/);
  });

  // Unit C: a config.yaml `takt_providers` provider indication is derived from the real config and
  // is itself a mixed-config signal (order.md #1136).
  it('fails fast when config.yaml takt_providers coexists with an active runtime section', () => {
    writeGlobalConfig([
      'language: en',
      'takt_providers:',
      '  selector:',
      '    provider: opencode',
      '    model: opencode/big-pickle',
    ]);
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'gpt-default' } },
      },
    });
    invalidate();

    expect(() => resolveRuntimeInternalAgentProvider(projectCwd, 'selector'))
      .toThrow(/config\.yaml:takt_providers.*provider\.targets\.internal_agents/s);
  });
});
