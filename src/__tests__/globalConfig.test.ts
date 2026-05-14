/**
 * Global config tests.
 *
 * Tests global config loading and saving with workflow_overrides,
 * including empty array round-trip behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import type { GlobalConfig } from '../core/models/config-types.js';
import {
  unexpectedEnableBuiltinWorkflowsConfigKey,
  unexpectedNotificationWorkflowAbortConfigKey,
  unexpectedNotificationWorkflowCompleteConfigKey,
  unexpectedWorkflowArpeggioConfigKey,
  unexpectedWorkflowCategoriesFileConfigKey,
  unexpectedWorkflowMcpServersConfigKey,
  unexpectedWorkflowOverridesConfigKey,
  unexpectedWorkflowRuntimePrepareConfigKey,
} from '../../test/helpers/unknown-contract-test-keys.js';

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

  describe('workflow_overrides empty array round-trip', () => {
    it('should preserve empty rate_limit_fallback switch_chain in save/load cycle', () => {
      writeFileSync(testConfigPath, 'rate_limit_fallback:\n  switch_chain: []\n', 'utf-8');

      const manager = GlobalConfigManager.getInstance();
      const loaded = manager.load();
      expect(loaded.rateLimitFallback?.switchChain).toEqual([]);

      manager.save(loaded);

      const raw = readFileSync(testConfigPath, 'utf-8');
      expect(raw).toContain('rate_limit_fallback:');
      expect(raw).toContain('switch_chain: []');

      GlobalConfigManager.resetInstance();
      const reloaded = GlobalConfigManager.getInstance().load();
      expect(reloaded.rateLimitFallback?.switchChain).toEqual([]);
    });

    it('should normalize rate_limit_fallback without switch_chain as disabled fallback', () => {
      writeFileSync(testConfigPath, 'rate_limit_fallback: {}\n', 'utf-8');

      const manager = GlobalConfigManager.getInstance();
      const loaded = manager.load();
      expect(loaded.rateLimitFallback?.switchChain).toEqual([]);

      manager.save(loaded);

      const raw = readFileSync(testConfigPath, 'utf-8');
      expect(raw).toContain('rate_limit_fallback:');
      expect(raw).toContain('switch_chain: []');
    });

    it('should reject rate_limit_fallback opencode entry without model', () => {
      writeFileSync(
        testConfigPath,
        [
          'rate_limit_fallback:',
          '  switch_chain:',
          '    - provider: opencode',
        ].join('\n'),
        'utf-8',
      );

      const manager = GlobalConfigManager.getInstance();
      expect(() => manager.load()).toThrow(/provider 'opencode' requires model/);
    });

    it('should preserve empty quality_gates array in save/load cycle', () => {
      // Write config with empty quality_gates array
      const configContent = `
workflow_overrides:
  quality_gates: []
`;
      writeFileSync(testConfigPath, configContent, 'utf-8');

      // Load config
      const manager = GlobalConfigManager.getInstance();
      const loaded = manager.load();
      expect(loaded.workflowOverrides?.qualityGates).toEqual([]);

      // Save config
      manager.save(loaded);

      // Reset and reload to verify empty array is preserved
      GlobalConfigManager.resetInstance();
      const reloadedManager = GlobalConfigManager.getInstance();
      const reloaded = reloadedManager.load();
      expect(reloaded.workflowOverrides?.qualityGates).toEqual([]);
    });

    it('should preserve empty quality_gates in steps', () => {
      const configContent = `
workflow_overrides:
  steps:
    implement:
      quality_gates: []
`;
      writeFileSync(testConfigPath, configContent, 'utf-8');

      const manager = GlobalConfigManager.getInstance();
      const loaded = manager.load();
      expect(loaded.workflowOverrides?.steps?.implement?.qualityGates).toEqual([]);

      manager.save(loaded);

      GlobalConfigManager.resetInstance();
      const reloadedManager = GlobalConfigManager.getInstance();
      const reloaded = reloadedManager.load();
      expect(reloaded.workflowOverrides?.steps?.implement?.qualityGates).toEqual([]);
    });

    it('should distinguish undefined from empty array', () => {
      // Test with undefined (not specified)
      writeFileSync(testConfigPath, 'workflow_overrides: {}\n', 'utf-8');

      const manager1 = GlobalConfigManager.getInstance();
      const loaded1 = manager1.load();
      expect(loaded1.workflowOverrides?.qualityGates).toBeUndefined();

      // Test with empty array (explicitly disabled)
      GlobalConfigManager.resetInstance();
      writeFileSync(testConfigPath, 'workflow_overrides:\n  quality_gates: []\n', 'utf-8');

      const manager2 = GlobalConfigManager.getInstance();
      const loaded2 = manager2.load();
      expect(loaded2.workflowOverrides?.qualityGates).toEqual([]);
    });

    it('should preserve non-empty quality_gates array', () => {
      const config: GlobalConfig = {
        workflowOverrides: {
          qualityGates: ['Test 1', 'Test 2'],
        },
      };

      const manager = GlobalConfigManager.getInstance();
      manager.save(config);

      GlobalConfigManager.resetInstance();
      const reloadedManager = GlobalConfigManager.getInstance();
      const reloaded = reloadedManager.load();

      expect(reloaded.workflowOverrides?.qualityGates).toEqual(['Test 1', 'Test 2']);
    });

    it('should preserve personas quality_gates in save/load cycle', () => {
      const configContent = `
workflow_overrides:
  personas:
    coder:
      quality_gates:
        - "Global persona gate"
`;
      writeFileSync(testConfigPath, configContent, 'utf-8');

      const manager = GlobalConfigManager.getInstance();
      const loaded = manager.load();
      const loadedWorkflowOverrides = loaded.workflowOverrides as unknown as {
        personas?: Record<string, { qualityGates?: string[] }>;
      };
      expect(loadedWorkflowOverrides.personas?.coder?.qualityGates).toEqual(['Global persona gate']);

      manager.save(loaded);

      GlobalConfigManager.resetInstance();
      const reloadedManager = GlobalConfigManager.getInstance();
      const reloaded = reloadedManager.load();
      const reloadedWorkflowOverrides = reloaded.workflowOverrides as unknown as {
        personas?: Record<string, { qualityGates?: string[] }>;
      };
      expect(reloadedWorkflowOverrides.personas?.coder?.qualityGates).toEqual(['Global persona gate']);
    });

    it('should preserve empty quality_gates array in personas', () => {
      const configContent = `
workflow_overrides:
  personas:
    coder:
      quality_gates: []
`;
      writeFileSync(testConfigPath, configContent, 'utf-8');

      const manager = GlobalConfigManager.getInstance();
      const loaded = manager.load();
      const loadedWorkflowOverrides = loaded.workflowOverrides as unknown as {
        personas?: Record<string, { qualityGates?: string[] }>;
      };
      expect(loadedWorkflowOverrides.personas?.coder?.qualityGates).toEqual([]);

      manager.save(loaded);

      GlobalConfigManager.resetInstance();
      const reloadedManager = GlobalConfigManager.getInstance();
      const reloaded = reloadedManager.load();
      const reloadedWorkflowOverrides = reloaded.workflowOverrides as unknown as {
        personas?: Record<string, { qualityGates?: string[] }>;
      };
      expect(reloadedWorkflowOverrides.personas?.coder?.qualityGates).toEqual([]);
    });

    it('should load workflow_overrides.steps with canonical step keys', () => {
      const configContent = `
workflow_overrides:
  steps:
    implement:
      quality_gates: []
`;
      writeFileSync(testConfigPath, configContent, 'utf-8');

      const manager = GlobalConfigManager.getInstance();
      const loaded = manager.load();

      expect(loaded.workflowOverrides?.steps?.implement?.qualityGates).toEqual([]);
    });

    it('should reject an unexpected override key when workflow_overrides is also present', () => {
      const configContent = `
workflow_overrides:
  quality_gates:
    - "new"
unexpected_overrides:
  quality_gates:
    - "ignored"
`;
      writeFileSync(testConfigPath, configContent, 'utf-8');

      const manager = GlobalConfigManager.getInstance();
      expect(() => manager.load()).toThrow(/unexpected_overrides/i);
    });

    it('should reject an unexpected override key even when semantically identical to workflow_overrides', () => {
      const configContent = `
workflow_overrides:
  steps:
    implement:
      quality_gates:
        - "shared"
unexpected_overrides:
  steps:
    implement:
      quality_gates:
        - "shared"
`;
      writeFileSync(testConfigPath, configContent, 'utf-8');

      const manager = GlobalConfigManager.getInstance();
      expect(() => manager.load()).toThrow(/unexpected_overrides/i);
    });

    it('should save workflowOverrides using workflow_overrides and steps keys', () => {
      const config: GlobalConfig = {
        workflowOverrides: {
          steps: {
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
      ['workflow_categories_file', 'workflowCategoriesFile'],
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
        unexpectedWorkflowOverridesConfigKey,
        [
          `${unexpectedWorkflowOverridesConfigKey}:`,
          '  quality_gates:',
          '    - blocked',
        ].join('\n'),
      ],
      [
        unexpectedWorkflowRuntimePrepareConfigKey,
        [
          `${unexpectedWorkflowRuntimePrepareConfigKey}:`,
          '  custom_scripts: true',
        ].join('\n'),
      ],
      [
        unexpectedWorkflowArpeggioConfigKey,
        [
          `${unexpectedWorkflowArpeggioConfigKey}:`,
          '  custom_data_source_modules: true',
          '  custom_merge_inline_js: false',
          '  custom_merge_files: true',
        ].join('\n'),
      ],
      [
        unexpectedWorkflowMcpServersConfigKey,
        [
          `${unexpectedWorkflowMcpServersConfigKey}:`,
          '  stdio: true',
          '  http: false',
          '  sse: true',
        ].join('\n'),
      ],
      [unexpectedEnableBuiltinWorkflowsConfigKey, `${unexpectedEnableBuiltinWorkflowsConfigKey}: true`],
      [
        unexpectedWorkflowCategoriesFileConfigKey,
        `${unexpectedWorkflowCategoriesFileConfigKey}: /tmp/removed-workflow-categories.yaml`,
      ],
    ])('should reject unknown workflow-facing key %s in global config yaml', (unknownKey, content) => {
      writeFileSync(testConfigPath, `${content}\n`, 'utf-8');

      expect(() => GlobalConfigManager.getInstance().load()).toThrow(new RegExp(`${unknownKey}|unrecognized`, 'i'));
    });

    it.each([
      unexpectedNotificationWorkflowCompleteConfigKey,
      unexpectedNotificationWorkflowAbortConfigKey,
    ])('should reject unknown notification workflow key %s in global config yaml', (unknownKey) => {
      writeFileSync(
        testConfigPath,
        ['notification_sound_events:', `  ${unknownKey}: true`].join('\n'),
        'utf-8',
      );

      expect(() => GlobalConfigManager.getInstance().load()).toThrow(new RegExp(`${unknownKey}|unrecognized`, 'i'));
    });

    it.each([
      [
        'workflow_arpeggio with duplicate canonical keys',
        ['workflow_arpeggio:', '  custom_merge_files: true', 'workflow_arpeggio:', '  custom_merge_files: false'],
      ],
      [
        'workflow_mcp_servers with duplicate canonical keys',
        ['workflow_mcp_servers:', '  http: true', 'workflow_mcp_servers:', '  http: false'],
      ],
      [
        'notification workflow keys with legacy keys',
        [
          'notification_sound_events:',
          '  workflow_complete: true',
          '  workflow_complete: false',
          '  workflow_abort: false',
          '  workflow_abort: true',
        ],
      ],
    ])('should fail fast when %s are duplicated', (_label, lines) => {
      writeFileSync(testConfigPath, `${lines.join('\n')}\n`, 'utf-8');

      expect(() => GlobalConfigManager.getInstance().load()).toThrow(/Map keys must be unique/i);
    });

    it('should load workflow_runtime_prepare policy block', () => {
      writeFileSync(
        testConfigPath,
        ['workflow_runtime_prepare:', '  custom_scripts: true'].join('\n'),
        'utf-8',
      );

      const loaded = GlobalConfigManager.getInstance().load();

      expect(loaded.workflowRuntimePrepare).toEqual({ customScripts: true });
    });

    it('should save workflowRuntimePrepare using workflow_runtime_prepare key', () => {
      const config: GlobalConfig = {
        workflowRuntimePrepare: { customScripts: true },
      };

      GlobalConfigManager.getInstance().save(config);

      const saved = readFileSync(testConfigPath, 'utf-8');
      expect(saved).toContain('workflow_runtime_prepare:');
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

      expect(loaded.workflowArpeggio).toEqual({
        customDataSourceModules: true,
        customMergeInlineJs: false,
        customMergeFiles: true,
      });
    });

    it('should save workflowArpeggio using workflow_arpeggio key', () => {
      const config: GlobalConfig = {
        workflowArpeggio: {
          customDataSourceModules: true,
          customMergeInlineJs: true,
          customMergeFiles: false,
        },
      };

      GlobalConfigManager.getInstance().save(config);

      const saved = readFileSync(testConfigPath, 'utf-8');
      expect(saved).toContain('workflow_arpeggio:');
    });

    it('should load workflow_mcp_servers config block', () => {
      writeFileSync(
        testConfigPath,
        ['workflow_mcp_servers:', '  stdio: true', '  http: false', '  sse: true'].join('\n'),
        'utf-8',
      );

      const loaded = GlobalConfigManager.getInstance().load();

      expect(loaded.workflowMcpServers).toEqual({ stdio: true, http: false, sse: true });
    });

    it('should save workflowMcpServers using workflow_mcp_servers key', () => {
      const config: GlobalConfig = {
        workflowMcpServers: { stdio: true, http: true, sse: false },
      };

      GlobalConfigManager.getInstance().save(config);

      const saved = readFileSync(testConfigPath, 'utf-8');
      expect(saved).toContain('workflow_mcp_servers:');
    });

    it('should load enable_builtin_workflows from the canonical key', () => {
      writeFileSync(testConfigPath, 'enable_builtin_workflows: true\n', 'utf-8');

      const loaded = GlobalConfigManager.getInstance().load();

      expect(loaded.enableBuiltinWorkflows).toBe(true);
    });

    it('should save enableBuiltinWorkflows using enable_builtin_workflows key', () => {
      const config: GlobalConfig = {
        enableBuiltinWorkflows: true,
      };

      GlobalConfigManager.getInstance().save(config);

      const saved = readFileSync(testConfigPath, 'utf-8');
      expect(saved).toContain('enable_builtin_workflows: true');
    });

    it('should save workflowCategoriesFile using workflow_categories_file key', () => {
      const config: GlobalConfig = {
        workflowCategoriesFile: '/tmp/workflow-categories.yaml',
      };

      GlobalConfigManager.getInstance().save(config);

      const saved = readFileSync(testConfigPath, 'utf-8');
      expect(saved).toContain('workflow_categories_file: /tmp/workflow-categories.yaml');
    });

    it('should load workflow notification keys with canonical workflow key names', () => {
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
        workflowComplete: true,
        workflowAbort: false,
      });
    });

    it('should save notificationSoundEvents using workflow notification keys', () => {
      const config: GlobalConfig = {
        notificationSoundEvents: {
          workflowComplete: true,
          workflowAbort: false,
        },
      };

      GlobalConfigManager.getInstance().save(config);

      const saved = readFileSync(testConfigPath, 'utf-8');
      expect(saved).toContain('workflow_complete: true');
      expect(saved).toContain('workflow_abort: false');
    });
  });
});
