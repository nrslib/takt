import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import {
  resolveCompiledProviderEnvironment,
} from '../infra/config/runtime-provider/provider-environment.js';
import type { LegacyProviderEnvironmentInput } from '../infra/config/runtime-provider/environment.js';
import type { LegacyProviderSignal } from '../infra/config/runtime-provider/mode.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { RUNTIME_PROVIDER_FILENAME } from '../infra/config/runtime-provider/constants.js';

/**
 * Integration coverage for the composed provider-environment seam (issue #1136, T1):
 * loader → mode detection → environment compilation, driven through the real filesystem.
 * Asserts the active→runtime-v1 provider/model + persona/tag/step routing mapping, the legacy
 * passthrough, and the mixed-configuration fail-fast (location + migrateTo).
 */

const legacyInput: LegacyProviderEnvironmentInput = {
  provider: 'codex',
  providerSource: 'global',
  model: 'gpt-x',
  modelSource: 'global',
  personaProviders: undefined,
  providerRouting: undefined,
  autoRouting: undefined,
  providerOptions: undefined,
};

let projectCwd: string;

function writeGlobalRuntimeFile(content: unknown): void {
  writeFileSync(
    join(getGlobalConfigDir(), RUNTIME_PROVIDER_FILENAME),
    stringifyYaml(content),
  );
}

describe('resolveCompiledProviderEnvironment seam', () => {
  beforeEach(() => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-seam-project-'));
    mkdirSync(join(projectCwd, '.takt'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectCwd, { recursive: true, force: true });
  });

  it('maps an active runtime-v1 section to provider/model + routing with fail-fast tag policy', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default' },
          reviewer: { provider: 'opencode', model: 'qwen' },
          impl: { provider: 'cursor', model: 'cur-m' },
          tagp: { provider: 'claude', model: 'sonnet' },
        },
        targets: {
          personas: { coder: { profile: 'reviewer' } },
          tags: { 'high-stakes': { profile: 'tagp' } },
          steps: { 'wf/impl': { profile: 'impl' } },
        },
      },
    });

    const env = resolveCompiledProviderEnvironment({
      projectCwd,
      legacy: legacyInput,
      legacySignals: [],
    });

    expect(env.provider).toBe('codex');
    expect(env.model).toBe('gpt-default');
    expect(env.providerSource).toBe('runtime-v1');
    expect(env.modelSource).toBe('runtime-v1');
    expect(env.tagConflictPolicy).toBe('fail-fast');
    expect(env.personaProviders).toEqual({ coder: { provider: 'opencode', model: 'qwen' } });
    expect(env.providerRouting).toEqual({
      tags: { 'high-stakes': { provider: 'claude', model: 'sonnet' } },
      steps: { 'wf/impl': { provider: 'cursor', model: 'cur-m' } },
    });
  });

  it('passes legacy engine-options through unchanged when no runtime.yaml exists', () => {
    const env = resolveCompiledProviderEnvironment({
      projectCwd,
      legacy: legacyInput,
      legacySignals: [],
    });

    expect(env.provider).toBe('codex');
    expect(env.providerSource).toBe('global');
    expect(env.model).toBe('gpt-x');
    expect(env.tagConflictPolicy).toBe('last-wins');
  });

  it('treats an inactive version-only runtime.yaml as legacy', () => {
    writeGlobalRuntimeFile({ version: 1 });

    const env = resolveCompiledProviderEnvironment({
      projectCwd,
      legacy: legacyInput,
      legacySignals: [],
    });

    expect(env.providerSource).toBe('global');
    expect(env.tagConflictPolicy).toBe('last-wins');
  });

  it('re-applies a CLI provider override on a runtime-v1 environment, dropping runtime model/options', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default', options: { reasoning_effort: 'high' } },
        },
      },
    });

    const env = resolveCompiledProviderEnvironment({
      projectCwd,
      legacy: {
        ...legacyInput,
        provider: 'claude',
        providerSource: 'cli',
        model: undefined,
        modelSource: 'default',
      },
      legacySignals: [],
    });

    expect(env.provider).toBe('claude');
    expect(env.providerSource).toBe('cli');
    expect(env.model).toBeUndefined();
    expect(env.providerOptions).toBeUndefined();
  });

  it('re-applies a CLI provider+model override on a runtime-v1 environment', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'gpt-default' } },
      },
    });

    const env = resolveCompiledProviderEnvironment({
      projectCwd,
      legacy: {
        ...legacyInput,
        provider: 'claude',
        providerSource: 'cli',
        model: 'sonnet',
        modelSource: 'cli',
      },
      legacySignals: [],
    });

    expect(env.provider).toBe('claude');
    expect(env.providerSource).toBe('cli');
    expect(env.model).toBe('sonnet');
    expect(env.modelSource).toBe('cli');
  });

  it('keeps the runtime provider/options when only the model is overridden', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default', options: { reasoning_effort: 'high' } },
        },
      },
    });

    const env = resolveCompiledProviderEnvironment({
      projectCwd,
      legacy: {
        ...legacyInput,
        // provider not overridden (schema default), only model comes from the CLI.
        provider: 'claude',
        providerSource: 'default',
        model: 'my-model',
        modelSource: 'cli',
      },
      legacySignals: [],
    });

    expect(env.provider).toBe('codex');
    expect(env.providerSource).toBe('runtime-v1');
    expect(env.model).toBe('my-model');
    expect(env.modelSource).toBe('cli');
    expect(env.providerOptions).toEqual({ codex: { reasoningEffort: 'high' } });
  });

  it('leaves the runtime-v1 default untouched when provider/model are non-override sources', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'gpt-default' } },
      },
    });

    const env = resolveCompiledProviderEnvironment({
      projectCwd,
      legacy: {
        ...legacyInput,
        // A schema-injected default is not an override and must not replace the runtime provider.
        provider: 'claude',
        providerSource: 'default',
        model: 'sonnet',
        modelSource: 'default',
      },
      legacySignals: [],
    });

    expect(env.provider).toBe('codex');
    expect(env.providerSource).toBe('runtime-v1');
    expect(env.model).toBe('gpt-default');
    expect(env.modelSource).toBe('runtime-v1');
  });

  it('fails fast when an active runtime section coexists with legacy signals', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'gpt-default' } },
      },
    });

    const legacySignals: LegacyProviderSignal[] = [
      {
        setting: 'provider',
        location: 'config.yaml:provider (global)',
        migrateTo: 'provider.defaults + provider.profiles',
      },
    ];

    expect(() =>
      resolveCompiledProviderEnvironment({
        projectCwd,
        legacy: legacyInput,
        legacySignals,
      }),
    ).toThrow(/config\.yaml:provider \(global\).*provider\.defaults \+ provider\.profiles/s);
  });
});
