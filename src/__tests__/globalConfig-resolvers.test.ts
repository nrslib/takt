/**
 * Tests for API key authentication feature
 *
 * Tests the resolution logic for Anthropic/OpenAI/OpenCode/Cursor API keys:
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
const {
  loadGlobalConfig,
  saveGlobalConfig,
  resolveAnthropicApiKey,
  resolveOpenaiApiKey,
  resolveCodexCliPath,
  resolveClaudeCliPath,
  resolveCursorCliPath,
  resolveOpencodeApiKey,
  resolveCursorApiKey,
  validateCliPath,
  invalidateGlobalConfigCache,
} = await import('../infra/config/global/globalConfig.js');

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

  it('should accept config with cursor_api_key', () => {
    const result = GlobalConfigSchema.parse({
      language: 'en',
      cursor_api_key: 'cursor-key',
    });
    expect(result.cursor_api_key).toBe('cursor-key');
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
      'log_level: info',
      'provider: claude',
      'anthropic_api_key: sk-ant-from-yaml',
      'openai_api_key: sk-openai-from-yaml',
      'cursor_api_key: cursor-from-yaml',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const config = loadGlobalConfig();
    expect(config.anthropicApiKey).toBe('sk-ant-from-yaml');
    expect(config.openaiApiKey).toBe('sk-openai-from-yaml');
    expect(config.cursorApiKey).toBe('cursor-from-yaml');
  });

  it('should load config without API keys', () => {
    const yaml = [
      'language: en',
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
      'log_level: info',
      'provider: claude',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const config = loadGlobalConfig();
    config.anthropicApiKey = 'sk-ant-saved';
    config.openaiApiKey = 'sk-openai-saved';
    config.cursorApiKey = 'cursor-saved';
    saveGlobalConfig(config);

    const reloaded = loadGlobalConfig();
    expect(reloaded.anthropicApiKey).toBe('sk-ant-saved');
    expect(reloaded.openaiApiKey).toBe('sk-openai-saved');
    expect(reloaded.cursorApiKey).toBe('cursor-saved');
  });

  it('should not persist API keys when not set', () => {
    const yaml = [
      'language: en',
      'log_level: info',
      'provider: claude',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const config = loadGlobalConfig();
    saveGlobalConfig(config);

    const content = readFileSync(configPath, 'utf-8');
    expect(content).not.toContain('anthropic_api_key');
    expect(content).not.toContain('openai_api_key');
    expect(content).not.toContain('cursor_api_key');
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
      'log_level: info',
      'provider: claude',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const key = resolveOpencodeApiKey();
    expect(key).toBeUndefined();
  });
});

describe('resolveCursorApiKey', () => {
  const originalEnv = process.env['TAKT_CURSOR_API_KEY'];

  beforeEach(() => {
    invalidateGlobalConfigCache();
    mkdirSync(taktDir, { recursive: true });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['TAKT_CURSOR_API_KEY'] = originalEnv;
    } else {
      delete process.env['TAKT_CURSOR_API_KEY'];
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return env var when set', () => {
    process.env['TAKT_CURSOR_API_KEY'] = 'cursor-from-env';
    const yaml = [
      'language: en',
      'log_level: info',
      'provider: cursor',
      'cursor_api_key: cursor-from-yaml',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const key = resolveCursorApiKey();
    expect(key).toBe('cursor-from-env');
  });

  it('should fall back to config when env var is not set', () => {
    delete process.env['TAKT_CURSOR_API_KEY'];
    const yaml = [
      'language: en',
      'log_level: info',
      'provider: cursor',
      'cursor_api_key: cursor-from-yaml',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const key = resolveCursorApiKey();
    expect(key).toBe('cursor-from-yaml');
  });

  it('should return undefined when neither env var nor config is set', () => {
    delete process.env['TAKT_CURSOR_API_KEY'];
    const yaml = [
      'language: en',
      'log_level: info',
      'provider: cursor',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const key = resolveCursorApiKey();
    expect(key).toBeUndefined();
  });
});

// ============================================================
// Task 6.1 — validateCliPath unit tests
// ============================================================

describe('validateCliPath', () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return trimmed path for a valid executable', () => {
    const exePath = createExecutableFile('valid-cli');
    const result = validateCliPath(exePath, 'test_cli_path');
    expect(result).toBe(exePath);
  });

  it('should trim whitespace from the path', () => {
    const exePath = createExecutableFile('valid-cli');
    const result = validateCliPath(`  ${exePath}  `, 'test_cli_path');
    expect(result).toBe(exePath);
  });

  it('should throw when path is empty', () => {
    expect(() => validateCliPath('', 'test_cli_path')).toThrow(/must not be empty/i);
  });

  it('should throw when path is only whitespace', () => {
    expect(() => validateCliPath('   ', 'test_cli_path')).toThrow(/must not be empty/i);
  });

  it('should throw when path contains control characters', () => {
    expect(() => validateCliPath('/tmp/cli\nbad', 'test_cli_path')).toThrow(/control characters/i);
  });

  it('should throw when path is relative', () => {
    expect(() => validateCliPath('bin/cli', 'test_cli_path')).toThrow(/absolute path/i);
  });

  it('should throw when path does not exist', () => {
    expect(() => validateCliPath(join(testDir, 'missing'), 'test_cli_path')).toThrow(/does not exist/i);
  });

  it('should throw when path points to a directory', () => {
    const dirPath = join(testDir, 'a-dir');
    mkdirSync(dirPath, { recursive: true });
    expect(() => validateCliPath(dirPath, 'test_cli_path')).toThrow(/executable file/i);
  });

  it('should throw when path points to a non-executable file', () => {
    const filePath = createNonExecutableFile('non-exec');
    expect(() => validateCliPath(filePath, 'test_cli_path')).toThrow(/not executable/i);
  });

  it('should include source name in error messages', () => {
    expect(() => validateCliPath('', 'MY_CUSTOM_SOURCE')).toThrow(/MY_CUSTOM_SOURCE/);
  });
});

// ============================================================
// Task 6.2 — resolveClaudeCliPath / resolveCursorCliPath tests
// ============================================================

describe('resolveClaudeCliPath', () => {
  const originalEnv = process.env['TAKT_CLAUDE_CLI_PATH'];

  beforeEach(() => {
    invalidateGlobalConfigCache();
    mkdirSync(taktDir, { recursive: true });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['TAKT_CLAUDE_CLI_PATH'] = originalEnv;
    } else {
      delete process.env['TAKT_CLAUDE_CLI_PATH'];
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return env var path when set (highest priority)', () => {
    const envPath = createExecutableFile('env-claude');
    const configPath2 = createExecutableFile('config-claude');
    process.env['TAKT_CLAUDE_CLI_PATH'] = envPath;
    const yaml = [
      'language: en',
      'log_level: info',
      'provider: claude',
      `claude_cli_path: ${configPath2}`,
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const path = resolveClaudeCliPath();
    expect(path).toBe(envPath);
  });

  it('should use project config when env var is not set', () => {
    delete process.env['TAKT_CLAUDE_CLI_PATH'];
    const projPath = createExecutableFile('project-claude');

    const path = resolveClaudeCliPath({ claudeCliPath: projPath });
    expect(path).toBe(projPath);
  });

  it('should prefer project config over global config', () => {
    delete process.env['TAKT_CLAUDE_CLI_PATH'];
    const projPath = createExecutableFile('project-claude');
    const globalPath = createExecutableFile('global-claude');
    const yaml = [
      'language: en',
      'log_level: info',
      'provider: claude',
      `claude_cli_path: ${globalPath}`,
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const path = resolveClaudeCliPath({ claudeCliPath: projPath });
    expect(path).toBe(projPath);
  });

  it('should fall back to global config when neither env nor project is set', () => {
    delete process.env['TAKT_CLAUDE_CLI_PATH'];
    const globalPath = createExecutableFile('global-claude');
    const yaml = [
      'language: en',
      'log_level: info',
      'provider: claude',
      `claude_cli_path: ${globalPath}`,
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const path = resolveClaudeCliPath();
    expect(path).toBe(globalPath);
  });

  it('should return undefined when nothing is set', () => {
    delete process.env['TAKT_CLAUDE_CLI_PATH'];
    const yaml = [
      'language: en',
      'log_level: info',
      'provider: claude',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const path = resolveClaudeCliPath();
    expect(path).toBeUndefined();
  });

  it('should throw when env path is invalid', () => {
    process.env['TAKT_CLAUDE_CLI_PATH'] = join(testDir, 'missing-claude');
    expect(() => resolveClaudeCliPath()).toThrow(/does not exist/i);
  });
});

describe('resolveCursorCliPath', () => {
  const originalEnv = process.env['TAKT_CURSOR_CLI_PATH'];

  beforeEach(() => {
    invalidateGlobalConfigCache();
    mkdirSync(taktDir, { recursive: true });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['TAKT_CURSOR_CLI_PATH'] = originalEnv;
    } else {
      delete process.env['TAKT_CURSOR_CLI_PATH'];
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return env var path when set (highest priority)', () => {
    const envPath = createExecutableFile('env-cursor');
    const configPath2 = createExecutableFile('config-cursor');
    process.env['TAKT_CURSOR_CLI_PATH'] = envPath;
    const yaml = [
      'language: en',
      'log_level: info',
      'provider: cursor',
      `cursor_cli_path: ${configPath2}`,
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const path = resolveCursorCliPath();
    expect(path).toBe(envPath);
  });

  it('should use project config when env var is not set', () => {
    delete process.env['TAKT_CURSOR_CLI_PATH'];
    const projPath = createExecutableFile('project-cursor');

    const path = resolveCursorCliPath({ cursorCliPath: projPath });
    expect(path).toBe(projPath);
  });

  it('should prefer project config over global config', () => {
    delete process.env['TAKT_CURSOR_CLI_PATH'];
    const projPath = createExecutableFile('project-cursor');
    const globalPath = createExecutableFile('global-cursor');
    const yaml = [
      'language: en',
      'log_level: info',
      'provider: cursor',
      `cursor_cli_path: ${globalPath}`,
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const path = resolveCursorCliPath({ cursorCliPath: projPath });
    expect(path).toBe(projPath);
  });

  it('should fall back to global config when neither env nor project is set', () => {
    delete process.env['TAKT_CURSOR_CLI_PATH'];
    const globalPath = createExecutableFile('global-cursor');
    const yaml = [
      'language: en',
      'log_level: info',
      'provider: cursor',
      `cursor_cli_path: ${globalPath}`,
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const path = resolveCursorCliPath();
    expect(path).toBe(globalPath);
  });

  it('should return undefined when nothing is set', () => {
    delete process.env['TAKT_CURSOR_CLI_PATH'];
    const yaml = [
      'language: en',
      'log_level: info',
      'provider: cursor',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const path = resolveCursorCliPath();
    expect(path).toBeUndefined();
  });

  it('should throw when env path is invalid', () => {
    process.env['TAKT_CURSOR_CLI_PATH'] = join(testDir, 'missing-cursor');
    expect(() => resolveCursorCliPath()).toThrow(/does not exist/i);
  });
});

// ============================================================
// Task 6.3 — resolveCodexCliPath project config layer tests
// ============================================================

describe('resolveCodexCliPath — project config layer', () => {
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

  it('should use project config when env var is not set', () => {
    delete process.env['TAKT_CODEX_CLI_PATH'];
    const projPath = createExecutableFile('project-codex');

    const path = resolveCodexCliPath({ codexCliPath: projPath });
    expect(path).toBe(projPath);
  });

  it('should prefer env var over project config', () => {
    const envPath = createExecutableFile('env-codex');
    const projPath = createExecutableFile('project-codex');
    process.env['TAKT_CODEX_CLI_PATH'] = envPath;

    const path = resolveCodexCliPath({ codexCliPath: projPath });
    expect(path).toBe(envPath);
  });

  it('should prefer project config over global config', () => {
    delete process.env['TAKT_CODEX_CLI_PATH'];
    const projPath = createExecutableFile('project-codex');
    const globalPath = createExecutableFile('global-codex');
    const yaml = [
      'language: en',
      'log_level: info',
      'provider: codex',
      `codex_cli_path: ${globalPath}`,
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf-8');

    const path = resolveCodexCliPath({ codexCliPath: projPath });
    expect(path).toBe(projPath);
  });

  it('should throw when project config path is invalid', () => {
    delete process.env['TAKT_CODEX_CLI_PATH'];
    expect(() => resolveCodexCliPath({ codexCliPath: join(testDir, 'missing-codex') }))
      .toThrow(/does not exist/i);
  });
});
