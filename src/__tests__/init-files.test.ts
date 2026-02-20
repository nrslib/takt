import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GlobalConfigManager, loadGlobalConfig } from '../infra/config/global/globalConfig.js';
import { loadInitialFiles } from '../features/interactive/conversationLoop.js';

describe('loadInitialFiles', () => {
  const testDir = join(tmpdir(), 'takt-test-init-files');

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

  it('should load default init files (CLAUDE.md, AGENT.md, TAKT.md)', () => {
    writeFileSync(join(testDir, 'config.yaml'), 'provider: claude');
    writeFileSync(join(testDir, 'CLAUDE.md'), '# CLAUDE.md content');
    writeFileSync(join(testDir, 'AGENT.md'), '# AGENT.md content');
    writeFileSync(join(testDir, 'TAKT.md'), '# TAKT.md content');

    const globalConfig = loadGlobalConfig();
    expect(globalConfig.assistant).toBeUndefined();

    const initFiles = globalConfig.assistant?.initFiles;
    expect(initFiles).toBeUndefined();
  });

  it('should load custom init_files when configured', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
assistant:
  init_files:
    - docs/MY_PERSONA.md
    - CUSTOM_INSTRUCTIONS.txt
`);
    mkdirSync(join(testDir, 'docs'), { recursive: true });
    writeFileSync(join(testDir, 'docs', 'MY_PERSONA.md'), '# My Persona');
    writeFileSync(join(testDir, 'CUSTOM_INSTRUCTIONS.txt'), 'Custom instructions');

    const globalConfig = loadGlobalConfig();
    expect(globalConfig.assistant?.initFiles).toEqual(['docs/MY_PERSONA.md', 'CUSTOM_INSTRUCTIONS.txt']);
  });

  it('should return empty when no init files exist', () => {
    writeFileSync(join(testDir, 'config.yaml'), 'provider: claude');

    const globalConfig = loadGlobalConfig();
    expect(globalConfig.assistant?.initFiles).toBeUndefined();
  });

  it('should load default init files from project root', () => {
    writeFileSync(join(testDir, 'config.yaml'), 'provider: claude');
    writeFileSync(join(testDir, 'CLAUDE.md'), '# CLAUDE.md content');
    writeFileSync(join(testDir, 'AGENT.md'), '# AGENT.md content');
    writeFileSync(join(testDir, 'TAKT.md'), '# TAKT.md content');

    const content = loadInitialFiles(testDir);

    expect(content).toContain('# CLAUDE.md content');
    expect(content).toContain('# AGENT.md content');
    expect(content).toContain('# TAKT.md content');
    expect(content).toContain('## CLAUDE.md');
    expect(content).toContain('## AGENT.md');
    expect(content).toContain('## TAKT.md');
  });

  it('should load custom init_files from config when configured', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
assistant:
  init_files:
    - docs/MY_PERSONA.md
    - CUSTOM_INSTRUCTIONS.txt
`);
    mkdirSync(join(testDir, 'docs'), { recursive: true });
    writeFileSync(join(testDir, 'docs', 'MY_PERSONA.md'), '# My Persona');
    writeFileSync(join(testDir, 'CUSTOM_INSTRUCTIONS.txt'), 'Custom instructions');

    const content = loadInitialFiles(testDir);

    expect(content).toContain('# My Persona');
    expect(content).toContain('Custom instructions');
    expect(content).toContain('## docs/MY_PERSONA.md');
    expect(content).toContain('## CUSTOM_INSTRUCTIONS.txt');
  });

  it('should skip non-existent files', () => {
    writeFileSync(join(testDir, 'config.yaml'), 'provider: claude');
    writeFileSync(join(testDir, 'CLAUDE.md'), '# CLAUDE.md content');

    const content = loadInitialFiles(testDir);

    expect(content).toContain('# CLAUDE.md content');
    expect(content).not.toContain('# AGENT.md content');
    expect(content).not.toContain('# TAKT.md content');
  });

  it('should return empty string when no files exist', () => {
    writeFileSync(join(testDir, 'config.yaml'), 'provider: claude');

    const content = loadInitialFiles(testDir);

    expect(content).toBe('');
  });
});
