/**
 * Global config tests.
 *
 * Tests global config loading and saving with piece_overrides,
 * including empty array round-trip behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PersistedGlobalConfig } from '../core/models/persisted-global-config.js';

// Mock the getGlobalConfigPath to use a test directory
let testConfigPath: string;
vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigPath: () => testConfigPath,
  getGlobalTaktDir: () => join(testConfigPath, '..'),
  getProjectTaktDir: vi.fn(),
  getProjectCwd: vi.fn(),
}));

import { GlobalConfigManager } from '../infra/config/global/globalConfig.js';

describe('globalConfig', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'takt-test-global-config-'));
    mkdirSync(testDir, { recursive: true });
    testConfigPath = join(testDir, 'config.yaml');
    GlobalConfigManager.resetInstance();
  });

  afterEach(() => {
    GlobalConfigManager.resetInstance();
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('piece_overrides empty array round-trip', () => {
    it('should preserve empty quality_gates array in save/load cycle', () => {
      // Write config with empty quality_gates array
      const configContent = `
piece_overrides:
  quality_gates: []
`;
      writeFileSync(testConfigPath, configContent, 'utf-8');

      // Load config
      const manager = GlobalConfigManager.getInstance();
      const loaded = manager.load();
      expect(loaded.pieceOverrides?.qualityGates).toEqual([]);

      // Save config
      manager.save(loaded);

      // Reset and reload to verify empty array is preserved
      GlobalConfigManager.resetInstance();
      const reloadedManager = GlobalConfigManager.getInstance();
      const reloaded = reloadedManager.load();
      expect(reloaded.pieceOverrides?.qualityGates).toEqual([]);
    });

    it('should preserve empty quality_gates in movements', () => {
      const configContent = `
piece_overrides:
  movements:
    implement:
      quality_gates: []
`;
      writeFileSync(testConfigPath, configContent, 'utf-8');

      const manager = GlobalConfigManager.getInstance();
      const loaded = manager.load();
      expect(loaded.pieceOverrides?.movements?.implement?.qualityGates).toEqual([]);

      manager.save(loaded);

      GlobalConfigManager.resetInstance();
      const reloadedManager = GlobalConfigManager.getInstance();
      const reloaded = reloadedManager.load();
      expect(reloaded.pieceOverrides?.movements?.implement?.qualityGates).toEqual([]);
    });

    it('should distinguish undefined from empty array', () => {
      // Test with undefined (not specified)
      writeFileSync(testConfigPath, 'piece_overrides: {}\n', 'utf-8');

      const manager1 = GlobalConfigManager.getInstance();
      const loaded1 = manager1.load();
      expect(loaded1.pieceOverrides?.qualityGates).toBeUndefined();

      // Test with empty array (explicitly disabled)
      GlobalConfigManager.resetInstance();
      writeFileSync(testConfigPath, 'piece_overrides:\n  quality_gates: []\n', 'utf-8');

      const manager2 = GlobalConfigManager.getInstance();
      const loaded2 = manager2.load();
      expect(loaded2.pieceOverrides?.qualityGates).toEqual([]);
    });

    it('should preserve non-empty quality_gates array', () => {
      const config: PersistedGlobalConfig = {
        pieceOverrides: {
          qualityGates: ['Test 1', 'Test 2'],
        },
      };

      const manager = GlobalConfigManager.getInstance();
      manager.save(config);

      GlobalConfigManager.resetInstance();
      const reloadedManager = GlobalConfigManager.getInstance();
      const reloaded = reloadedManager.load();

      expect(reloaded.pieceOverrides?.qualityGates).toEqual(['Test 1', 'Test 2']);
    });
  });
});
