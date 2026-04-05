/**
 * Global config tests.
 *
 * Tests global config loading and saving with piece_overrides,
 * including empty array round-trip behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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

    it('should load workflow_overrides.steps as alias of piece_overrides.movements', () => {
      const configContent = `
workflow_overrides:
  steps:
    implement:
      quality_gates: []
`;
      writeFileSync(testConfigPath, configContent, 'utf-8');

      const manager = GlobalConfigManager.getInstance();
      const loaded = manager.load();

      expect(loaded.pieceOverrides?.movements?.implement?.qualityGates).toEqual([]);
    });

    it('should fail fast when workflow_overrides and piece_overrides differ', () => {
      const configContent = `
workflow_overrides:
  quality_gates:
    - "new"
piece_overrides:
  quality_gates:
    - "legacy"
`;
      writeFileSync(testConfigPath, configContent, 'utf-8');

      const manager = GlobalConfigManager.getInstance();
      expect(() => manager.load()).toThrow(
        /workflow_overrides.*piece_overrides|piece_overrides.*workflow_overrides|conflict/i,
      );
    });

    it('should accept semantically identical workflow_overrides and piece_overrides', () => {
      const configContent = `
workflow_overrides:
  steps:
    implement:
      quality_gates:
        - "shared"
piece_overrides:
  movements:
    implement:
      quality_gates:
        - "shared"
`;
      writeFileSync(testConfigPath, configContent, 'utf-8');

      const manager = GlobalConfigManager.getInstance();
      const loaded = manager.load();

      expect(loaded.pieceOverrides?.movements?.implement?.qualityGates).toEqual(['shared']);
    });

    it('should save pieceOverrides using workflow_overrides and steps keys', () => {
      const config: GlobalConfig = {
        pieceOverrides: {
          movements: {
            implement: {
              qualityGates: ['Global gate'],
            },
          },
        },
      };

      const manager = GlobalConfigManager.getInstance();
      manager.save(config);

      const saved = readFileSync(testConfigPath, 'utf-8');
      expect(saved).toContain('workflow_overrides:');
      expect(saved).toContain('steps:');
      expect(saved).not.toContain('piece_overrides:');
      expect(saved).not.toContain('movements:');
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
      ['workflow_categories_file', 'pieceCategoriesFile'],
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

  describe('workflow-facing global aliases', () => {
    it.each([
      [
        'workflow_arpeggio',
        ['workflow_arpeggio:', '  custom_merge_files: true', 'piece_arpeggio:', '  custom_merge_files: false'],
      ],
      [
        'workflow_mcp_servers',
        ['workflow_mcp_servers:', '  http: true', 'piece_mcp_servers:', '  http: false'],
      ],
      [
        'enable_builtin_workflows',
        ['enable_builtin_workflows: true', 'enable_builtin_pieces: false'],
      ],
      [
        'workflow_categories_file',
        ['workflow_categories_file: /tmp/workflows.yaml', 'piece_categories_file: /tmp/pieces.yaml'],
      ],
      [
        'notification workflow keys',
        [
          'notification_sound_events:',
          '  workflow_complete: true',
          '  piece_complete: false',
          '  workflow_abort: false',
          '  piece_abort: true',
        ],
      ],
    ])('should fail fast when %s aliases differ', (_label, lines) => {
      writeFileSync(testConfigPath, `${lines.join('\n')}\n`, 'utf-8');

      expect(() => GlobalConfigManager.getInstance().load()).toThrow(/conflict/i);
    });

    it('should load workflow_runtime_prepare policy block', () => {
      writeFileSync(
        testConfigPath,
        ['workflow_runtime_prepare:', '  custom_scripts: true'].join('\n'),
        'utf-8',
      );

      const loaded = GlobalConfigManager.getInstance().load();

      expect(loaded.pieceRuntimePrepare).toEqual({ customScripts: true });
    });

    it('should save pieceRuntimePrepare using workflow_runtime_prepare key', () => {
      const config: GlobalConfig = {
        pieceRuntimePrepare: { customScripts: true },
      };

      GlobalConfigManager.getInstance().save(config);

      const saved = readFileSync(testConfigPath, 'utf-8');
      expect(saved).toContain('workflow_runtime_prepare:');
      expect(saved).not.toContain('piece_runtime_prepare:');
    });

    it('should fail fast when workflow_runtime_prepare and piece_runtime_prepare differ', () => {
      writeFileSync(
        testConfigPath,
        [
          'workflow_runtime_prepare:',
          '  custom_scripts: true',
          'piece_runtime_prepare:',
          '  custom_scripts: false',
        ].join('\n'),
        'utf-8',
      );

      expect(() => GlobalConfigManager.getInstance().load()).toThrow(
        /workflow_runtime_prepare.*piece_runtime_prepare|piece_runtime_prepare.*workflow_runtime_prepare|conflict/i,
      );
    });

    it('should load workflow_arpeggio policy block', () => {
      writeFileSync(
        testConfigPath,
        [
          'workflow_arpeggio:',
          '  custom_data_source_modules: true',
          '  custom_merge_inline_js: false',
          '  custom_merge_files: true',
        ].join('\n'),
        'utf-8',
      );

      const loaded = GlobalConfigManager.getInstance().load();

      expect(loaded.pieceArpeggio).toEqual({
        customDataSourceModules: true,
        customMergeInlineJs: false,
        customMergeFiles: true,
      });
    });

    it('should save pieceArpeggio using workflow_arpeggio key', () => {
      const config: GlobalConfig = {
        pieceArpeggio: {
          customDataSourceModules: true,
          customMergeInlineJs: true,
          customMergeFiles: false,
        },
      };

      GlobalConfigManager.getInstance().save(config);

      const saved = readFileSync(testConfigPath, 'utf-8');
      expect(saved).toContain('workflow_arpeggio:');
      expect(saved).not.toContain('piece_arpeggio:');
    });

    it('should load workflow_mcp_servers config block', () => {
      writeFileSync(
        testConfigPath,
        ['workflow_mcp_servers:', '  stdio: true', '  http: false', '  sse: true'].join('\n'),
        'utf-8',
      );

      const loaded = GlobalConfigManager.getInstance().load();

      expect(loaded.pieceMcpServers).toEqual({ stdio: true, http: false, sse: true });
    });

    it('should save pieceMcpServers using workflow_mcp_servers key', () => {
      const config: GlobalConfig = {
        pieceMcpServers: { stdio: true, http: true, sse: false },
      };

      GlobalConfigManager.getInstance().save(config);

      const saved = readFileSync(testConfigPath, 'utf-8');
      expect(saved).toContain('workflow_mcp_servers:');
      expect(saved).not.toContain('piece_mcp_servers:');
    });

    it('should load enable_builtin_workflows as alias of enable_builtin_pieces', () => {
      writeFileSync(testConfigPath, 'enable_builtin_workflows: true\n', 'utf-8');

      const loaded = GlobalConfigManager.getInstance().load();

      expect(loaded.enableBuiltinPieces).toBe(true);
    });

    it('should save enableBuiltinPieces using enable_builtin_workflows key', () => {
      const config: GlobalConfig = {
        enableBuiltinPieces: true,
      };

      GlobalConfigManager.getInstance().save(config);

      const saved = readFileSync(testConfigPath, 'utf-8');
      expect(saved).toContain('enable_builtin_workflows: true');
      expect(saved).not.toContain('enable_builtin_pieces:');
    });

    it('should save pieceCategoriesFile using workflow_categories_file key', () => {
      const config: GlobalConfig = {
        pieceCategoriesFile: '/tmp/workflow-categories.yaml',
      };

      GlobalConfigManager.getInstance().save(config);

      const saved = readFileSync(testConfigPath, 'utf-8');
      expect(saved).toContain('workflow_categories_file: /tmp/workflow-categories.yaml');
      expect(saved).not.toContain('piece_categories_file:');
    });

    it('should load workflow notification keys as aliases of piece notification keys', () => {
      writeFileSync(
        testConfigPath,
        [
          'notification_sound_events:',
          '  workflow_complete: true',
          '  workflow_abort: false',
        ].join('\n'),
        'utf-8',
      );

      const loaded = GlobalConfigManager.getInstance().load();

      expect(loaded.notificationSoundEvents).toEqual({
        pieceComplete: true,
        pieceAbort: false,
      });
    });

    it('should save notificationSoundEvents using workflow notification keys', () => {
      const config: GlobalConfig = {
        notificationSoundEvents: {
          pieceComplete: true,
          pieceAbort: false,
        },
      };

      GlobalConfigManager.getInstance().save(config);

      const saved = readFileSync(testConfigPath, 'utf-8');
      expect(saved).toContain('workflow_complete: true');
      expect(saved).toContain('workflow_abort: false');
      expect(saved).not.toContain('piece_complete:');
      expect(saved).not.toContain('piece_abort:');
    });
  });
});
