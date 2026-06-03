import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: vi.fn(() => 'ja'),
}));

const { loadPersonaPromptFromPath } = await import('../infra/config/loaders/agentLoader.js');

describe('project config dir collision in agentLoader', () => {
  let projectDir: string;
  let realGlobalDir: string;
  let originalTaktConfigDir: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-agent-collision-'));
    realGlobalDir = mkdtempSync(join(tmpdir(), 'takt-agent-global-'));
    originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;
    symlinkSync(realGlobalDir, join(projectDir, '.takt'));
    process.env.TAKT_CONFIG_DIR = realGlobalDir;
  });

  afterEach(() => {
    if (originalTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('should reject persona files under project facets when project config is disabled by collision', () => {
    const globalPersonaDir = join(realGlobalDir, 'facets', 'personas');
    const projectPersonaPath = join(projectDir, '.takt', 'facets', 'personas', 'custom.md');
    mkdirSync(globalPersonaDir, { recursive: true });
    const personaPath = join(globalPersonaDir, 'custom.md');
    writeFileSync(personaPath, 'Project persona', 'utf-8');

    expect(() => loadPersonaPromptFromPath(projectPersonaPath, projectDir)).toThrow(
      `Persona prompt file path is not allowed: ${projectPersonaPath}`,
    );
  });

  it('should allow persona files from the global facet dir when project config is disabled by collision', () => {
    const globalPersonaDir = join(realGlobalDir, 'facets', 'personas');
    mkdirSync(globalPersonaDir, { recursive: true });
    const personaPath = join(globalPersonaDir, 'global.md');
    writeFileSync(personaPath, 'Global persona', 'utf-8');

    expect(loadPersonaPromptFromPath(personaPath, projectDir)).toBe('Global persona');
  });
});
