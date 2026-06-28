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
    reviews: [
      {
        name: 'review-1',
        provider: 'claude',
        model: 'opus',
        effort: 'high',
        instruction: 'exec-review',
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
      `reviews:`,
      `  - name: ${config.reviews[0]!.name}`,
      `    provider: ${config.reviews[0]!.provider}`,
      `    model: ${config.reviews[0]!.model}`,
      `    effort: ${config.reviews[0]!.effort}`,
      `    instruction: ${config.reviews[0]!.instruction}`,
      `    knowledge:`,
      ...config.reviews[0]!.knowledge.map((entry) => `      - ${entry}`),
      `    policy:`,
      ...config.reviews[0]!.policy.map((entry) => `      - ${entry}`),
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

type PresetYamlSections = Partial<Record<'session' | 'replan' | 'workers' | 'reviews' | 'loop', readonly string[]>>;

function buildPresetYaml(name: string, sections: PresetYamlSections): string {
  const session = sections.session ?? [
    'session:',
    '  provider: claude',
    '  model: opus',
    '  effort: high',
  ];
  const replan = sections.replan ?? [
    'replan:',
    '  instruction: exec-replan',
    '  knowledge: []',
    '  policy: []',
  ];
  const workers = sections.workers ?? [
    'workers:',
    '  - name: worker-1',
    '    provider: claude',
    '    model: sonnet',
    '    effort: high',
    '    instruction: exec-worker',
    '    knowledge: []',
    '    policy: []',
  ];
  const reviews = sections.reviews ?? [
    'reviews:',
    '  - name: review-1',
    '    provider: claude',
    '    model: opus',
    '    effort: high',
    '    instruction: exec-review',
    '    knowledge: []',
    '    policy: []',
  ];
  const loop = sections.loop ?? [
    'loop:',
    '  threshold: 3',
    '  large_threshold: 2',
    '  max_steps: 20',
  ];

  return [
    `name: ${name}`,
    'description: invalid',
    ...session,
    ...replan,
    ...workers,
    ...reviews,
    ...loop,
  ].join('\n');
}

function buildExecYaml(sections: PresetYamlSections): string {
  return buildPresetYaml('last-used', sections).split('\n').slice(2).join('\n');
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
        'reviews:',
        '  - name: review-1',
        '    provider: claude',
        '    model: opus',
        '    effort: high',
        '    instruction: exec-review',
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
        'reviews:',
        '  - name: review-1',
        '    provider: claude',
        '    model: opus',
        '    effort: high',
        '    instruction: exec-review',
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
      expect(raw).toContain('reviews:');
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
    const invalidPresetCases: readonly [string, string, RegExp][] = [
      [
        'workers-object',
        buildPresetYaml('workers-object', { workers: ['workers: {}'] }),
        /exec\.workers: expected non-empty array/,
      ],
      [
        'workers-empty',
        buildPresetYaml('workers-empty', { workers: ['workers: []'] }),
        /exec\.workers: expected non-empty array/,
      ],
      [
        'knowledge-object',
        buildPresetYaml('knowledge-object', {
          workers: [
            'workers:',
            '  - name: worker-1',
            '    provider: claude',
            '    model: sonnet',
            '    effort: high',
            '    instruction: exec-worker',
            '    knowledge: {}',
            '    policy: []',
          ],
        }),
        /exec\.workers\[0\]\.knowledge: expected array/,
      ],
      [
        'policy-null',
        buildPresetYaml('policy-null', {
          workers: [
            'workers:',
            '  - name: worker-1',
            '    provider: claude',
            '    model: sonnet',
            '    effort: high',
            '    instruction: exec-worker',
            '    knowledge: []',
            '    policy: null',
          ],
        }),
        /exec\.workers\[0\]\.policy: expected array/,
      ],
      [
        'blank-string',
        buildPresetYaml('blank-string', {
          session: [
            'session:',
            '  provider: " "',
            '  model: opus',
            '  effort: high',
          ],
        }),
        /exec\.session\.provider: expected non-empty string/,
      ],
      [
        'blank-session-model',
        buildPresetYaml('blank-session-model', {
          session: [
            'session:',
            '  provider: cursor',
            '  model: " "',
          ],
        }),
        /exec\.session\.model: expected non-empty string/,
      ],
      [
        'blank-worker-model',
        buildPresetYaml('blank-worker-model', {
          workers: [
            'workers:',
            '  - name: worker-1',
            '    provider: cursor',
            '    model: " "',
            '    instruction: exec-worker',
            '    knowledge: []',
            '    policy: []',
          ],
        }),
        /exec\.workers\[0\]\.model: expected non-empty string/,
      ],
      [
        'blank-review-model',
        buildPresetYaml('blank-review-model', {
          reviews: [
            'reviews:',
            '  - name: review-1',
            '    provider: cursor',
            '    model: " "',
            '    instruction: exec-review',
            '    knowledge: []',
            '    policy: []',
          ],
        }),
        /exec\.reviews\[0\]\.model: expected non-empty string/,
      ],
      [
        'string-threshold',
        buildPresetYaml('string-threshold', {
          loop: [
            'loop:',
            '  threshold: "3"',
            '  large_threshold: 2',
            '  max_steps: 20',
          ],
        }),
        /exec\.loop\.threshold: expected positive integer/,
      ],
      [
        'zero-threshold',
        buildPresetYaml('zero-threshold', {
          loop: [
            'loop:',
            '  threshold: 0',
            '  large_threshold: 2',
            '  max_steps: 20',
          ],
        }),
        /exec\.loop\.threshold: expected positive integer/,
      ],
      [
        'bad-provider',
        buildPresetYaml('bad-provider', {
          session: [
            'session:',
            '  provider: unknown',
            '  model: opus',
            '  effort: high',
          ],
        }),
        /exec\.session\.provider: unsupported provider/,
      ],
      [
        'bad-session-model',
        buildPresetYaml('bad-session-model', {
          session: [
            'session:',
            '  provider: codex',
            '  model: opus',
            '  effort: high',
          ],
        }),
        /exec\.session\.model.*Claude model alias/,
      ],
      [
        'bad-effort',
        buildPresetYaml('bad-effort', {
          session: [
            'session:',
            '  provider: claude',
            '  model: opus',
            '  effort: impossible',
          ],
        }),
        /exec\.session\.effort: unsupported effort/,
      ],
      [
        'bad-actor-name',
        buildPresetYaml('bad-actor-name', {
          workers: [
            'workers:',
            '  - name: ../worker',
            '    provider: claude',
            '    model: sonnet',
            '    effort: high',
            '    instruction: exec-worker',
            '    knowledge: []',
            '    policy: []',
          ],
        }),
        /exec\.workers\[0\]\.name: actor name must match/,
      ],
      [
        'reserved-actor-name',
        buildPresetYaml('reserved-actor-name', {
          workers: [
            'workers:',
            '  - name: exec-replan',
            '    provider: claude',
            '    model: sonnet',
            '    effort: high',
            '    instruction: exec-worker',
            '    knowledge: []',
            '    policy: []',
          ],
        }),
        /exec\.workers\[0\]\.name: actor name "exec-replan" is reserved/,
      ],
      [
        'reserved-top-level-step-name',
        buildPresetYaml('reserved-top-level-step-name', {
          workers: [
            'workers:',
            '  - name: replan',
            '    provider: claude',
            '    model: sonnet',
            '    effort: high',
            '    instruction: exec-worker',
            '    knowledge: []',
            '    policy: []',
          ],
        }),
        /exec\.workers\[0\]\.name: actor name "replan" is reserved/,
      ],
      [
        'reserved-loop-review-step-name',
        buildPresetYaml('reserved-loop-review-step-name', {
          workers: [
            'workers:',
            '  - name: _loop_judge_execute_review',
            '    provider: claude',
            '    model: sonnet',
            '    effort: high',
            '    instruction: exec-worker',
            '    knowledge: []',
            '    policy: []',
          ],
        }),
        /exec\.workers\[0\]\.name: actor name "_loop_judge_execute_review" is reserved/,
      ],
      [
        'opencode-bare-session-model',
        buildPresetYaml('opencode-bare-session-model', {
          session: [
            'session:',
            '  provider: opencode',
            '  model: big-pickle',
          ],
        }),
        /exec\.session\.model.*provider\/model/,
      ],
    ] as const;
    try {
      for (const [name, yaml, expectedError] of invalidPresetCases) {
        writeRawPreset(presetDir, name, yaml);
        expect(() => loadExecPreset(name, { projectDir })).toThrow(expectedError);
      }

      mkdirSync(globalConfigDir, { recursive: true });
      writeFileSync(join(globalConfigDir, 'exec.yaml'), buildExecYaml({ workers: ['workers: {}'] }));
      expect(() => loadLastUsedExecConfig({ globalConfigDir }))
        .toThrow(/exec\.workers: expected non-empty array/);

      writeFileSync(join(globalConfigDir, 'exec.yaml'), buildExecYaml({
        session: [
          'session:',
          '  provider: opencode',
          '  model: big-pickle',
        ],
      }));
      expect(() => loadLastUsedExecConfig({ globalConfigDir }))
        .toThrow(/exec\.session\.model.*provider\/model/);

      writeFileSync(join(globalConfigDir, 'exec.yaml'), buildExecYaml({
        session: [
          'session:',
          '  provider: cursor',
          '  model: " "',
        ],
      }));
      expect(() => loadLastUsedExecConfig({ globalConfigDir }))
        .toThrow(/exec\.session\.model: expected non-empty string/);

      writeFileSync(join(globalConfigDir, 'exec.yaml'), buildExecYaml({
        workers: [
          'workers:',
          '  - name: worker-1',
          '    provider: cursor',
          '    model: " "',
          '    instruction: exec-worker',
          '    knowledge: []',
          '    policy: []',
        ],
      }));
      expect(() => loadLastUsedExecConfig({ globalConfigDir }))
        .toThrow(/exec\.workers\[0\]\.model: expected non-empty string/);

      writeFileSync(join(globalConfigDir, 'exec.yaml'), buildExecYaml({
        reviews: [
          'reviews:',
          '  - name: review-1',
          '    provider: cursor',
          '    model: " "',
          '    instruction: exec-review',
          '    knowledge: []',
          '    policy: []',
        ],
      }));
      expect(() => loadLastUsedExecConfig({ globalConfigDir }))
        .toThrow(/exec\.reviews\[0\]\.model: expected non-empty string/);
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

  it('should define the builtin research preset with three workers and one review', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-research-preset-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-research-preset-global-'));
    try {
      const preset = loadExecPreset('research', { projectDir, globalConfigDir });
      expect(preset.source).toBe('builtin');
      expect(preset.config.workers).toHaveLength(3);
      expect(preset.config.reviews).toHaveLength(1);
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
      reviews: [{ ...config.reviews[0]!, name: 'step' }],
    };
    try {
      writePreset(join(projectDir, '.takt', 'exec', 'presets'), 'duplicate', duplicateConfig, 'duplicate actors');
      expect(() => loadExecPreset('duplicate', { projectDir })).toThrow(/duplicate actor name\/session_key "step"/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
