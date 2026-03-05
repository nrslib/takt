/**
 * Project config tests.
 *
 * Tests project config loading and saving with piece_overrides,
 * including empty array round-trip behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

    it('should preserve personas quality_gates in save/load cycle', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      const configContent = `
piece_overrides:
  personas:
    coder:
      quality_gates:
        - "Project persona gate"
`;
      writeFileSync(configPath, configContent, 'utf-8');

      const loaded = loadProjectConfig(testDir);
      const loadedPieceOverrides = loaded.pieceOverrides as unknown as {
        personas?: Record<string, { qualityGates?: string[] }>;
      };
      expect(loadedPieceOverrides.personas?.coder?.qualityGates).toEqual(['Project persona gate']);

      saveProjectConfig(testDir, loaded);

      const reloaded = loadProjectConfig(testDir);
      const reloadedPieceOverrides = reloaded.pieceOverrides as unknown as {
        personas?: Record<string, { qualityGates?: string[] }>;
      };
      expect(reloadedPieceOverrides.personas?.coder?.qualityGates).toEqual(['Project persona gate']);
    });

    it('should preserve empty quality_gates array in personas', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      const configContent = `
piece_overrides:
  personas:
    coder:
      quality_gates: []
`;
      writeFileSync(configPath, configContent, 'utf-8');

      const loaded = loadProjectConfig(testDir);
      const loadedPieceOverrides = loaded.pieceOverrides as unknown as {
        personas?: Record<string, { qualityGates?: string[] }>;
      };
      expect(loadedPieceOverrides.personas?.coder?.qualityGates).toEqual([]);

      saveProjectConfig(testDir, loaded);

      const reloaded = loadProjectConfig(testDir);
      const reloadedPieceOverrides = reloaded.pieceOverrides as unknown as {
        personas?: Record<string, { qualityGates?: string[] }>;
      };
      expect(reloadedPieceOverrides.personas?.coder?.qualityGates).toEqual([]);
    });
  });

  describe('migrated project-local fields', () => {
    it('should load migrated fields from project config yaml', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      const configContent = [
        'log_level: debug',
        'pipeline:',
        '  default_branch_prefix: "proj/"',
        '  commit_message_template: "feat: {title} (#{issue})"',
        'persona_providers:',
        '  coder:',
        '    provider: opencode',
        '    model: opencode/big-pickle',
        'branch_name_strategy: ai',
        'minimal_output: true',
        'concurrency: 3',
        'task_poll_interval_ms: 1200',
        'interactive_preview_movements: 2',
        'verbose: true',
      ].join('\n');
      writeFileSync(configPath, configContent, 'utf-8');

      const loaded = loadProjectConfig(testDir) as Record<string, unknown>;
      expect(loaded.logLevel).toBe('debug');
      expect(loaded.pipeline).toEqual({
        defaultBranchPrefix: 'proj/',
        commitMessageTemplate: 'feat: {title} (#{issue})',
      });
      expect(loaded.personaProviders).toEqual({
        coder: { provider: 'opencode', model: 'opencode/big-pickle' },
      });
      expect(loaded.branchNameStrategy).toBe('ai');
      expect(loaded.minimalOutput).toBe(true);
      expect(loaded.concurrency).toBe(3);
      expect(loaded.taskPollIntervalMs).toBe(1200);
      expect(loaded.interactivePreviewMovements).toBe(2);
      expect(loaded.verbose).toBe(true);
    });

    it('should save migrated fields as snake_case keys', () => {
      const config = {
        logLevel: 'warn',
        pipeline: {
          defaultBranchPrefix: 'task/',
          prBodyTemplate: 'Body {report}',
        },
        personaProviders: {
          reviewer: { provider: 'codex', model: 'gpt-5' },
        },
        branchNameStrategy: 'romaji',
        minimalOutput: true,
        concurrency: 4,
        taskPollIntervalMs: 1500,
        interactivePreviewMovements: 1,
        verbose: false,
      } as ProjectLocalConfig;

      saveProjectConfig(testDir, config);

      const raw = readFileSync(join(testDir, '.takt', 'config.yaml'), 'utf-8');
      expect(raw).toContain('log_level: warn');
      expect(raw).toContain('pipeline:');
      expect(raw).toContain('default_branch_prefix: task/');
      expect(raw).toContain('pr_body_template: Body {report}');
      expect(raw).toContain('persona_providers:');
      expect(raw).toContain('provider: codex');
      expect(raw).toContain('branch_name_strategy: romaji');
      expect(raw).toContain('minimal_output: true');
      expect(raw).toContain('concurrency: 4');
      expect(raw).toContain('task_poll_interval_ms: 1500');
      expect(raw).toContain('interactive_preview_movements: 1');
      expect(raw).not.toContain('verbose: false');
    });

    it('should not persist empty pipeline object on save', () => {
      // Given: empty pipeline object
      const config = {
        pipeline: {},
      } as ProjectLocalConfig;

      // When: project config is saved
      saveProjectConfig(testDir, config);

      // Then: pipeline key is not serialized
      const raw = readFileSync(join(testDir, '.takt', 'config.yaml'), 'utf-8');
      expect(raw).not.toContain('pipeline:');
    });

    it('should not persist empty personaProviders object on save', () => {
      // Given: empty personaProviders object
      const config = {
        personaProviders: {},
      } as ProjectLocalConfig;

      // When: project config is saved
      saveProjectConfig(testDir, config);

      // Then: persona_providers key is not serialized
      const raw = readFileSync(join(testDir, '.takt', 'config.yaml'), 'utf-8');
      expect(raw).not.toContain('persona_providers:');
      expect(raw).not.toContain('personaProviders:');
    });

    it('should not persist schema-injected default values on save', () => {
      const loaded = loadProjectConfig(testDir);
      saveProjectConfig(testDir, loaded);

      const raw = readFileSync(join(testDir, '.takt', 'config.yaml'), 'utf-8');
      expect(raw).not.toContain('log_level: info');
      expect(raw).not.toContain('minimal_output: false');
      expect(raw).not.toContain('concurrency: 1');
      expect(raw).not.toContain('task_poll_interval_ms: 500');
      expect(raw).not.toContain('interactive_preview_movements: 3');
      expect(raw).not.toContain('verbose: false');
    });

    it('should fail fast when project config contains global-only cli path keys', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(
        configPath,
        [
          'claude_cli_path: /tmp/bin/claude',
          'codex_cli_path: /tmp/bin/codex',
          'cursor_cli_path: /tmp/bin/cursor-agent',
          'copilot_cli_path: /tmp/bin/copilot',
        ].join('\n'),
        'utf-8',
      );

      expect(() => loadProjectConfig(testDir)).toThrow(/unrecognized/i);
    });

    it('should fail fast when project config contains other global-only keys', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(
        configPath,
        [
          'language: ja',
          'anthropic_api_key: sk-test',
        ].join('\n'),
        'utf-8',
      );

      expect(() => loadProjectConfig(testDir)).toThrow(/unrecognized/i);
    });
  });

  describe('fail fast validation', () => {
    it('should throw on invalid yaml syntax', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(configPath, 'pipeline: [unclosed', 'utf-8');

      expect(() => loadProjectConfig(testDir)).toThrow(/failed to parse/);
    });

    it('should throw when yaml root is not an object', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(configPath, '- item1\n- item2\n', 'utf-8');

      expect(() => loadProjectConfig(testDir)).toThrow(/must be a YAML object/);
    });

    it('should throw when pipeline has unknown field', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(
        configPath,
        [
          'pipeline:',
          '  default_branch_prefix: "task/"',
          '  unknown_field: "x"',
        ].join('\n'),
        'utf-8',
      );

      expect(() => loadProjectConfig(testDir)).toThrow(/Configuration error: invalid pipeline/);
    });

    it('should throw when pipeline value has invalid type', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(
        configPath,
        [
          'pipeline:',
          '  commit_message_template: 123',
        ].join('\n'),
        'utf-8',
      );

      expect(() => loadProjectConfig(testDir)).toThrow(/Configuration error: invalid pipeline\.commit_message_template/);
    });

    it('should throw when persona_providers entry has unknown field', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(
        configPath,
        [
          'persona_providers:',
          '  coder:',
          '    provider: codex',
          '    unsupported: true',
        ].join('\n'),
        'utf-8',
      );

      expect(() => loadProjectConfig(testDir)).toThrow(/Configuration error: invalid persona_providers\.coder/);
    });

    it('should throw when persona_providers entry has invalid provider', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(
        configPath,
        [
          'persona_providers:',
          '  coder:',
          '    provider: invalid-provider',
        ].join('\n'),
        'utf-8',
      );

      expect(() => loadProjectConfig(testDir)).toThrow(/Configuration error: invalid persona_providers\.coder/);
    });

    it('should throw when persona_providers entry has both provider and type', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(
        configPath,
        [
          'persona_providers:',
          '  coder:',
          '    provider: codex',
          '    type: opencode',
        ].join('\n'),
        'utf-8',
      );

      expect(() => loadProjectConfig(testDir)).toThrow(/Configuration error: invalid persona_providers\.coder/);
    });

    it('should throw when persona_providers entry has codex provider with Claude model alias', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(
        configPath,
        [
          'persona_providers:',
          '  coder:',
          '    provider: codex',
          '    model: opus',
        ].join('\n'),
        'utf-8',
      );

      expect(() => loadProjectConfig(testDir)).toThrow(/Claude model alias/);
    });

    it('should throw when persona_providers entry has opencode provider without model', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(
        configPath,
        [
          'persona_providers:',
          '  reviewer:',
          '    provider: opencode',
        ].join('\n'),
        'utf-8',
      );

      expect(() => loadProjectConfig(testDir)).toThrow(/provider 'opencode' requires model/);
    });

    it('should allow persona_providers entry with opencode provider and provider/model value', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(
        configPath,
        [
          'persona_providers:',
          '  coder:',
          '    provider: opencode',
          '    model: opencode/big-pickle',
        ].join('\n'),
        'utf-8',
      );

      expect(() => loadProjectConfig(testDir)).not.toThrow();
    });
  });

  describe('runtime.prepare round-trip', () => {
    it('should load single preset entry', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(configPath, 'runtime:\n  prepare:\n    - node\n', 'utf-8');

      const loaded = loadProjectConfig(testDir);
      expect(loaded.runtime).toEqual({ prepare: ['node'] });
    });

    it('should load multiple preset entries', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(configPath, 'runtime:\n  prepare:\n    - node\n    - gradle\n', 'utf-8');

      const loaded = loadProjectConfig(testDir);
      expect(loaded.runtime).toEqual({ prepare: ['node', 'gradle'] });
    });

    it('should load custom script paths', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(configPath, 'runtime:\n  prepare:\n    - ./setup.sh\n', 'utf-8');

      const loaded = loadProjectConfig(testDir);
      expect(loaded.runtime).toEqual({ prepare: ['./setup.sh'] });
    });

    it('should round-trip save and load', () => {
      const config: ProjectLocalConfig = {
        runtime: { prepare: ['node'] },
      };

      saveProjectConfig(testDir, config);
      const reloaded = loadProjectConfig(testDir);

      expect(reloaded.runtime).toEqual({ prepare: ['node'] });
    });

    it('should deduplicate entries on load', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(configPath, 'runtime:\n  prepare:\n    - node\n    - node\n', 'utf-8');

      const loaded = loadProjectConfig(testDir);
      expect(loaded.runtime).toEqual({ prepare: ['node'] });
    });

    it('should return undefined when runtime is not specified', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(configPath, '{}\n', 'utf-8');

      const loaded = loadProjectConfig(testDir);
      expect(loaded.runtime).toBeUndefined();
    });

    it('should return undefined when prepare is empty array', () => {
      const configPath = join(testDir, '.takt', 'config.yaml');
      writeFileSync(configPath, 'runtime:\n  prepare: []\n', 'utf-8');

      const loaded = loadProjectConfig(testDir);
      expect(loaded.runtime).toBeUndefined();
    });

    it('should not serialize runtime when config has no runtime', () => {
      const config: ProjectLocalConfig = {};

      saveProjectConfig(testDir, config);

      const raw = readFileSync(join(testDir, '.takt', 'config.yaml'), 'utf-8');
      expect(raw).not.toContain('runtime');
    });

    it('should round-trip mixed presets and custom scripts', () => {
      const config: ProjectLocalConfig = {
        runtime: { prepare: ['node', 'gradle', './custom-setup.sh'] },
      };

      saveProjectConfig(testDir, config);
      const reloaded = loadProjectConfig(testDir);

      expect(reloaded.runtime).toEqual({ prepare: ['node', 'gradle', './custom-setup.sh'] });
    });
  });
});
