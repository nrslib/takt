/**
 * Project config tests.
 *
 * Tests project config loading and saving with piece_overrides,
 * including empty array round-trip behavior.
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
});
