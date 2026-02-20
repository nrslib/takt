import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GlobalConfigManager, loadGlobalConfig } from '../infra/config/global/globalConfig.js';

describe('Assistant Config', () => {
  const testDir = join(tmpdir(), 'takt-test-assistant-config');

  beforeEach(() => {
    GlobalConfigManager.resetInstance();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });
    vi.stubEnv('TAKT_CONFIG_DIR', testDir);
  });

  afterEach(() => {
    GlobalConfigManager.resetInstance();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    vi.unstubAllEnvs();
  });

  it('should parse assistant config from yaml', () => {
    const configPath = join(testDir, 'config.yaml');
    writeFileSync(configPath, `
assistant:
  provider: claude
  model: claude-opus-4-5
`);

    const config = loadGlobalConfig();
    expect(config.assistant).toBeDefined();
    expect(config.assistant?.provider).toBe('claude');
    expect(config.assistant?.model).toBe('claude-opus-4-5');
  });

  it('should parse init_files from yaml', () => {
    const configPath = join(testDir, 'config.yaml');
    writeFileSync(configPath, `
assistant:
  init_files:
    - docs/MY_PERSONA.md
    - CUSTOM_INSTRUCTIONS.txt
`);

    const config = loadGlobalConfig();
    expect(config.assistant).toBeDefined();
    expect(config.assistant?.initFiles).toEqual(['docs/MY_PERSONA.md', 'CUSTOM_INSTRUCTIONS.txt']);
  });

  it('should return undefined when assistant config is not set', () => {
    const configPath = join(testDir, 'config.yaml');
    writeFileSync(configPath, `
provider: claude
`);

    const config = loadGlobalConfig();
    expect(config.assistant).toBeUndefined();
  });

  it('should validate provider/model compatibility for assistant config', () => {
    const configPath = join(testDir, 'config.yaml');
    writeFileSync(configPath, `
assistant:
  provider: opencode
  model: opus
`);

    expect(() => loadGlobalConfig()).toThrow();
  });
});
