/**
 * Tests for initGlobalDirs runtime.yaml generation wiring (issue #1136, T3).
 *
 * Covers the `isExistingEnvironment → hasLegacyProviderConfig` mapping and the fresh
 * non-interactive skip, plus the F1 regression: a fresh interactive setup must persist the
 * provider selection only to an active runtime.yaml and NOT to config.yaml, so the next
 * override-free run resolves runtime-v1 without a mixed-config throw.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const mockSelectOption = vi.fn();
const mockPromptInput = vi.fn();
vi.mock('../shared/prompt/index.js', () => ({
  selectOptionWithDefault: mockSelectOption,
  promptInput: mockPromptInput,
  confirm: vi.fn(),
}));

const { initGlobalDirs } = await import('../infra/config/global/initialization.js');
const { invalidateGlobalConfigCache } = await import('../infra/config/index.js');
const { getGlobalConfigDir, getGlobalConfigPath } = await import('../infra/config/paths.js');
const { RUNTIME_PROVIDER_FILENAME } = await import('../infra/config/runtime-provider/constants.js');
const { resolveRuntimeProviderFile } = await import('../infra/config/runtime-provider/loader.js');
const { determineProviderConfigMode, hasActiveProviderSection } = await import(
  '../infra/config/runtime-provider/mode.js'
);
const { compileRuntimeProviderEnvironment } = await import(
  '../infra/config/runtime-provider/environment.js'
);
const { validateProviderModelRequirements } = await import(
  '../core/workflow/provider-model-requirements.js'
);

function runtimeFilePath(): string {
  return join(getGlobalConfigDir(), RUNTIME_PROVIDER_FILENAME);
}

function loadGlobalRuntimeFile() {
  return resolveRuntimeProviderFile({
    globalConfigDir: getGlobalConfigDir(),
    projectConfigDir: join(getGlobalConfigDir(), 'no-project'),
  });
}

describe('initGlobalDirs runtime.yaml generation', () => {
  let stdinIsTTY: PropertyDescriptor | undefined;

  beforeEach(() => {
    // The global config manager is a process-wide singleton; clear its cache so this test
    // reads its own isolated config dir rather than a sibling test's cached config.
    invalidateGlobalConfigCache();
    mockSelectOption.mockReset();
    mockPromptInput.mockReset();
    stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  });

  afterEach(() => {
    if (stdinIsTTY) {
      Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
    } else {
      // No original descriptor: remove the property a test added so later tests don't
      // accidentally enter the interactive initialization branch.
      Reflect.deleteProperty(process.stdin, 'isTTY');
    }
  });

  it('generates an inactive version-only runtime.yaml for an existing environment (non-interactive)', async () => {
    // Existing environment: config.yaml already present.
    writeFileSync(getGlobalConfigPath(), 'language: en\n');

    await initGlobalDirs({ nonInteractive: true });

    expect(existsSync(runtimeFilePath())).toBe(true);
    const file = loadGlobalRuntimeFile();
    expect(file).toEqual({ version: 1 });
    expect(hasActiveProviderSection(file)).toBe(false);
  });

  it('skips runtime.yaml generation for a fresh non-interactive environment', async () => {
    await initGlobalDirs({ nonInteractive: true });

    expect(existsSync(runtimeFilePath())).toBe(false);
    expect(existsSync(getGlobalConfigPath())).toBe(false);
  });

  it('fresh interactive setup writes an active runtime.yaml and no provider in config.yaml (F1)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    // Prompts: language, provider, model.
    mockSelectOption
      .mockResolvedValueOnce('en')
      .mockResolvedValueOnce('codex')
      .mockResolvedValueOnce('gpt-5');

    await initGlobalDirs();

    // Active runtime.yaml carries the selected provider/model under profiles.default.
    const file = loadGlobalRuntimeFile();
    expect(hasActiveProviderSection(file)).toBe(true);
    expect(file?.provider?.defaults).toEqual({ profile: 'default' });
    expect(file?.provider?.profiles?.default?.provider).toBe('codex');
    expect(file?.provider?.profiles?.default?.model).toBe('gpt-5');

    // F1: config.yaml must NOT carry the provider (no legacy signal source).
    const persistedConfig = parseYaml(readFileSync(getGlobalConfigPath(), 'utf-8')) as {
      provider?: unknown;
      model?: unknown;
    };
    expect(persistedConfig.provider).toBeUndefined();
    expect(persistedConfig.model).toBeUndefined();

    // End state: active runtime + no legacy signal → runtime-v1, no mixed-config throw.
    expect(determineProviderConfigMode({ runtimeFile: file, legacyProviderSignals: [] }).mode)
      .toBe('runtime-v1');
  });

  it('fresh interactive setup with a non-Claude provider generates a provider-consistent model (C)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    // Prompts: language, provider (opencode), model (opencode/model form).
    mockSelectOption
      .mockResolvedValueOnce('en')
      .mockResolvedValueOnce('opencode')
      .mockResolvedValueOnce('opencode/big-pickle');

    await initGlobalDirs();

    const file = loadGlobalRuntimeFile();
    const profile = file?.provider?.profiles?.default;
    expect(profile?.provider).toBe('opencode');
    expect(profile?.model).toBe('opencode/big-pickle');

    // The generated profile must satisfy the selected provider's execution prerequisites: the
    // opencode default profile requires a `provider/model` model, and the old Claude-fixed
    // fallback ('sonnet') would throw here.
    expect(() => validateProviderModelRequirements(profile?.provider, profile?.model)).not.toThrow();
    expect(profile?.model).not.toBe('sonnet');

    // Compiling the active section (as the next run does) must not throw on the opencode profile.
    expect(() => compileRuntimeProviderEnvironment(file!.provider!)).not.toThrow();
    expect(determineProviderConfigMode({ runtimeFile: file, legacyProviderSignals: [] }).mode)
      .toBe('runtime-v1');
  });
});
