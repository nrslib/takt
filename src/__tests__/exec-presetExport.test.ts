import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecConfig } from '../features/exec/types.js';
import type { ExecProviderModelDefaults } from '../features/exec/runtimeConfig.js';

vi.mock('../features/exec/promptUtils.js', () => ({
  selectExecOption: vi.fn(),
  promptTextOrCancel: vi.fn(),
  promptText: vi.fn(),
  promptInteger: vi.fn(),
}));

vi.mock('../shared/ui/index.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, info: vi.fn() };
});

import { selectExecOption, promptTextOrCancel } from '../features/exec/promptUtils.js';
import { info } from '../shared/ui/index.js';
import { editPresetSetup, exportPresetAsWorkflow } from '../features/exec/presetSetup.js';

const mockSelectExecOption = vi.mocked(selectExecOption);
const mockPromptTextOrCancel = vi.mocked(promptTextOrCancel);
const mockInfo = vi.mocked(info);

const PROVIDER_MODEL_DEFAULTS: ExecProviderModelDefaults = {
  provider: 'claude',
  model: 'opus',
};

function createExecConfig(): ExecConfig {
  return {
    session: { provider: 'claude', model: 'opus', effort: 'high' },
    replan: { instruction: 'exec-replan', knowledge: ['architecture'], policy: [] },
    workers: [{
      name: 'worker-1',
      provider: 'claude',
      model: 'sonnet',
      effort: 'high',
      instruction: 'exec-worker',
      knowledge: ['architecture'],
      policy: ['coding', 'testing'],
    }],
    reviews: [{
      name: 'review-1',
      provider: 'claude',
      model: 'opus',
      effort: 'high',
      instruction: 'exec-review',
      knowledge: ['architecture'],
      policy: ['review'],
    }],
    loop: { smallThreshold: 3, largeThreshold: 2, maxSteps: 20 },
  };
}

function writeProjectPreset(
  projectDir: string,
  name: string,
  config: ExecConfig,
  description: string,
): void {
  const presetDir = join(projectDir, '.takt', 'exec', 'presets');
  mkdirSync(presetDir, { recursive: true });
  writeFileSync(join(presetDir, `${name}.yaml`), [
    `name: ${name}`,
    `description: ${description}`,
    'session:',
    `  provider: ${config.session.provider}`,
    `  model: ${config.session.model}`,
    ...(config.session.effort !== undefined ? [`  effort: ${config.session.effort}`] : []),
    'replan:',
    `  instruction: ${config.replan.instruction}`,
    '  knowledge:',
    ...config.replan.knowledge.map((k) => `    - ${k}`),
    '  policy: []',
    'workers:',
    `  - name: ${config.workers[0]!.name}`,
    `    provider: ${config.workers[0]!.provider}`,
    `    model: ${config.workers[0]!.model}`,
    ...(config.workers[0]!.effort !== undefined ? [`    effort: ${config.workers[0]!.effort}`] : []),
    `    instruction: ${config.workers[0]!.instruction}`,
    '    knowledge:',
    ...config.workers[0]!.knowledge.map((k) => `      - ${k}`),
    '    policy:',
    ...config.workers[0]!.policy.map((p) => `      - ${p}`),
    'reviews:',
    `  - name: ${config.reviews[0]!.name}`,
    `    provider: ${config.reviews[0]!.provider}`,
    `    model: ${config.reviews[0]!.model}`,
    ...(config.reviews[0]!.effort !== undefined ? [`    effort: ${config.reviews[0]!.effort}`] : []),
    `    instruction: ${config.reviews[0]!.instruction}`,
    '    knowledge:',
    ...config.reviews[0]!.knowledge.map((k) => `      - ${k}`),
    '    policy:',
    ...config.reviews[0]!.policy.map((p) => `      - ${p}`),
    'loop:',
    `  threshold: ${config.loop.smallThreshold}`,
    `  large_threshold: ${config.loop.largeThreshold}`,
    `  max_steps: ${config.loop.maxSteps}`,
  ].join('\n'));
}

type RawWorkflowStep = {
  name: string;
  parallel?: Array<Record<string, unknown>>;
  provider?: string;
  model?: string;
  [key: string]: unknown;
};

type RawWorkflow = {
  name: string;
  description: string;
  initial_step: string;
  max_steps: number;
  steps: RawWorkflowStep[];
  loop_monitors?: Array<{
    cycle: string[];
    threshold: number;
    judge: Record<string, unknown>;
  }>;
};

function readExportedWorkflow(projectDir: string, name: string): RawWorkflow {
  const workflowPath = join(projectDir, '.takt', 'workflows', `${name}.yaml`);
  return parseYaml(readFileSync(workflowPath, 'utf-8')) as RawWorkflow;
}

describe('exec preset export', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-preset-export-'));
    mockSelectExecOption.mockReset();
    mockPromptTextOrCancel.mockReset();
    mockInfo.mockReset();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  describe('exportPresetAsWorkflow', () => {
    it('should write a valid workflow YAML to .takt/workflows/ when default preset is exported', async () => {
      // Given: user selects default scope and enters a workflow name
      mockSelectExecOption.mockResolvedValueOnce('default');
      mockPromptTextOrCancel.mockResolvedValueOnce('my-workflow');

      // When
      await exportPresetAsWorkflow(projectDir, 'en', PROVIDER_MODEL_DEFAULTS);

      // Then: YAML is written to the correct path with expected structure
      const workflowPath = join(projectDir, '.takt', 'workflows', 'my-workflow.yaml');
      expect(existsSync(workflowPath)).toBe(true);

      const parsed = readExportedWorkflow(projectDir, 'my-workflow');
      expect(parsed.name).toBe('my-workflow');
      expect(parsed.description).toBe('my-workflow');
      expect(parsed.initial_step).toBe('execute');
      expect(parsed.max_steps).toBe(20);
      expect(parsed.steps.map((s) => s.name)).toEqual(['execute', 'review', 'replan']);
    });

    it('should resolve provider and model from defaults into all workflow actors', async () => {
      // Given: default preset (no explicit provider/model) with specific defaults
      const defaults: ExecProviderModelDefaults = { provider: 'claude', model: 'sonnet' };
      mockSelectExecOption.mockResolvedValueOnce('default');
      mockPromptTextOrCancel.mockResolvedValueOnce('resolved-test');

      // When
      await exportPresetAsWorkflow(projectDir, 'en', defaults);

      // Then: all actors have the resolved provider and model
      const parsed = readExportedWorkflow(projectDir, 'resolved-test');
      const executeStep = parsed.steps.find((s) => s.name === 'execute');
      const judgeStep = parsed.steps.find((s) => s.name === 'review');
      const replanStep = parsed.steps.find((s) => s.name === 'replan');

      expect(executeStep?.parallel?.[0]).toMatchObject({ provider: 'claude', model: 'sonnet' });
      expect(judgeStep?.parallel?.[0]).toMatchObject({ provider: 'claude', model: 'sonnet' });
      expect(replanStep?.provider).toBe('claude');
      expect(replanStep?.model).toBe('sonnet');
    });

    it('should include loop monitors matching the preset loop config', async () => {
      // Given
      mockSelectExecOption.mockResolvedValueOnce('default');
      mockPromptTextOrCancel.mockResolvedValueOnce('loop-test');

      // When
      await exportPresetAsWorkflow(projectDir, 'en', PROVIDER_MODEL_DEFAULTS);

      // Then: loop monitors reflect the default config thresholds
      const parsed = readExportedWorkflow(projectDir, 'loop-test');
      expect(parsed.loop_monitors).toHaveLength(2);
      expect(parsed.loop_monitors?.[0]).toMatchObject({
        cycle: ['execute', 'review'],
        threshold: 3,
      });
      expect(parsed.loop_monitors?.[1]).toMatchObject({
        cycle: ['replan', 'execute', 'review'],
        threshold: 2,
      });
    });

    it('should not write any file when preset selection is cancelled', async () => {
      // Given: user cancels at scope selection
      mockSelectExecOption.mockResolvedValueOnce(null);

      // When
      await exportPresetAsWorkflow(projectDir, 'en', PROVIDER_MODEL_DEFAULTS);

      // Then: no file or directory created
      expect(existsSync(join(projectDir, '.takt', 'workflows'))).toBe(false);
      expect(mockInfo).not.toHaveBeenCalled();
    });

    it('should not write any file when workflow name input is cancelled', async () => {
      // Given: default preset selected, then name input cancelled
      mockSelectExecOption.mockResolvedValueOnce('default');
      mockPromptTextOrCancel.mockResolvedValueOnce(null);

      // When
      await exportPresetAsWorkflow(projectDir, 'en', PROVIDER_MODEL_DEFAULTS);

      // Then
      expect(existsSync(join(projectDir, '.takt', 'workflows'))).toBe(false);
      expect(mockInfo).not.toHaveBeenCalled();
    });

    it('should display a success message containing the workflow name after export', async () => {
      // Given
      mockSelectExecOption.mockResolvedValueOnce('default');
      mockPromptTextOrCancel.mockResolvedValueOnce('msg-check');

      // When
      await exportPresetAsWorkflow(projectDir, 'en', PROVIDER_MODEL_DEFAULTS);

      // Then
      expect(mockInfo).toHaveBeenCalledTimes(1);
      expect(mockInfo.mock.calls[0]?.[0]).toContain('msg-check');
    });

    it('should pass default value "exported-exec" to the workflow name prompt', async () => {
      // Given
      mockSelectExecOption.mockResolvedValueOnce('default');
      mockPromptTextOrCancel.mockResolvedValueOnce('any');

      // When
      await exportPresetAsWorkflow(projectDir, 'en', PROVIDER_MODEL_DEFAULTS);

      // Then: the prompt default is 'exported-exec' per the plan
      expect(mockPromptTextOrCancel).toHaveBeenCalledWith(
        expect.any(String),
        'exported-exec',
        'en',
      );
    });

    it('should throw when workflow name contains path traversal characters', async () => {
      // Given: user selects default preset and enters a path-traversal name
      mockSelectExecOption.mockResolvedValueOnce('default');
      mockPromptTextOrCancel.mockResolvedValueOnce('../evil');

      // When / Then
      await expect(exportPresetAsWorkflow(projectDir, 'en', PROVIDER_MODEL_DEFAULTS))
        .rejects.toThrow('Invalid exec preset name');
      expect(existsSync(join(projectDir, '.takt', 'workflows'))).toBe(false);
    });

    it('should throw when workflow name contains special characters', async () => {
      // Given: user enters a name with spaces and special chars
      mockSelectExecOption.mockResolvedValueOnce('default');
      mockPromptTextOrCancel.mockResolvedValueOnce('my workflow!');

      // When / Then
      await expect(exportPresetAsWorkflow(projectDir, 'en', PROVIDER_MODEL_DEFAULTS))
        .rejects.toThrow('Invalid exec preset name');
      expect(existsSync(join(projectDir, '.takt', 'workflows'))).toBe(false);
    });

    it('should export a project preset with the preset provider and model resolved', async () => {
      // Given: a project preset with explicit provider/model on actors
      const presetConfig = createExecConfig();
      writeProjectPreset(projectDir, 'custom-team', presetConfig, 'Custom team');

      mockSelectExecOption
        .mockResolvedValueOnce('project')
        .mockResolvedValueOnce('custom-team');
      mockPromptTextOrCancel.mockResolvedValueOnce('custom-workflow');

      // When
      await exportPresetAsWorkflow(projectDir, 'en', PROVIDER_MODEL_DEFAULTS);

      // Then: exported YAML reflects the preset's actor config
      const workflowPath = join(projectDir, '.takt', 'workflows', 'custom-workflow.yaml');
      expect(existsSync(workflowPath)).toBe(true);

      const parsed = readExportedWorkflow(projectDir, 'custom-workflow');
      expect(parsed.name).toBe('custom-workflow');
      expect(parsed.steps.map((s) => s.name)).toEqual(['execute', 'review', 'replan']);

      const executeStep = parsed.steps.find((s) => s.name === 'execute');
      expect(executeStep?.parallel?.[0]).toMatchObject({
        name: 'worker-1',
        provider: 'claude',
        model: 'sonnet',
      });
    });
  });

  describe('editPresetSetup with export action', () => {
    it('should return the original config unchanged when export completes', async () => {
      // Given: user selects 'export' action, then completes the export flow
      const originalConfig = createExecConfig();
      mockSelectExecOption
        .mockResolvedValueOnce('export')
        .mockResolvedValueOnce('default');
      mockPromptTextOrCancel.mockResolvedValueOnce('edit-export-test');

      // When
      const result = await editPresetSetup(projectDir, originalConfig, 'en', PROVIDER_MODEL_DEFAULTS);

      // Then: original config is returned without modification
      expect(result).toEqual(originalConfig);
    });

    it('should write workflow YAML when export action is selected from the preset menu', async () => {
      // Given
      mockSelectExecOption
        .mockResolvedValueOnce('export')
        .mockResolvedValueOnce('default');
      mockPromptTextOrCancel.mockResolvedValueOnce('menu-export');

      // When
      await editPresetSetup(projectDir, createExecConfig(), 'en', PROVIDER_MODEL_DEFAULTS);

      // Then
      expect(existsSync(join(projectDir, '.takt', 'workflows', 'menu-export.yaml'))).toBe(true);
    });

    it('should return the original config when export is cancelled at preset selection', async () => {
      // Given
      const originalConfig = createExecConfig();
      mockSelectExecOption
        .mockResolvedValueOnce('export')
        .mockResolvedValueOnce(null);

      // When
      const result = await editPresetSetup(projectDir, originalConfig, 'en', PROVIDER_MODEL_DEFAULTS);

      // Then
      expect(result).toEqual(originalConfig);
      expect(existsSync(join(projectDir, '.takt', 'workflows'))).toBe(false);
    });

    it('should return the original config when export is cancelled at workflow name input', async () => {
      // Given
      const originalConfig = createExecConfig();
      mockSelectExecOption
        .mockResolvedValueOnce('export')
        .mockResolvedValueOnce('default');
      mockPromptTextOrCancel.mockResolvedValueOnce(null);

      // When
      const result = await editPresetSetup(projectDir, originalConfig, 'en', PROVIDER_MODEL_DEFAULTS);

      // Then
      expect(result).toEqual(originalConfig);
      expect(existsSync(join(projectDir, '.takt', 'workflows'))).toBe(false);
    });
  });
});
