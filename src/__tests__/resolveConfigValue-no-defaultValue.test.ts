/**
 * Tests for RESOLUTION_REGISTRY defaultValue removal.
 *
 * Verifies that piece, verbose, and autoFetch no longer rely on
 * RESOLUTION_REGISTRY defaultValue but instead use schema defaults
 * or other guaranteed sources.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const testId = randomUUID();
const testDir = join(tmpdir(), `takt-rcv-test-${testId}`);
const globalTaktDir = join(testDir, 'global-takt');
const globalConfigPath = join(globalTaktDir, 'config.yaml');

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getGlobalConfigPath: () => globalConfigPath,
    getTaktDir: () => globalTaktDir,
  };
});

const { resolveConfigValue, resolveConfigValueWithSource, invalidateAllResolvedConfigCache } = await import('../infra/config/resolveConfigValue.js');
const { invalidateGlobalConfigCache } = await import('../infra/config/global/globalConfig.js');
const { getProjectConfigDir } = await import('../infra/config/paths.js');

describe('RESOLUTION_REGISTRY defaultValue removal', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(testDir, `project-${randomUUID()}`);
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(globalTaktDir, { recursive: true });
    writeFileSync(globalConfigPath, 'language: en\n', 'utf-8');
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('verbose', () => {
    it('should resolve verbose to false via schema default when not set anywhere', () => {
      const value = resolveConfigValue(projectDir, 'verbose');
      expect(value).toBe(false);
    });

    it('should report source as global when verbose comes from schema default', () => {
      const result = resolveConfigValueWithSource(projectDir, 'verbose');
      expect(result.value).toBe(false);
      expect(result.source).toBe('global');
    });

    it('should resolve verbose from global config when explicitly set', () => {
      writeFileSync(globalConfigPath, 'language: en\nverbose: true\n', 'utf-8');
      invalidateGlobalConfigCache();

      const value = resolveConfigValue(projectDir, 'verbose');
      expect(value).toBe(true);
    });

    it('should resolve verbose from project config over global', () => {
      writeFileSync(globalConfigPath, 'language: en\nverbose: false\n', 'utf-8');
      invalidateGlobalConfigCache();

      const configDir = getProjectConfigDir(projectDir);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), 'piece: default\nverbose: true\n');

      const value = resolveConfigValue(projectDir, 'verbose');
      expect(value).toBe(true);
    });
  });

  describe('autoFetch', () => {
    it('should resolve autoFetch to false via schema default when not set', () => {
      const value = resolveConfigValue(projectDir, 'autoFetch');
      expect(value).toBe(false);
    });

    it('should report source as global when autoFetch comes from schema default', () => {
      const result = resolveConfigValueWithSource(projectDir, 'autoFetch');
      expect(result.value).toBe(false);
      expect(result.source).toBe('global');
    });

    it('should resolve autoFetch from global config when explicitly set', () => {
      writeFileSync(globalConfigPath, 'language: en\nauto_fetch: true\n', 'utf-8');
      invalidateGlobalConfigCache();

      const value = resolveConfigValue(projectDir, 'autoFetch');
      expect(value).toBe(true);
    });
  });
});
