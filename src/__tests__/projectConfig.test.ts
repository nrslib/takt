/**
 * Project config tests.
 *
 * Tests project config loading and saving with piece_overrides
 * and runtime.prepare, including round-trip behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadProjectConfig, saveProjectConfig } from '../infra/config/project/projectConfig.js';
import type { ProjectLocalConfig } from '../infra/config/types.js';

describe('projectConfig', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'takt-test-project-config-'));
    mkdirSync(join(testDir, '.takt'), { recursive: true });
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('piece_overrides empty array round-trip', () => {
    it('should preserve empty quality_gates array in save/load cycle', () => {
      // Write config with empty quality_gates array
      const configPath = join(testDir, '.takt', 'config.yaml');
      const configContent = `
piece_overrides:
  quality_gates: []
`;
      writeFileSync(configPath, configContent, 'utf-8');

      // Load config
      const loaded = loadProjectConfig(testDir);
      expect(loaded.pieceOverrides?.qualityGates).toEqual([]);

      // Save config
      saveProjectConfig(testDir, loaded);

      // Reload and verify empty array is preserved
      const reloaded = loadProjectConfig(testDir);
      expect(reloaded.pieceOverrides?.qualityGates).toEqual([]);
    });

    it('should preserve empty quality_gates in movements', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      const configContent = `
piece_overrides:
  movements:
    implement:
      quality_gates: []
`;
      writeFileSync(configPath, configContent, 'utf-8');

      const loaded = loadProjectConfig(testDir);
      expect(loaded.pieceOverrides?.movements?.implement?.qualityGates).toEqual([]);

      saveProjectConfig(testDir, loaded);

      const reloaded = loadProjectConfig(testDir);
      expect(reloaded.pieceOverrides?.movements?.implement?.qualityGates).toEqual([]);
    });

    it('should distinguish undefined from empty array', () => {
      // Test with undefined (not specified)
      const configPath1 = join(testDir, '.takt', 'config.yaml');
      writeFileSync(configPath1, 'piece_overrides: {}\n', 'utf-8');

      const loaded1 = loadProjectConfig(testDir);
      expect(loaded1.pieceOverrides?.qualityGates).toBeUndefined();

      // Test with empty array (explicitly disabled)
      const configPath2 = join(testDir, '.takt', 'config.yaml');
      writeFileSync(configPath2, 'piece_overrides:\n  quality_gates: []\n', 'utf-8');

      const loaded2 = loadProjectConfig(testDir);
      expect(loaded2.pieceOverrides?.qualityGates).toEqual([]);
    });

    it('should preserve non-empty quality_gates array', () => {
      const config: ProjectLocalConfig = {
        pieceOverrides: {
          qualityGates: ['Test 1', 'Test 2'],
        },
      };

      saveProjectConfig(testDir, config);
      const reloaded = loadProjectConfig(testDir);

      expect(reloaded.pieceOverrides?.qualityGates).toEqual(['Test 1', 'Test 2']);
    });
  });

  describe('runtime.prepare round-trip', () => {
    it('should preserve runtime.prepare with preset entries when loading from YAML', () => {
      // Given: YAML config with runtime.prepare containing a preset
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(configPath, 'runtime:\n  prepare:\n    - node\n', 'utf-8');

      // When: loading the config
      const loaded = loadProjectConfig(testDir);

      // Then: runtime.prepare is preserved (not stripped by Zod)
      expect(loaded.runtime).toBeDefined();
      expect(loaded.runtime?.prepare).toEqual(['node']);
    });

    it('should preserve runtime.prepare with multiple entries when loading from YAML', () => {
      // Given: YAML config with multiple prepare entries
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(configPath, 'runtime:\n  prepare:\n    - node\n    - gradle\n', 'utf-8');

      // When: loading the config
      const loaded = loadProjectConfig(testDir);

      // Then: all entries are preserved
      expect(loaded.runtime?.prepare).toEqual(['node', 'gradle']);
    });

    it('should preserve runtime.prepare with custom script paths', () => {
      // Given: YAML config with a custom script path
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(configPath, 'runtime:\n  prepare:\n    - ./setup.sh\n', 'utf-8');

      // When: loading the config
      const loaded = loadProjectConfig(testDir);

      // Then: custom script path is preserved
      expect(loaded.runtime?.prepare).toEqual(['./setup.sh']);
    });

    it('should preserve runtime.prepare through save/load round-trip', () => {
      // Given: a config with runtime.prepare
      const config: ProjectLocalConfig = {
        runtime: { prepare: ['node'] },
      };

      // When: saving and reloading
      saveProjectConfig(testDir, config);
      const reloaded = loadProjectConfig(testDir);

      // Then: runtime.prepare is preserved
      expect(reloaded.runtime?.prepare).toEqual(['node']);
    });

    it('should deduplicate runtime.prepare entries in round-trip', () => {
      // Given: YAML config with duplicate prepare entries
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(configPath, 'runtime:\n  prepare:\n    - node\n    - node\n', 'utf-8');

      // When: loading the config
      const loaded = loadProjectConfig(testDir);

      // Then: duplicates are removed
      expect(loaded.runtime?.prepare).toEqual(['node']);
    });

    it('should return undefined runtime when not specified in YAML', () => {
      // Given: YAML config without runtime
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(configPath, 'piece: my-piece\n', 'utf-8');

      // When: loading the config
      const loaded = loadProjectConfig(testDir);

      // Then: runtime is undefined
      expect(loaded.runtime).toBeUndefined();
    });

    it('should return undefined runtime when prepare array is empty', () => {
      // Given: YAML config with empty prepare array
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(configPath, 'runtime:\n  prepare: []\n', 'utf-8');

      // When: loading the config
      const loaded = loadProjectConfig(testDir);

      // Then: runtime is normalized to undefined (empty prepare has no effect)
      expect(loaded.runtime).toBeUndefined();
    });

    it('should not serialize runtime when prepare is empty in save', () => {
      // Given: a config with empty runtime
      const config: ProjectLocalConfig = {};

      // When: saving and reloading
      saveProjectConfig(testDir, config);
      const reloaded = loadProjectConfig(testDir);

      // Then: runtime remains undefined
      expect(reloaded.runtime).toBeUndefined();
    });

    it('should preserve runtime.prepare with mixed presets and custom scripts in round-trip', () => {
      // Given: a config mixing presets and custom scripts
      const config: ProjectLocalConfig = {
        runtime: { prepare: ['node', 'gradle', './custom-setup.sh'] },
      };

      // When: saving and reloading
      saveProjectConfig(testDir, config);
      const reloaded = loadProjectConfig(testDir);

      // Then: all entries are preserved
      expect(reloaded.runtime?.prepare).toEqual(['node', 'gradle', './custom-setup.sh']);
    });
  });
});
