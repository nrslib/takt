import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { GlobalConfigManager } from '../infra/config/global/globalConfigCore.js';
import { loadProjectConfig } from '../infra/config/project/projectConfig.js';
import { normalizePieceConfig } from '../infra/config/loaders/pieceParser.js';
import { TaskFileSchema } from '../infra/task/schema.js';
import { resolveWorkflowCliOption } from '../app/cli/helpers.js';
import {
  warnLegacyCategoryYamlKeys,
  warnLegacyGlobalConfigYamlKeys,
  warnLegacyProjectConfigYamlKeys,
  warnLegacyWorkflowYamlKeys,
} from '../infra/config/legacy-workflow-key-deprecation.js';

function messagesFromWarnSpy(warnSpy: ReturnType<typeof vi.spyOn>): string[] {
  return warnSpy.mock.calls.map((call) => String(call[0]));
}

function expectDeprecationShape(msg: string): void {
  expect(msg.startsWith('Deprecated:')).toBe(true);
  expect(msg).toMatch(/is deprecated\./);
  expect(msg).toMatch(/Use .+ instead\./);
}

function expectSomeDeprecation(
  warnSpy: ReturnType<typeof vi.spyOn>,
  predicate: (msg: string) => boolean,
): void {
  const msgs = messagesFromWarnSpy(warnSpy);
  expect(msgs.some(predicate)).toBe(true);
}

const minimalStep = {
  name: 'plan',
  persona: 'coder',
  instruction: '{task}',
  rules: [{ condition: 'done', next: 'COMPLETE' }],
};

let testGlobalConfigPath: string;

vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigPath: () => testGlobalConfigPath,
  getGlobalTaktDir: () => join(testGlobalConfigPath, '..'),
  getProjectTaktDir: vi.fn(),
  getProjectCwd: vi.fn(),
}));

describe('legacy piece/movement deprecation warnings (#581)', () => {
  describe('GlobalConfigManager.load', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = mkdtempSync(join(tmpdir(), 'takt-581-global-warn-'));
      mkdirSync(testDir, { recursive: true });
      testGlobalConfigPath = join(testDir, 'config.yaml');
      GlobalConfigManager.resetInstance();
    });

    afterEach(() => {
      GlobalConfigManager.resetInstance();
      if (testDir) {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should warn with deprecation shape when enable_builtin_pieces is used without enable_builtin_workflows', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        testGlobalConfigPath,
        ['enable_builtin_pieces: true'].join('\n'),
        'utf-8',
      );

      GlobalConfigManager.getInstance().load();

      expectSomeDeprecation(
        warnSpy,
        (m) =>
          m.includes('enable_builtin_pieces')
          && m.includes('enable_builtin_workflows'),
      );
      for (const m of messagesFromWarnSpy(warnSpy)) {
        expectDeprecationShape(m);
      }
      warnSpy.mockRestore();
    });

    it('should not warn for enable_builtin_workflows when legacy enable_builtin_pieces is absent', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        testGlobalConfigPath,
        ['enable_builtin_workflows: true'].join('\n'),
        'utf-8',
      );

      GlobalConfigManager.getInstance().load();

      expect(
        messagesFromWarnSpy(warnSpy).some((m) => m.includes('enable_builtin_pieces')),
      ).toBe(false);
      warnSpy.mockRestore();
    });

    it('should warn for enable_builtin_pieces when enable_builtin_workflows is also set (PR #582: canonical does not suppress)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        testGlobalConfigPath,
        ['enable_builtin_pieces: true', 'enable_builtin_workflows: true'].join('\n'),
        'utf-8',
      );

      GlobalConfigManager.getInstance().load();

      expectSomeDeprecation(
        warnSpy,
        (m) =>
          m.includes('enable_builtin_pieces')
          && m.includes('enable_builtin_workflows'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when piece_categories_file is set without workflow_categories_file', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        testGlobalConfigPath,
        ['piece_categories_file: categories.yaml'].join('\n'),
        'utf-8',
      );

      GlobalConfigManager.getInstance().load();

      expectSomeDeprecation(
        warnSpy,
        (m) =>
          m.includes('piece_categories_file')
          && m.includes('workflow_categories_file'),
      );
      warnSpy.mockRestore();
    });

    it('should warn for piece_categories_file when workflow_categories_file is also set to the same path (PR #582)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        testGlobalConfigPath,
        [
          'piece_categories_file: categories.yaml',
          'workflow_categories_file: categories.yaml',
        ].join('\n'),
        'utf-8',
      );

      GlobalConfigManager.getInstance().load();

      expectSomeDeprecation(
        warnSpy,
        (m) =>
          m.includes('piece_categories_file')
          && m.includes('workflow_categories_file'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when notification_sound_events uses piece_complete without workflow_complete', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        testGlobalConfigPath,
        ['notification_sound_events:', '  piece_complete: true'].join('\n'),
        'utf-8',
      );

      GlobalConfigManager.getInstance().load();

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('piece_complete') && m.includes('workflow_complete'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when notification_sound_events uses piece_abort without workflow_abort', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        testGlobalConfigPath,
        ['notification_sound_events:', '  piece_abort: true'].join('\n'),
        'utf-8',
      );

      GlobalConfigManager.getInstance().load();

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('piece_abort') && m.includes('workflow_abort'),
      );
      warnSpy.mockRestore();
    });

    it('should warn for notification_sound_events piece_complete when workflow_complete is also set (PR #582)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        testGlobalConfigPath,
        [
          'notification_sound_events:',
          '  piece_complete: true',
          '  workflow_complete: true',
        ].join('\n'),
        'utf-8',
      );

      GlobalConfigManager.getInstance().load();

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('piece_complete') && m.includes('workflow_complete'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when piece_overrides is set without workflow_overrides', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        testGlobalConfigPath,
        [
          'piece_overrides:',
          '  quality_gates:',
          '    - Gate',
        ].join('\n'),
        'utf-8',
      );

      GlobalConfigManager.getInstance().load();

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('piece_overrides') && m.includes('workflow_overrides'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when piece_runtime_prepare is set without workflow_runtime_prepare', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        testGlobalConfigPath,
        ['piece_runtime_prepare:', '  custom_scripts: true'].join('\n'),
        'utf-8',
      );

      GlobalConfigManager.getInstance().load();

      expectSomeDeprecation(
        warnSpy,
        (m) =>
          m.includes('piece_runtime_prepare')
          && m.includes('workflow_runtime_prepare'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when piece_arpeggio is set without workflow_arpeggio', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        testGlobalConfigPath,
        ['piece_arpeggio:', '  custom_data_source_modules: true'].join('\n'),
        'utf-8',
      );

      GlobalConfigManager.getInstance().load();

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('piece_arpeggio') && m.includes('workflow_arpeggio'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when piece_mcp_servers is set without workflow_mcp_servers', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        testGlobalConfigPath,
        ['piece_mcp_servers:', '  stdio: true'].join('\n'),
        'utf-8',
      );

      GlobalConfigManager.getInstance().load();

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('piece_mcp_servers') && m.includes('workflow_mcp_servers'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when interactive_preview_movements is set without interactive_preview_steps', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        testGlobalConfigPath,
        ['interactive_preview_movements: 2'].join('\n'),
        'utf-8',
      );

      GlobalConfigManager.getInstance().load();

      expectSomeDeprecation(
        warnSpy,
        (m) =>
          m.includes('interactive_preview_movements')
          && m.includes('interactive_preview_steps'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when global workflow_overrides uses movements without steps (#581 nested overrides)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        testGlobalConfigPath,
        [
          'workflow_overrides:',
          '  movements:',
          '    plan:',
          '      quality_gates:',
          '        - Gate',
        ].join('\n'),
        'utf-8',
      );

      GlobalConfigManager.getInstance().load();

      expectSomeDeprecation(
        warnSpy,
        (m) =>
          m.includes('movements')
          && m.includes('steps')
          && m.includes('workflow_overrides'),
      );
      warnSpy.mockRestore();
    });

    it('should not repeat the same deprecation message when warnLegacyGlobalConfigYamlKeys runs twice with a shared seen set', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const seen = new Set<string>();
      const parsed: Record<string, unknown> = { enable_builtin_pieces: true };

      warnLegacyGlobalConfigYamlKeys(parsed, seen);
      expect(warnSpy.mock.calls.length).toBe(1);

      warnLegacyGlobalConfigYamlKeys(parsed, seen);
      expect(warnSpy.mock.calls.length).toBe(1);

      warnSpy.mockRestore();
    });
  });

  describe('loadProjectConfig', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(tmpdir(), `takt-581-project-warn-${randomUUID()}`);
      mkdirSync(join(testDir, '.takt'), { recursive: true });
    });

    afterEach(() => {
      if (testDir) {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should warn when piece_overrides is present without workflow_overrides', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        join(testDir, '.takt', 'config.yaml'),
        [
          'piece_overrides:',
          '  quality_gates:',
          '    - Gate',
        ].join('\n'),
        'utf-8',
      );

      loadProjectConfig(testDir);

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('piece_overrides') && m.includes('workflow_overrides'),
      );
      warnSpy.mockRestore();
    });

    it('should not warn for workflow_overrides alone', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        join(testDir, '.takt', 'config.yaml'),
        [
          'workflow_overrides:',
          '  quality_gates:',
          '    - Gate',
        ].join('\n'),
        'utf-8',
      );

      loadProjectConfig(testDir);

      expect(
        messagesFromWarnSpy(warnSpy).some((m) => m.includes('piece_overrides')),
      ).toBe(false);
      warnSpy.mockRestore();
    });

    it('should warn when provider_profiles use movement_permission_overrides without step_permission_overrides', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        join(testDir, '.takt', 'config.yaml'),
        [
          'provider_profiles:',
          '  codex:',
          '    default_permission_mode: full',
          '    movement_permission_overrides:',
          '      implement: full',
        ].join('\n'),
        'utf-8',
      );

      loadProjectConfig(testDir);

      expectSomeDeprecation(
        warnSpy,
        (m) =>
          m.includes('movement_permission_overrides')
          && m.includes('step_permission_overrides'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when piece_runtime_prepare is legacy-only in project config', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        join(testDir, '.takt', 'config.yaml'),
        ['piece_runtime_prepare:', '  custom_scripts: true'].join('\n'),
        'utf-8',
      );

      loadProjectConfig(testDir);

      expectSomeDeprecation(
        warnSpy,
        (m) =>
          m.includes('piece_runtime_prepare')
          && m.includes('workflow_runtime_prepare'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when piece_arpeggio is legacy-only in project config', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        join(testDir, '.takt', 'config.yaml'),
        ['piece_arpeggio:', '  custom_merge_files: true'].join('\n'),
        'utf-8',
      );

      loadProjectConfig(testDir);

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('piece_arpeggio') && m.includes('workflow_arpeggio'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when piece_mcp_servers is legacy-only in project config', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        join(testDir, '.takt', 'config.yaml'),
        ['piece_mcp_servers:', '  http: true'].join('\n'),
        'utf-8',
      );

      loadProjectConfig(testDir);

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('piece_mcp_servers') && m.includes('workflow_mcp_servers'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when workflow_overrides uses movements without steps (#581 nested overrides)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        join(testDir, '.takt', 'config.yaml'),
        [
          'workflow_overrides:',
          '  movements:',
          '    plan:',
          '      quality_gates:',
          '        - Gate',
        ].join('\n'),
        'utf-8',
      );

      loadProjectConfig(testDir);

      expectSomeDeprecation(
        warnSpy,
        (m) =>
          m.includes('movements')
          && m.includes('steps')
          && m.includes('workflow_overrides'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when piece_overrides uses movements without steps (#581 nested overrides)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(
        join(testDir, '.takt', 'config.yaml'),
        [
          'piece_overrides:',
          '  movements:',
          '    plan:',
          '      quality_gates:',
          '        - Gate',
        ].join('\n'),
        'utf-8',
      );

      loadProjectConfig(testDir);

      expectSomeDeprecation(
        warnSpy,
        (m) =>
          m.includes('movements')
          && m.includes('steps')
          && m.includes('piece_overrides'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('normalizePieceConfig (workflow YAML)', () => {
    it('should warn when raw YAML uses movements without steps', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const raw = {
        name: 'wf-legacy-movements',
        movements: [minimalStep],
        initial_movement: 'plan',
      };

      normalizePieceConfig(raw, process.cwd());

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('movements') && m.includes('steps'),
      );
      warnSpy.mockRestore();
    });

    it('should not warn when raw YAML uses steps and initial_step only', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const raw = {
        name: 'wf-canonical',
        steps: [minimalStep],
        initial_step: 'plan',
      };

      normalizePieceConfig(raw, process.cwd());

      const msgs = messagesFromWarnSpy(warnSpy);
      expect(
        msgs.some(
          (m) =>
            (m.includes('movements') && m.includes('steps'))
            || (m.includes('initial_movement') && m.includes('initial_step')),
        ),
      ).toBe(false);
      warnSpy.mockRestore();
    });

    it('should warn for initial_movement when steps are canonical but initial_step is absent', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const raw = {
        name: 'wf-mixed-initial',
        steps: [minimalStep],
        initial_movement: 'plan',
      };

      normalizePieceConfig(raw, process.cwd());

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('initial_movement') && m.includes('initial_step'),
      );
      expect(
        messagesFromWarnSpy(warnSpy).some(
          (m) =>
            m.startsWith('Deprecated:')
            && m.includes('movements')
            && m.includes('steps'),
        ),
      ).toBe(false);
      warnSpy.mockRestore();
    });

    it('should warn for movements vs steps when both keys are present on raw input (PR #582)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const raw = {
        name: 'wf-both-movements-steps',
        movements: [minimalStep],
        steps: [minimalStep],
        initial_step: 'plan',
      };

      normalizePieceConfig(raw, process.cwd());

      expectSomeDeprecation(
        warnSpy,
        (m) =>
          m.startsWith('Deprecated:')
          && m.includes('movements')
          && m.includes('steps')
          && !m.includes('workflow_overrides')
          && !m.includes('piece_overrides'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when raw YAML uses piece_config without workflow_config', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const raw = {
        name: 'wf-legacy-piece-config',
        piece_config: {},
        movements: [minimalStep],
        initial_movement: 'plan',
      };

      normalizePieceConfig(raw, process.cwd());

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('piece_config') && m.includes('workflow_config'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when raw YAML uses max_movements without max_steps', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const raw = {
        name: 'wf-legacy-max-movements',
        movements: [minimalStep],
        initial_movement: 'plan',
        max_movements: 7,
      };

      normalizePieceConfig(raw, process.cwd());

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('max_movements') && m.includes('max_steps'),
      );
      warnSpy.mockRestore();
    });

    it('should not emit duplicate identical deprecation messages for one parse with parallel children using step', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const raw = {
        name: 'wf-parallel-step-alias',
        movements: [
          {
            name: 'review',
            parallel: [
              {
                step: 'arch-review',
                persona: 'coder',
                instruction: 'Review A',
                rules: [{ condition: 'done', next: 'COMPLETE' }],
              },
              {
                step: 'sec-review',
                persona: 'coder',
                instruction: 'Review B',
                rules: [{ condition: 'done', next: 'COMPLETE' }],
              },
            ],
            rules: [{ condition: 'done', next: 'COMPLETE' }],
          },
        ],
        initial_movement: 'review',
      };

      normalizePieceConfig(raw, process.cwd());

      expectSomeDeprecation(
        warnSpy,
        (m) =>
          m.includes('step')
          && (m.includes('name') || m.includes('parallel')),
      );
      const texts = messagesFromWarnSpy(warnSpy);
      const seen = new Set<string>();
      for (const t of texts) {
        expect(seen.has(t)).toBe(false);
        seen.add(t);
      }
      warnSpy.mockRestore();
    });
  });

  describe('warnLegacyCategoryYamlKeys (#581 category YAML)', () => {
    it('should warn when only piece_categories root key is present', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      warnLegacyCategoryYamlKeys(
        { piece_categories: { Dev: { workflows: ['a'] } } },
        new Set(),
      );
      expectSomeDeprecation(
        warnSpy,
        (m) =>
          m.includes('piece_categories') && m.includes('workflow_categories'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when a category node uses pieces without workflows', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      warnLegacyCategoryYamlKeys(
        { workflow_categories: { Dev: { pieces: ['x'] } } },
        new Set(),
      );
      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('pieces') && m.includes('workflows') && m.includes('Dev'),
      );
      warnSpy.mockRestore();
    });

    it('should warn for root piece_categories when workflow_categories is also present (PR #582)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      warnLegacyCategoryYamlKeys(
        {
          piece_categories: { A: { workflows: ['w'] } },
          workflow_categories: { B: { workflows: ['x'] } },
        },
        new Set(),
      );
      expectSomeDeprecation(
        warnSpy,
        (m) =>
          m.includes('piece_categories')
          && m.includes('workflow_categories'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('warnLegacyWorkflowYamlKeys (raw workflow object)', () => {
    it('should warn for parallel sub-object step without name', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      warnLegacyWorkflowYamlKeys(
        {
          name: 'wf',
          steps: [
            {
              name: 'parent',
              parallel: [
                {
                  step: 'sub-a',
                  persona: 'coder',
                  instruction: 'x',
                  rules: [{ condition: 'done', next: 'COMPLETE' }],
                },
              ],
              rules: [{ condition: 'done', next: 'COMPLETE' }],
            },
          ],
          initial_step: 'parent',
        },
        new Set(),
      );
      expectSomeDeprecation(
        warnSpy,
        (m) =>
          m.includes('step')
          && m.includes('name')
          && m.includes('parallel'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('TaskFileSchema (task payloads)', () => {
    it('should warn when task data uses piece without workflow', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      TaskFileSchema.parse({ task: 'do work', piece: 'default' });

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('piece') && m.includes('workflow'),
      );
      warnSpy.mockRestore();
    });

    it('should not warn when task data uses workflow only', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      TaskFileSchema.parse({ task: 'do work', workflow: 'default' });

      expect(
        messagesFromWarnSpy(warnSpy).some(
          (m) => m.includes('piece') && m.includes('workflow') && m.startsWith('Deprecated:'),
        ),
      ).toBe(false);
      warnSpy.mockRestore();
    });

    it('should warn for piece when workflow is set to the same value (PR #582)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      TaskFileSchema.parse({
        task: 'do work',
        piece: 'default',
        workflow: 'default',
      });

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('piece') && m.includes('workflow'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when task data uses start_movement without start_step', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      TaskFileSchema.parse({ task: 'do work', start_movement: 'plan' });

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('start_movement') && m.includes('start_step'),
      );
      warnSpy.mockRestore();
    });

    it('should warn for start_movement when start_step is set to the same value (PR #582)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      TaskFileSchema.parse({
        task: 'do work',
        start_movement: 'plan',
        start_step: 'plan',
      });

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('start_movement') && m.includes('start_step'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when task data uses exceeded_max_movements without exceeded_max_steps (#581)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      TaskFileSchema.parse({
        task: 'do work',
        exceeded_max_movements: 12,
        exceeded_current_iteration: 3,
      });

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('exceeded_max_movements') && m.includes('exceeded_max_steps'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when task data sets exceeded_max_movements even when exceeded_max_steps matches (PR #582)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      TaskFileSchema.parse({
        task: 'do work',
        exceeded_max_movements: 12,
        exceeded_max_steps: 12,
        exceeded_current_iteration: 3,
      });

      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('exceeded_max_movements') && m.includes('exceeded_max_steps'),
      );
      warnSpy.mockRestore();
    });

    it('should not deprecate exceeded when only exceeded_max_steps is set (#581)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      TaskFileSchema.parse({
        task: 'do work',
        exceeded_max_steps: 12,
        exceeded_current_iteration: 3,
      });

      expect(
        messagesFromWarnSpy(warnSpy).some(
          (m) => m.includes('exceeded_max_movements') && m.startsWith('Deprecated:'),
        ),
      ).toBe(false);
      warnSpy.mockRestore();
    });
  });

  describe('global vs project legacy piece_* top-level warnings (#581 DRY)', () => {
    it('should emit identical piece_* top-level deprecation messages for the same parsed keys', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const parsed: Record<string, unknown> = {
        piece_overrides: { quality_gates: ['g'] },
        piece_runtime_prepare: { custom_scripts: true },
        piece_arpeggio: { custom_merge_files: true },
        piece_mcp_servers: { http: true },
      };
      warnLegacyGlobalConfigYamlKeys(parsed, new Set());
      const fromGlobal = [...messagesFromWarnSpy(warnSpy)].sort();
      warnSpy.mockClear();
      warnLegacyProjectConfigYamlKeys(parsed, new Set());
      const fromProject = [...messagesFromWarnSpy(warnSpy)].sort();
      expect(fromGlobal.length).toBe(4);
      expect(fromProject.length).toBe(4);
      expect(fromGlobal).toEqual(fromProject);
      warnSpy.mockRestore();
    });
  });

  describe('resolveWorkflowCliOption', () => {
    it('should warn when opts use piece without workflow', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const resolved = resolveWorkflowCliOption({ piece: 'default' });

      expect(resolved).toBe('default');
      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('piece') && m.includes('workflow'),
      );
      warnSpy.mockRestore();
    });

    it('should not warn when opts use workflow only', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const resolved = resolveWorkflowCliOption({ workflow: 'default' });

      expect(resolved).toBe('default');
      expect(
        messagesFromWarnSpy(warnSpy).some(
          (m) => m.includes('--piece') || (m.includes('piece') && m.startsWith('Deprecated:')),
        ),
      ).toBe(false);
      warnSpy.mockRestore();
    });

    it('should warn when opts use piece together with workflow at the same value (PR #582)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const resolved = resolveWorkflowCliOption({ piece: 'default', workflow: 'default' });

      expect(resolved).toBe('default');
      expectSomeDeprecation(
        warnSpy,
        (m) => m.includes('piece') && m.includes('workflow'),
      );
      warnSpy.mockRestore();
    });
  });
});
