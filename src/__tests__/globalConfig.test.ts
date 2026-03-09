/**
 * Global config tests.
 *
 * Tests global config loading and saving with piece_overrides,
 * including empty array round-trip behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import type { GlobalConfig } from '../core/models/config-types.js';

// Mock the getGlobalConfigPath to use a test directory
let testConfigPath: string;
vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigPath: () => testConfigPath,
  getGlobalTaktDir: () => join(testConfigPath, '..'),
  getProjectTaktDir: vi.fn(),
  getProjectCwd: vi.fn(),
}));

import { GlobalConfigManager } from '../infra/config/global/globalConfigCore.js';

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
      const config: GlobalConfig = {
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

    it('should preserve personas quality_gates in save/load cycle', () => {
      const configContent = `
piece_overrides:
  personas:
    coder:
      quality_gates:
        - "Global persona gate"
`;
      writeFileSync(testConfigPath, configContent, 'utf-8');

      const manager = GlobalConfigManager.getInstance();
      const loaded = manager.load();
      const loadedPieceOverrides = loaded.pieceOverrides as unknown as {
        personas?: Record<string, { qualityGates?: string[] }>;
      };
      expect(loadedPieceOverrides.personas?.coder?.qualityGates).toEqual(['Global persona gate']);

      manager.save(loaded);

      GlobalConfigManager.resetInstance();
      const reloadedManager = GlobalConfigManager.getInstance();
      const reloaded = reloadedManager.load();
      const reloadedPieceOverrides = reloaded.pieceOverrides as unknown as {
        personas?: Record<string, { qualityGates?: string[] }>;
      };
      expect(reloadedPieceOverrides.personas?.coder?.qualityGates).toEqual(['Global persona gate']);
    });

    it('should preserve empty quality_gates array in personas', () => {
      const configContent = `
piece_overrides:
  personas:
    coder:
      quality_gates: []
`;
      writeFileSync(testConfigPath, configContent, 'utf-8');

      const manager = GlobalConfigManager.getInstance();
      const loaded = manager.load();
      const loadedPieceOverrides = loaded.pieceOverrides as unknown as {
        personas?: Record<string, { qualityGates?: string[] }>;
      };
      expect(loadedPieceOverrides.personas?.coder?.qualityGates).toEqual([]);

      manager.save(loaded);

      GlobalConfigManager.resetInstance();
      const reloadedManager = GlobalConfigManager.getInstance();
      const reloaded = reloadedManager.load();
      const reloadedPieceOverrides = reloaded.pieceOverrides as unknown as {
        personas?: Record<string, { qualityGates?: string[] }>;
      };
      expect(reloadedPieceOverrides.personas?.coder?.qualityGates).toEqual([]);
    });
  });

  describe('security hardening', () => {
    it('should reject forbidden keys that can cause prototype pollution', () => {
      const configContent = `
logging:
  level: info
  __proto__:
    polluted: true
`;
      writeFileSync(testConfigPath, configContent, 'utf-8');

      const manager = GlobalConfigManager.getInstance();
      expect(() => manager.load()).toThrow(/forbidden key "__proto__"/i);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });
  });

  describe('tilde expansion for path fields', () => {
    it.each([
      ['worktree_dir', 'worktreeDir'],
      ['bookmarks_file', 'bookmarksFile'],
      ['piece_categories_file', 'pieceCategoriesFile'],
      ['codex_cli_path', 'codexCliPath'],
      ['claude_cli_path', 'claudeCliPath'],
      ['cursor_cli_path', 'cursorCliPath'],
      ['copilot_cli_path', 'copilotCliPath'],
    ] as const)('should expand "~/" for %s', (yamlKey, configKey) => {
      writeFileSync(testConfigPath, `${yamlKey}: ~/.takt/bin/value\n`, 'utf-8');

      const loaded = GlobalConfigManager.getInstance().load() as Record<string, unknown>;

      expect(loaded[configKey]).toBe(join(homedir(), '.takt/bin/value'));
    });

    it('should expand "~/" for analytics.events_path', () => {
      writeFileSync(
        testConfigPath,
        ['analytics:', '  enabled: true', '  events_path: ~/.takt/analytics/events'].join('\n'),
        'utf-8',
      );

      const loaded = GlobalConfigManager.getInstance().load();

      expect(loaded.analytics?.eventsPath).toBe(join(homedir(), '.takt/analytics/events'));
    });

    it('should expand "~" for worktree_dir to home directory itself', () => {
      writeFileSync(testConfigPath, 'worktree_dir: "~"\n', 'utf-8');

      const loaded = GlobalConfigManager.getInstance().load();

      expect(loaded.worktreeDir).toBe(homedir());
    });
  });
});
