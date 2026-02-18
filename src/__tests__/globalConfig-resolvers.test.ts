/**
 * Tests for API key authentication feature
 *
 * Tests the resolution logic for Anthropic and OpenAI API keys:
 * - Environment variable priority over config.yaml
 * - Config.yaml fallback when env var is not set
 * - Undefined when neither is set
 * - Schema validation for API key fields
 * - GlobalConfig load/save round-trip with API keys
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { GlobalConfigSchema } from '../core/models/index.js';

// Mock paths module to redirect config to temp directory
const testId = randomUUID();
const testDir = join(tmpdir(), `takt-api-key-test-${testId}`);
const taktDir = join(testDir, '.takt');
const configPath = join(taktDir, 'config.yaml');

function createExecutableFile(filename: string): string {
  const filePath = join(testDir, filename);
  writeFileSync(filePath, '#!/bin/sh\necho codex\n', 'utf-8');
  chmodSync(filePath, 0o755);
  return filePath;
}

function createNonExecutableFile(filename: string): string {
  const filePath = join(testDir, filename);
  writeFileSync(filePath, '#!/bin/sh\necho codex\n', 'utf-8');
  chmodSync(filePath, 0o644);
  return filePath;
}

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getGlobalConfigPath: () => configPath,
    getTaktDir: () => taktDir,
  };
});

// Import after mocking
const { loadGlobalConfig, saveGlobalConfig, resolveAnthropicApiKey, resolveOpenaiApiKey, resolveCodexCliPath, resolveOpencodeApiKey, invalidateGlobalConfigCache } = await import('../infra/config/global/globalConfig.js');

describe('GlobalConfigSchema API key fields', () => {
  it('should accept config without API keys', () => {
    const result = GlobalConfigSchema.parse({
      language: 'en',
    });
    expect(result.anthropic_api_key).toBeUndefined();
    expect(result.openai_api_key).toBeUndefined();
  });

  it('should accept config with anthropic_api_key', () => {
    const result = GlobalConfigSchema.parse({
      language: 'en',
      anthropic_api_key: 'sk-ant-test-key',
    });
    expect(result.anthropic_api_key).toBe('sk-ant-test-key');
  });

  it('should accept config with openai_api_key', () => {
    const result = GlobalConfigSchema.parse({
      language: 'en',
      openai_api_key: 'sk-openai-test-key',
    });
    expect(result.openai_api_key).toBe('sk-openai-test-key');
  });

  it('should accept config with both API keys', () => {
    const result = GlobalConfigSchema.parse({
      language: 'en',
      anthropic_api_key: 'sk-ant-key',
      openai_api_key: 'sk-openai-key',
    });
    expect(result.anthropic_api_key).toBe('sk-ant-key');
    expect(result.openai_api_key).toBe('sk-openai-key');
  });
});

describe('GlobalConfig load/save with API keys', () => {
  beforeEach(() => {
    invalidateGlobalConfigCache();
    mkdirSync(taktDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load config with API keys from YAML', () => {
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: claude',
      'anthropic_api_key: sk-ant-from-yaml',
      'openai_api_key: sk-openai-from-yaml',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const config = loadGlobalConfig();
    expect(config.anthropicApiKey).toBe('sk-ant-from-yaml');
    expect(config.openaiApiKey).toBe('sk-openai-from-yaml');
  });

  it('should load config without API keys', () => {
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: claude',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const config = loadGlobalConfig();
    expect(config.anthropicApiKey).toBeUndefined();
    expect(config.openaiApiKey).toBeUndefined();
  });

  it('should save and reload config with API keys', () => {
    // Write initial config
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: claude',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const config = loadGlobalConfig();
    config.anthropicApiKey = 'sk-ant-saved';
    config.openaiApiKey = 'sk-openai-saved';
    saveGlobalConfig(config);

    const reloaded = loadGlobalConfig();
    expect(reloaded.anthropicApiKey).toBe('sk-ant-saved');
    expect(reloaded.openaiApiKey).toBe('sk-openai-saved');
  });

  it('should not persist API keys when not set', () => {
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: claude',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const config = loadGlobalConfig();
    saveGlobalConfig(config);

    const content = readFileSync(configPath, 'utf-8');
    expect(content).not.toContain('anthropic_api_key');
    expect(content).not.toContain('openai_api_key');
  });
});

describe('resolveAnthropicApiKey', () => {
  const originalEnv = process.env['TAKT_ANTHROPIC_API_KEY'];

  beforeEach(() => {
    invalidateGlobalConfigCache();
    mkdirSync(taktDir, { recursive: true });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['TAKT_ANTHROPIC_API_KEY'] = originalEnv;
    } else {
      delete process.env['TAKT_ANTHROPIC_API_KEY'];
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return env var when set', () => {
    process.env['TAKT_ANTHROPIC_API_KEY'] = 'sk-ant-from-env';
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: claude',
      'anthropic_api_key: sk-ant-from-yaml',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const key = resolveAnthropicApiKey();
    expect(key).toBe('sk-ant-from-env');
  });

  it('should fall back to config when env var is not set', () => {
    delete process.env['TAKT_ANTHROPIC_API_KEY'];
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: claude',
      'anthropic_api_key: sk-ant-from-yaml',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const key = resolveAnthropicApiKey();
    expect(key).toBe('sk-ant-from-yaml');
  });

  it('should return undefined when neither env var nor config is set', () => {
    delete process.env['TAKT_ANTHROPIC_API_KEY'];
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: claude',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const key = resolveAnthropicApiKey();
    expect(key).toBeUndefined();
  });

  it('should return undefined when config file does not exist', () => {
    delete process.env['TAKT_ANTHROPIC_API_KEY'];
    // No config file created
    rmSync(testDir, { recursive: true, force: true });

    const key = resolveAnthropicApiKey();
    expect(key).toBeUndefined();
  });
});

describe('resolveOpenaiApiKey', () => {
  const originalEnv = process.env['TAKT_OPENAI_API_KEY'];

  beforeEach(() => {
    invalidateGlobalConfigCache();
    mkdirSync(taktDir, { recursive: true });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['TAKT_OPENAI_API_KEY'] = originalEnv;
    } else {
      delete process.env['TAKT_OPENAI_API_KEY'];
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return env var when set', () => {
    process.env['TAKT_OPENAI_API_KEY'] = 'sk-openai-from-env';
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: claude',
      'openai_api_key: sk-openai-from-yaml',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const key = resolveOpenaiApiKey();
    expect(key).toBe('sk-openai-from-env');
  });

  it('should fall back to config when env var is not set', () => {
    delete process.env['TAKT_OPENAI_API_KEY'];
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: claude',
      'openai_api_key: sk-openai-from-yaml',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const key = resolveOpenaiApiKey();
    expect(key).toBe('sk-openai-from-yaml');
  });

  it('should return undefined when neither env var nor config is set', () => {
    delete process.env['TAKT_OPENAI_API_KEY'];
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: claude',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const key = resolveOpenaiApiKey();
    expect(key).toBeUndefined();
  });
});

describe('resolveCodexCliPath', () => {
  const originalEnv = process.env['TAKT_CODEX_CLI_PATH'];

  beforeEach(() => {
    invalidateGlobalConfigCache();
    mkdirSync(taktDir, { recursive: true });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['TAKT_CODEX_CLI_PATH'] = originalEnv;
    } else {
      delete process.env['TAKT_CODEX_CLI_PATH'];
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return env var path when set', () => {
    const envCodexPath = createExecutableFile('env-codex');
    const configCodexPath = createExecutableFile('config-codex');
    process.env['TAKT_CODEX_CLI_PATH'] = envCodexPath;
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: codex',
      `codex_cli_path: ${configCodexPath}`,
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const path = resolveCodexCliPath();
    expect(path).toBe(envCodexPath);
  });

  it('should fall back to config path when env var is not set', () => {
    delete process.env['TAKT_CODEX_CLI_PATH'];
    const configCodexPath = createExecutableFile('config-codex');
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: codex',
      `codex_cli_path: ${configCodexPath}`,
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const path = resolveCodexCliPath();
    expect(path).toBe(configCodexPath);
  });

  it('should return undefined when neither env var nor config is set', () => {
    delete process.env['TAKT_CODEX_CLI_PATH'];
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: codex',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const path = resolveCodexCliPath();
    expect(path).toBeUndefined();
  });

  it('should throw when env path is empty', () => {
    process.env['TAKT_CODEX_CLI_PATH'] = '';
    expect(() => resolveCodexCliPath()).toThrow(/must not be empty/i);
  });

  it('should throw when env path does not exist', () => {
    process.env['TAKT_CODEX_CLI_PATH'] = join(testDir, 'missing-codex');
    expect(() => resolveCodexCliPath()).toThrow(/does not exist/i);
  });

  it('should throw when env path points to a directory', () => {
    const dirPath = join(testDir, 'codex-dir');
    mkdirSync(dirPath, { recursive: true });
    process.env['TAKT_CODEX_CLI_PATH'] = dirPath;
    expect(() => resolveCodexCliPath()).toThrow(/executable file/i);
  });

  it('should throw when env path points to a non-executable file', () => {
    process.env['TAKT_CODEX_CLI_PATH'] = createNonExecutableFile('non-executable-codex');
    expect(() => resolveCodexCliPath()).toThrow(/not executable/i);
  });

  it('should throw when env path is relative', () => {
    process.env['TAKT_CODEX_CLI_PATH'] = 'bin/codex';
    expect(() => resolveCodexCliPath()).toThrow(/absolute path/i);
  });

  it('should throw when env path contains control characters', () => {
    process.env['TAKT_CODEX_CLI_PATH'] = '/tmp/codex\nbad';
    expect(() => resolveCodexCliPath()).toThrow(/control characters/i);
  });

  it('should throw when config path is invalid', () => {
    delete process.env['TAKT_CODEX_CLI_PATH'];
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: codex',
      `codex_cli_path: ${join(testDir, 'missing-codex-from-config')}`,
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    expect(() => resolveCodexCliPath()).toThrow(/does not exist/i);
  });
});

describe('resolveOpencodeApiKey', () => {
  const originalEnv = process.env['TAKT_OPENCODE_API_KEY'];

  beforeEach(() => {
    invalidateGlobalConfigCache();
    mkdirSync(taktDir, { recursive: true });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['TAKT_OPENCODE_API_KEY'] = originalEnv;
    } else {
      delete process.env['TAKT_OPENCODE_API_KEY'];
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return env var when set', () => {
    process.env['TAKT_OPENCODE_API_KEY'] = 'sk-opencode-from-env';
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: claude',
      'opencode_api_key: sk-opencode-from-yaml',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const key = resolveOpencodeApiKey();
    expect(key).toBe('sk-opencode-from-env');
  });

  it('should fall back to config when env var is not set', () => {
    delete process.env['TAKT_OPENCODE_API_KEY'];
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: claude',
      'opencode_api_key: sk-opencode-from-yaml',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const key = resolveOpencodeApiKey();
    expect(key).toBe('sk-opencode-from-yaml');
  });

  it('should return undefined when neither env var nor config is set', () => {
    delete process.env['TAKT_OPENCODE_API_KEY'];
    const yaml = [
      'language: en',
      'default_piece: default',
      'log_level: info',
      'provider: claude',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const key = resolveOpencodeApiKey();
    expect(key).toBeUndefined();
  });
});
