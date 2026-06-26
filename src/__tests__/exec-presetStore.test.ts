import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecConfig } from '../features/exec/types.js';
import {
  loadExecPreset,
  loadExecPresetFromSource,
  loadLastUsedExecConfig,
  deleteExecPreset,
  listExecPresets,
  listExecPresetsBySource,
  saveLastUsedExecConfig,
  saveExecPreset,
  validateExecPresetName,
} from '../features/exec/presetStore.js';

function createExecConfig(instruction: string): ExecConfig {
  return {
    session: {
      provider: 'claude',
      model: 'opus',
      effort: 'high',
    },
    replan: {
      instruction: 'exec-replan',
      knowledge: ['architecture'],
      policy: [],
    },
    workers: [
      {
        name: 'worker-1',
        provider: 'claude',
        model: 'sonnet',
        effort: 'high',
        instruction,
        knowledge: ['architecture'],
        policy: ['coding', 'testing'],
      },
    ],
    judges: [
      {
        name: 'judge-1',
        provider: 'claude',
        model: 'opus',
        effort: 'high',
        instruction: 'exec-judge',
        knowledge: ['architecture'],
        policy: ['review'],
      },
    ],
    loop: {
      smallThreshold: 3,
      largeThreshold: 2,
      maxSteps: 20,
    },
  };
}

function writePreset(dir: string, name: string, config: ExecConfig, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.yaml`),
    [
      `name: ${name}`,
      `description: ${description}`,
      `session:`,
      `  provider: ${config.session.provider}`,
      `  model: ${config.session.model}`,
      `  effort: ${config.session.effort}`,
      `replan:`,
      `  instruction: ${config.replan.instruction}`,
      `  knowledge:`,
      ...config.replan.knowledge.map((entry) => `    - ${entry}`),
      `  policy: []`,
      `workers:`,
      `  - name: ${config.workers[0]!.name}`,
      `    provider: ${config.workers[0]!.provider}`,
      `    model: ${config.workers[0]!.model}`,
      `    effort: ${config.workers[0]!.effort}`,
      `    instruction: ${config.workers[0]!.instruction}`,
      `    knowledge:`,
      ...config.workers[0]!.knowledge.map((entry) => `      - ${entry}`),
      `    policy:`,
      ...config.workers[0]!.policy.map((entry) => `      - ${entry}`),
      `judges:`,
      `  - name: ${config.judges[0]!.name}`,
      `    provider: ${config.judges[0]!.provider}`,
      `    model: ${config.judges[0]!.model}`,
      `    effort: ${config.judges[0]!.effort}`,
      `    instruction: ${config.judges[0]!.instruction}`,
      `    knowledge:`,
      ...config.judges[0]!.knowledge.map((entry) => `      - ${entry}`),
      `    policy:`,
      ...config.judges[0]!.policy.map((entry) => `      - ${entry}`),
      `loop:`,
      `  threshold: ${config.loop.smallThreshold}`,
      `  large_threshold: ${config.loop.largeThreshold}`,
      `  max_steps: ${config.loop.maxSteps}`,
    ].join('\n'),
  );
}

function writeRawPreset(dir: string, name: string, yaml: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), yaml);
}

describe('exec preset store', () => {
  it('should reject preset names that are not bare names', () => {
    const invalidNames = ['', '../backend', 'nested/backend', 'nested\\backend', '/tmp/backend', 'backend.yaml'];

    for (const name of invalidNames) {
      expect(() => validateExecPresetName(name)).toThrow(/preset name/i);
    }
  });

  it('should resolve project presets before global and builtin presets', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-project-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-global-'));
    const builtinPresetsDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-builtin-'));
    try {
      writePreset(join(builtinPresetsDir), 'backend', createExecConfig('builtin-worker'), 'builtin');
      writePreset(join(globalConfigDir, 'exec', 'presets'), 'backend', createExecConfig('global-worker'), 'global');
      writePreset(join(projectDir, '.takt', 'exec', 'presets'), 'backend', createExecConfig('project-worker'), 'project');
      const result = loadExecPreset('backend', {
        projectDir,
        globalConfigDir,
        builtinPresetsDir,
      });
      expect(result.source).toBe('project');
      expect(result.config.workers[0]?.instruction).toBe('project-worker');
      expect(result.description).toBe('project');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
      rmSync(builtinPresetsDir, { recursive: true, force: true });
    }
  });

  it('should not parse lower-priority duplicate presets during list resolution', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-list-project-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-list-global-'));
    const builtinPresetsDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-list-builtin-'));
    try {
      writePreset(join(projectDir, '.takt', 'exec', 'presets'), 'backend', createExecConfig('project-worker'), 'project');
      writeRawPreset(join(globalConfigDir, 'exec', 'presets'), 'backend', 'name: backend\nworkers: {}\n');
      writeRawPreset(join(builtinPresetsDir), 'backend', 'name: backend\nworkers: {}\n');

      const presets = listExecPresets({ projectDir, globalConfigDir, builtinPresetsDir });
      const backendPreset = presets.find((preset) => preset.name === 'backend');

      expect(backendPreset?.source).toBe('project');
      expect(backendPreset?.config.workers[0]?.instruction).toBe('project-worker');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
      rmSync(builtinPresetsDir, { recursive: true, force: true });
    }
  });

  it('should not list a lower-priority preset shadowed by an invalid higher-priority preset', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-shadow-project-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-shadow-global-'));
    const builtinPresetsDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-shadow-builtin-'));
    try {
      writeRawPreset(join(projectDir, '.takt', 'exec', 'presets'), 'backend', 'name: wrong-name\n');
      writePreset(join(builtinPresetsDir), 'backend', createExecConfig('builtin-worker'), 'builtin');
      writePreset(join(builtinPresetsDir), 'frontend', createExecConfig('frontend-worker'), 'frontend');

      const presets = listExecPresets({ projectDir, globalConfigDir, builtinPresetsDir });

      expect(presets.map((preset) => preset.name)).toEqual(['frontend']);
      expect(() => loadExecPreset('backend', { projectDir, globalConfigDir, builtinPresetsDir })).toThrow(
        /name "wrong-name" must match filename "backend"/,
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
      rmSync(builtinPresetsDir, { recursive: true, force: true });
    }
  });

  it('should resolve presets from the provided global config dir instead of the ambient config dir', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-ambient-project-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-ambient-global-'));
    const ambientConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-ambient-real-global-'));
    const builtinPresetsDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-ambient-builtin-'));
    const originalConfigDir = process.env.TAKT_CONFIG_DIR;
    try {
      process.env.TAKT_CONFIG_DIR = ambientConfigDir;
      writePreset(join(globalConfigDir, 'exec', 'presets'), 'backend', createExecConfig('isolated-global-worker'), 'global');
      writePreset(join(ambientConfigDir, 'exec', 'presets'), 'backend', createExecConfig('ambient-global-worker'), 'ambient');
      writePreset(join(builtinPresetsDir), 'backend', createExecConfig('builtin-worker'), 'builtin');

      const result = loadExecPreset('backend', { projectDir, globalConfigDir, builtinPresetsDir });

      expect(result.source).toBe('global');
      expect(result.config.workers[0]?.instruction).toBe('isolated-global-worker');
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.TAKT_CONFIG_DIR;
      } else {
        process.env.TAKT_CONFIG_DIR = originalConfigDir;
      }
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
      rmSync(ambientConfigDir, { recursive: true, force: true });
      rmSync(builtinPresetsDir, { recursive: true, force: true });
    }
  });

  it('should list and load duplicate preset names by explicit source', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-source-project-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-source-global-'));
    const builtinPresetsDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-source-builtin-'));
    try {
      writePreset(join(builtinPresetsDir), 'backend', createExecConfig('builtin-worker'), 'builtin');
      writePreset(join(globalConfigDir, 'exec', 'presets'), 'backend', createExecConfig('global-worker'), 'global');
      writePreset(join(projectDir, '.takt', 'exec', 'presets'), 'backend', createExecConfig('project-worker'), 'project');

      const globalPresets = listExecPresetsBySource('global', { projectDir, globalConfigDir, builtinPresetsDir });
      const globalPreset = loadExecPresetFromSource('backend', 'global', { projectDir, globalConfigDir, builtinPresetsDir });

      expect(globalPresets.map((preset) => preset.name)).toEqual(['backend']);
      expect(globalPreset.source).toBe('global');
      expect(globalPreset.config.workers[0]?.instruction).toBe('global-worker');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
      rmSync(builtinPresetsDir, { recursive: true, force: true });
    }
  });

  it('should parse the public preset yaml loop threshold format', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-threshold-preset-'));
    const presetDir = join(projectDir, '.takt', 'exec', 'presets');
    try {
      writeRawPreset(presetDir, 'threshold-team', [
        'name: threshold-team',
        'description: Threshold team',
        'session:',
        '  provider: claude',
        '  model: opus',
        '  effort: high',
        'replan:',
        '  instruction: exec-replan',
        '  knowledge: []',
        '  policy: []',
        'workers:',
        '  - name: worker-1',
        '    provider: claude',
        '    model: sonnet',
        '    effort: high',
        '    instruction: exec-worker',
        '    knowledge: []',
        '    policy: []',
        'judges:',
        '  - name: judge-1',
        '    provider: claude',
        '    model: opus',
        '    effort: high',
        '    instruction: exec-judge',
        '    knowledge: []',
        '    policy: []',
        'loop:',
        '  threshold: 4',
        '  large_threshold: 3',
        '  max_steps: 20',
      ].join('\n'));

      const preset = loadExecPreset('threshold-team', { projectDir });

      expect(preset.config.loop.smallThreshold).toBe(4);
      expect(preset.config.loop.largeThreshold).toBe(3);
      expect(preset.config.loop.maxSteps).toBe(20);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('should reject preset yaml when large_threshold is missing', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-missing-large-'));
    const presetDir = join(projectDir, '.takt', 'exec', 'presets');
    try {
      writeRawPreset(presetDir, 'missing-large', [
        'name: missing-large',
        'description: Missing large threshold',
        'session:',
        '  provider: claude',
        '  model: opus',
        '  effort: high',
        'replan:',
        '  instruction: exec-replan',
        '  knowledge: []',
        '  policy: []',
        'workers:',
        '  - name: worker-1',
        '    provider: claude',
        '    model: sonnet',
        '    effort: high',
        '    instruction: exec-worker',
        '    knowledge: []',
        '    policy: []',
        'judges:',
        '  - name: judge-1',
        '    provider: claude',
        '    model: opus',
        '    effort: high',
        '    instruction: exec-judge',
        '    knowledge: []',
        '    policy: []',
        'loop:',
        '  threshold: 4',
        '  max_steps: 20',
      ].join('\n'));

      expect(() => loadExecPreset('missing-large', { projectDir })).toThrow(
        'exec.loop.large_threshold',
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('should save and reload the last used exec config from the global exec yaml', () => {
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-last-used-'));
    const config = createExecConfig('last-used-worker');
    try {
      saveLastUsedExecConfig(config, { globalConfigDir });
      const loaded = loadLastUsedExecConfig({ globalConfigDir });
      const raw = readFileSync(join(globalConfigDir, 'exec.yaml'), 'utf-8');
      expect(raw).toContain('session:');
      expect(raw).toContain('workers:');
      expect(raw).toContain('judges:');
      expect(loaded).toEqual(config);
    } finally {
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('should save and delete project exec presets', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-project-preset-'));
    const config = createExecConfig('saved-worker');
    try {
      saveExecPreset('custom', 'Custom preset', config, { projectDir, scope: 'project' });
      const presetPath = join(projectDir, '.takt', 'exec', 'presets', 'custom.yaml');
      const loaded = loadExecPreset('custom', { projectDir });
      expect(existsSync(presetPath)).toBe(true);
      expect(loaded.source).toBe('project');
      expect(loaded.description).toBe('Custom preset');
      expect(loaded.config).toEqual(config);

      deleteExecPreset('custom', { projectDir, scope: 'project' });
      expect(existsSync(presetPath)).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('should reject project exec preset writes when the target is a symlink', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-project-preset-symlink-'));
    const externalDir = mkdtempSync(join(tmpdir(), 'takt-exec-project-preset-external-'));
    const externalTarget = join(externalDir, 'custom.yaml');
    const presetDir = join(projectDir, '.takt', 'exec', 'presets');
    const config = createExecConfig('saved-worker');
    try {
      mkdirSync(presetDir, { recursive: true });
      writeFileSync(externalTarget, 'external preset', 'utf-8');
      symlinkSync(externalTarget, join(presetDir, 'custom.yaml'));

      expect(() => saveExecPreset('custom', 'Custom preset', config, { projectDir, scope: 'project' }))
        .toThrow(/Project-local exec preset/);
      expect(readFileSync(externalTarget, 'utf-8')).toBe('external preset');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('should reject project exec preset writes when the preset directory is a symlink', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-project-preset-dir-symlink-'));
    const externalDir = mkdtempSync(join(tmpdir(), 'takt-exec-project-preset-dir-external-'));
    const config = createExecConfig('saved-worker');
    try {
      mkdirSync(join(projectDir, '.takt', 'exec'), { recursive: true });
      symlinkSync(externalDir, join(projectDir, '.takt', 'exec', 'presets'));

      expect(() => saveExecPreset('custom', 'Custom preset', config, { projectDir, scope: 'project' }))
        .toThrow(/Project-local exec preset/);
      expect(existsSync(join(externalDir, 'custom.yaml'))).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('should reject project exec preset load, list, and delete when the preset file is a symlink', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-project-preset-read-symlink-'));
    const externalDir = mkdtempSync(join(tmpdir(), 'takt-exec-project-preset-read-external-'));
    const externalTarget = join(externalDir, 'custom.yaml');
    const presetDir = join(projectDir, '.takt', 'exec', 'presets');
    try {
      mkdirSync(presetDir, { recursive: true });
      writeFileSync(externalTarget, 'name: custom\ndescription: external\n', 'utf-8');
      symlinkSync(externalTarget, join(presetDir, 'custom.yaml'));

      expect(() => loadExecPreset('custom', { projectDir })).toThrow(/Project-local exec preset/);
      expect(() => loadExecPresetFromSource('custom', 'project', { projectDir })).toThrow(/Project-local exec preset/);
      expect(() => listExecPresets({ projectDir })).toThrow(/Project-local exec preset/);
      expect(() => deleteExecPreset('custom', { projectDir, scope: 'project' })).toThrow(/Project-local exec preset/);
      expect(readFileSync(externalTarget, 'utf-8')).toBe('name: custom\ndescription: external\n');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('should reject project exec preset load when a broken preset file symlink shadows a lower-priority preset', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-project-preset-broken-symlink-'));
    const externalDir = mkdtempSync(join(tmpdir(), 'takt-exec-project-preset-broken-external-'));
    const builtinPresetsDir = mkdtempSync(join(tmpdir(), 'takt-exec-project-preset-broken-builtin-'));
    const presetDir = join(projectDir, '.takt', 'exec', 'presets');
    try {
      mkdirSync(presetDir, { recursive: true });
      writePreset(builtinPresetsDir, 'custom', createExecConfig('builtin-worker'), 'builtin');
      symlinkSync(join(externalDir, 'missing.yaml'), join(presetDir, 'custom.yaml'));

      expect(() => loadExecPreset('custom', { projectDir, builtinPresetsDir })).toThrow(/Project-local exec preset/);
      expect(() => loadExecPresetFromSource('custom', 'project', { projectDir, builtinPresetsDir }))
        .toThrow(/Project-local exec preset/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(externalDir, { recursive: true, force: true });
      rmSync(builtinPresetsDir, { recursive: true, force: true });
    }
  });

  it('should reject project exec preset load, list, and delete when the preset directory is a symlink', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-project-preset-read-dir-symlink-'));
    const externalDir = mkdtempSync(join(tmpdir(), 'takt-exec-project-preset-read-dir-external-'));
    const externalPresetPath = join(externalDir, 'custom.yaml');
    try {
      mkdirSync(join(projectDir, '.takt', 'exec'), { recursive: true });
      writePreset(externalDir, 'custom', createExecConfig('external-worker'), 'external');
      symlinkSync(externalDir, join(projectDir, '.takt', 'exec', 'presets'));

      expect(() => loadExecPreset('custom', { projectDir })).toThrow(/Project-local exec preset/);
      expect(() => loadExecPresetFromSource('custom', 'project', { projectDir })).toThrow(/Project-local exec preset/);
      expect(() => listExecPresets({ projectDir })).toThrow(/Project-local exec preset/);
      expect(() => listExecPresetsBySource('project', { projectDir })).toThrow(/Project-local exec preset/);
      expect(() => deleteExecPreset('custom', { projectDir, scope: 'project' })).toThrow(/Project-local exec preset/);
      expect(existsSync(externalPresetPath)).toBe(true);
      expect(readFileSync(externalPresetPath, 'utf-8')).toContain('external-worker');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('should reject project exec preset load when a preset directory symlink lacks the preset but lower-priority sources have it', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-project-preset-missing-dir-symlink-'));
    const externalDir = mkdtempSync(join(tmpdir(), 'takt-exec-project-preset-missing-dir-external-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-project-preset-missing-dir-global-'));
    const builtinPresetsDir = mkdtempSync(join(tmpdir(), 'takt-exec-project-preset-missing-dir-builtin-'));
    try {
      mkdirSync(join(projectDir, '.takt', 'exec'), { recursive: true });
      symlinkSync(externalDir, join(projectDir, '.takt', 'exec', 'presets'));
      writePreset(join(globalConfigDir, 'exec', 'presets'), 'custom', createExecConfig('global-worker'), 'global');
      writePreset(builtinPresetsDir, 'custom', createExecConfig('builtin-worker'), 'builtin');

      expect(() => loadExecPreset('custom', { projectDir, globalConfigDir, builtinPresetsDir }))
        .toThrow(/Project-local exec preset/);
      expect(() => loadExecPresetFromSource('custom', 'project', { projectDir, globalConfigDir, builtinPresetsDir }))
        .toThrow(/Project-local exec preset/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(externalDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
      rmSync(builtinPresetsDir, { recursive: true, force: true });
    }
  });

  it('should save and delete global exec presets', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-global-preset-project-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-global-preset-'));
    const config = createExecConfig('saved-global-worker');
    try {
      saveExecPreset('global-custom', 'Global custom preset', config, {
        projectDir,
        globalConfigDir,
        scope: 'global',
      });
      const presetPath = join(globalConfigDir, 'exec', 'presets', 'global-custom.yaml');
      const loaded = loadExecPreset('global-custom', { projectDir, globalConfigDir });
      expect(existsSync(presetPath)).toBe(true);
      expect(loaded.source).toBe('global');
      expect(loaded.description).toBe('Global custom preset');
      expect(loaded.config).toEqual(config);

      deleteExecPreset('global-custom', { projectDir, globalConfigDir, scope: 'global' });
      expect(existsSync(presetPath)).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('should reject invalid preset and last-used config shapes', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-invalid-preset-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-invalid-last-used-'));
    const presetDir = join(projectDir, '.takt', 'exec', 'presets');
    const invalidPresetCases = [
      ['workers-object', 'workers: {}\n'],
      ['workers-empty', 'workers: []\n'],
      ['knowledge-object', 'workers:\n  - name: worker-1\n    provider: claude\n    model: sonnet\n    instruction: exec-worker\n    knowledge: {}\n    policy: []\n'],
      ['policy-null', 'workers:\n  - name: worker-1\n    provider: claude\n    model: sonnet\n    instruction: exec-worker\n    knowledge: []\n    policy: null\n'],
      ['blank-string', 'session:\n  provider: " "\n'],
      ['string-threshold', 'loop:\n  threshold: "3"\n'],
      ['zero-threshold', 'loop:\n  threshold: 0\n'],
      ['bad-provider', 'session:\n  provider: unknown\n'],
      ['bad-effort', 'session:\n  provider: claude\n  model: opus\n  effort: impossible\n'],
      ['bad-actor-name', 'workers:\n  - name: ../worker\n    provider: claude\n    model: sonnet\n    instruction: exec-worker\n    knowledge: []\n    policy: []\n'],
      ['reserved-actor-name', 'workers:\n  - name: exec-replan\n    provider: claude\n    model: sonnet\n    instruction: exec-worker\n    knowledge: []\n    policy: []\n'],
      ['reserved-top-level-step-name', 'workers:\n  - name: replan\n    provider: claude\n    model: sonnet\n    instruction: exec-worker\n    knowledge: []\n    policy: []\n'],
      ['reserved-loop-judge-step-name', 'workers:\n  - name: _loop_judge_execute_judge\n    provider: claude\n    model: sonnet\n    instruction: exec-worker\n    knowledge: []\n    policy: []\n'],
    ] as const;
    try {
      for (const [name, yaml] of invalidPresetCases) {
        writeRawPreset(presetDir, name, `name: ${name}\ndescription: invalid\n${yaml}`);
        expect(() => loadExecPreset(name, { projectDir })).toThrow(/Invalid exec config/);
      }

      mkdirSync(globalConfigDir, { recursive: true });
      writeFileSync(join(globalConfigDir, 'exec.yaml'), 'workers: {}\n');
      expect(() => loadLastUsedExecConfig({ globalConfigDir })).toThrow(/Invalid exec config/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('should reject preset files whose YAML name does not match the filename', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-mismatch-preset-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-mismatch-global-'));
    const builtinPresetsDir = mkdtempSync(join(tmpdir(), 'takt-exec-mismatch-builtin-'));
    const presetDir = join(projectDir, '.takt', 'exec', 'presets');
    try {
      writeRawPreset(presetDir, 'custom', 'name: backend\n');

      expect(() => loadExecPreset('custom', { projectDir, globalConfigDir, builtinPresetsDir })).toThrow(
        /name "backend" must match filename "custom"/,
      );
      const presets = listExecPresets({ projectDir, globalConfigDir, builtinPresetsDir });
      expect(presets.find((p) => p.name === 'custom')).toBeUndefined();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
      rmSync(builtinPresetsDir, { recursive: true, force: true });
    }
  });

  it('should skip invalid presets and list valid presets when listing', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-skip-invalid-preset-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-skip-invalid-global-'));
    const builtinPresetsDir = mkdtempSync(join(tmpdir(), 'takt-exec-skip-invalid-builtin-'));
    const presetDir = join(projectDir, '.takt', 'exec', 'presets');
    try {
      writeRawPreset(presetDir, 'invalid-name', 'name: wrong-name\n');
      writePreset(presetDir, 'valid', createExecConfig('valid-worker'), 'Valid preset');

      const presets = listExecPresets({ projectDir, globalConfigDir, builtinPresetsDir });
      expect(presets.find((p) => p.name === 'valid')).toBeDefined();
      expect(presets.find((p) => p.name === 'invalid-name')).toBeUndefined();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
      rmSync(builtinPresetsDir, { recursive: true, force: true });
    }
  });

  it('should skip invalid presets and list valid presets when listing by source', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-skip-invalid-by-source-'));
    const builtinPresetsDir = mkdtempSync(join(tmpdir(), 'takt-exec-skip-invalid-by-source-builtin-'));
    const presetDir = join(projectDir, '.takt', 'exec', 'presets');
    try {
      writeRawPreset(presetDir, 'invalid-name', 'name: wrong-name\n');
      writePreset(presetDir, 'valid', createExecConfig('valid-worker'), 'Valid preset');

      const presets = listExecPresetsBySource('project', { projectDir, builtinPresetsDir });
      expect(presets.find((p) => p.name === 'valid')).toBeDefined();
      expect(presets.find((p) => p.name === 'invalid-name')).toBeUndefined();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(builtinPresetsDir, { recursive: true, force: true });
    }
  });

  it('should define the builtin research preset with three workers and one judge', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-research-preset-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-research-preset-global-'));
    try {
      const preset = loadExecPreset('research', { projectDir, globalConfigDir });
      expect(preset.source).toBe('builtin');
      expect(preset.config.workers).toHaveLength(3);
      expect(preset.config.judges).toHaveLength(1);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('should reject presets whose actor session keys collide', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-duplicate-actor-'));
    const config = createExecConfig('duplicate-worker');
    const duplicateConfig: ExecConfig = {
      ...config,
      workers: [{ ...config.workers[0]!, name: 'step' }],
      judges: [{ ...config.judges[0]!, name: 'step' }],
    };
    try {
      writePreset(join(projectDir, '.takt', 'exec', 'presets'), 'duplicate', duplicateConfig, 'duplicate actors');
      expect(() => loadExecPreset('duplicate', { projectDir })).toThrow(/duplicate actor name\/session_key "step"/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
