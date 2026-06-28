import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { applyExecOverrides, formatActorDetails, formatExecConfigSummary } from '../features/exec/configOps.js';
import type { ExecConfig } from '../features/exec/types.js';
import { buildExecWorkflowYaml } from '../features/exec/workflowTemplate.js';
import type { ExecProviderModelDefaults } from '../features/exec/runtimeConfig.js';

type RawExecWorkflowStep = {
  name?: string;
  provider?: unknown;
  model?: unknown;
  parallel?: Array<{ provider?: unknown; model?: unknown }>;
};

type RawExecWorkflow = {
  steps: RawExecWorkflowStep[];
  loop_monitors?: Array<{
    judge: {
      provider?: unknown;
      model?: unknown;
    };
  }>;
};

function parseExecWorkflowYaml(yaml: string): RawExecWorkflow {
  const raw = parseYaml(yaml) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Generated exec workflow YAML must be an object');
  }
  const workflow = raw as Partial<RawExecWorkflow>;
  if (!Array.isArray(workflow.steps)) {
    throw new Error('Generated exec workflow YAML must include steps');
  }
  return workflow as RawExecWorkflow;
}

function findRawStep(workflow: RawExecWorkflow, name: string): RawExecWorkflowStep {
  const step = workflow.steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Generated exec workflow must include ${name} step`);
  }
  return step;
}

function createTestConfig(): ExecConfig {
  return {
    session: { provider: 'claude', model: 'opus', effort: 'high' },
    replan: { instruction: 'exec-replan', knowledge: [], policy: [] },
    workers: [
      { name: 'w1', provider: 'claude', model: 'sonnet', effort: 'high', instruction: 'exec-worker', knowledge: [], policy: [] },
    ],
    reviews: [
      { name: 'j1', provider: 'claude', model: 'opus', effort: 'high', instruction: 'exec-review', knowledge: [], policy: [] },
    ],
    loop: { smallThreshold: 3, largeThreshold: 2, maxSteps: 20 },
  };
}

const DEFAULT_PROVIDER_MODEL: ExecProviderModelDefaults = {
  provider: 'claude',
  model: 'opus',
};

describe('applyExecOverrides', () => {
  it('should apply provider override consistently to session, workers, and reviews', () => {
    const config = createTestConfig();

    const result = applyExecOverrides(config, { provider: 'codex' }, DEFAULT_PROVIDER_MODEL);

    expect(result.session.provider).toBe('codex');
    expect(result.workers[0]!.provider).toBe('codex');
    expect(result.reviews[0]!.provider).toBe('codex');
    expect(result.session.model).toBeUndefined();
    expect(result.workers[0]!.model).toBeUndefined();
    expect(result.reviews[0]!.model).toBeUndefined();
  });

  it('should apply model override consistently to session, workers, and reviews', () => {
    const config = createTestConfig();

    const result = applyExecOverrides(config, { model: 'haiku' }, DEFAULT_PROVIDER_MODEL);

    expect(result.session.model).toBe('haiku');
    expect(result.workers[0]!.model).toBe('haiku');
    expect(result.reviews[0]!.model).toBe('haiku');
  });

  it('should clear stale effort when a model override is incompatible with it', () => {
    const baseConfig = createTestConfig();
    const config: ExecConfig = {
      ...baseConfig,
      session: { provider: 'claude', model: 'claude-opus-4-7', effort: 'xhigh' },
      workers: [
        {
          ...baseConfig.workers[0]!,
          provider: 'claude',
          model: 'claude-opus-4-7',
          effort: 'xhigh',
        },
      ],
      reviews: [
        {
          ...baseConfig.reviews[0]!,
          provider: 'claude',
          model: 'claude-opus-4-7',
          effort: 'xhigh',
        },
      ],
    };

    const result = applyExecOverrides(config, { model: 'claude-sonnet-4-5-20250929' }, DEFAULT_PROVIDER_MODEL);

    expect(result.session).toMatchObject({ model: 'claude-sonnet-4-5-20250929', effort: undefined });
    expect(result.workers[0]).toMatchObject({ model: 'claude-sonnet-4-5-20250929', effort: undefined });
    expect(result.reviews[0]).toMatchObject({ model: 'claude-sonnet-4-5-20250929', effort: undefined });
  });

  it('should clear stale inherited effort when a model override relies on the configured provider', () => {
    const baseConfig = createTestConfig();
    const config: ExecConfig = {
      ...baseConfig,
      session: { effort: 'xhigh' },
      workers: [
        {
          ...baseConfig.workers[0]!,
          provider: undefined,
          model: undefined,
          effort: 'xhigh',
        },
      ],
      reviews: [
        {
          ...baseConfig.reviews[0]!,
          provider: undefined,
          model: undefined,
          effort: 'xhigh',
        },
      ],
    };

    const result = applyExecOverrides(config, { model: 'claude-sonnet-4-5-20250929' }, {
      provider: 'claude',
      model: 'claude-opus-4-7',
    });

    expect(result.session).toMatchObject({ model: 'claude-sonnet-4-5-20250929', effort: undefined });
    expect(result.workers[0]).toMatchObject({ model: 'claude-sonnet-4-5-20250929', effort: undefined });
    expect(result.reviews[0]).toMatchObject({ model: 'claude-sonnet-4-5-20250929', effort: undefined });
  });

  it('should clear stale inherited effort when no provider or model override is provided', () => {
    const baseConfig = createTestConfig();
    const config: ExecConfig = {
      ...baseConfig,
      session: { effort: 'xhigh' },
      workers: [
        {
          ...baseConfig.workers[0]!,
          provider: undefined,
          model: undefined,
          effort: 'xhigh',
        },
      ],
      reviews: [
        {
          ...baseConfig.reviews[0]!,
          provider: undefined,
          model: undefined,
          effort: 'xhigh',
        },
      ],
    };

    const result = applyExecOverrides(config, undefined, {
      provider: 'claude',
      model: 'claude-sonnet-4-5-20250929',
    });

    expect(result.session).toMatchObject({ effort: undefined });
    expect(result.workers[0]).toMatchObject({ effort: undefined });
    expect(result.reviews[0]).toMatchObject({ effort: undefined });
  });

  it('should re-resolve effort when provider changes', () => {
    const config = createTestConfig();

    const result = applyExecOverrides(config, { provider: 'codex' }, DEFAULT_PROVIDER_MODEL);

    expect(result.session.effort).toBe('high');
    expect(result.workers[0]!.effort).toBe('high');
    expect(result.reviews[0]!.effort).toBe('high');
  });

  it('should reject opencode provider override without an explicit provider-qualified model', () => {
    const config = createTestConfig();

    expect(() => applyExecOverrides(config, { provider: 'opencode' }, DEFAULT_PROVIDER_MODEL))
      .toThrow(/provider 'opencode' requires model/);
  });

  it('should display provider-qualified opencode models without duplicating the provider', () => {
    const config: ExecConfig = {
      ...createTestConfig(),
      session: { provider: 'opencode', model: 'opencode/big-pickle' },
      workers: [
        {
          name: 'w1',
          provider: 'opencode',
          model: 'opencode/big-pickle',
          instruction: 'exec-worker',
          knowledge: [],
          policy: [],
        },
      ],
      reviews: [
        {
          name: 'j1',
          provider: 'opencode',
          model: 'opencode/big-pickle',
          instruction: 'exec-review',
          knowledge: [],
          policy: [],
        },
      ],
    };

    const summary = formatExecConfigSummary(config);
    const workerDetails = formatActorDetails(config.workers[0]!);

    expect(summary).toContain('Assistant agent: opencode/big-pickle');
    expect(summary).toContain('Worker agent x1: opencode/big-pickle');
    expect(summary).toContain('Review agent x1: opencode/big-pickle');
    expect(workerDetails).toContain('opencode/big-pickle · instruction: exec-worker');
    expect(summary).not.toContain('opencode/opencode/big-pickle');
    expect(workerDetails).not.toContain('opencode/opencode/big-pickle');
  });

  it('should reject explicit Claude model aliases for codex overrides', () => {
    const config = createTestConfig();

    expect(() => applyExecOverrides(config, { provider: 'codex', model: 'opus' }, DEFAULT_PROVIDER_MODEL))
      .toThrow(/Claude model alias/);
  });

  it('should reject explicit bare opencode model overrides', () => {
    const config = createTestConfig();

    expect(() => applyExecOverrides(config, { provider: 'opencode', model: 'big-pickle' }, DEFAULT_PROVIDER_MODEL))
      .toThrow(/provider\/model/);
  });

  it.each(['', '   '] as const)(
    'should reject blank model override "%s"',
    (model) => {
      const config = createTestConfig();

      expect(() => applyExecOverrides(config, { model }, DEFAULT_PROVIDER_MODEL))
        .toThrow(/exec\.session\.model: expected non-empty string/);
    },
  );

  it.each(['cursor', 'copilot', 'kiro'] as const)(
    'should display and emit provider defaults when overriding provider to %s without an explicit model',
    (provider) => {
      const config = createTestConfig();

      const result = applyExecOverrides(config, { provider }, DEFAULT_PROVIDER_MODEL);
      const summary = formatExecConfigSummary(result);
      const rawWorkflow = parseExecWorkflowYaml(buildExecWorkflowYaml(result, {
        workflowName: 'exec-provider-default-test',
        taskDescription: 'Verify provider defaults',
      }));

      expect(result.session).toMatchObject({ provider });
      expect(result.workers[0]).toMatchObject({ provider });
      expect(result.reviews[0]).toMatchObject({ provider });
      expect(result.session.model).toBeUndefined();
      expect(result.workers[0]!.model).toBeUndefined();
      expect(result.reviews[0]!.model).toBeUndefined();
      expect(summary).toContain(`Assistant agent: ${provider}/(provider default)`);
      expect(summary).toContain(`Worker agent x1: ${provider}/(provider default)`);
      expect(summary).toContain(`Review agent x1: ${provider}/(provider default)`);
      expect(findRawStep(rawWorkflow, 'execute').parallel?.[0]).toMatchObject({ provider, model: null });
      expect(findRawStep(rawWorkflow, 'review').parallel?.[0]).toMatchObject({ provider, model: null });
      expect(findRawStep(rawWorkflow, 'replan')).toMatchObject({ provider, model: null });
      expect(rawWorkflow.loop_monitors?.map((monitor) => monitor.judge)).toEqual([
        expect.objectContaining({ provider, model: null }),
        expect.objectContaining({ provider, model: null }),
      ]);
    },
  );

  it.each([
    ['cursor', 'cursor/gpt-5'],
    ['copilot', 'gpt-4.1'],
    ['kiro', 'kiro-model'],
  ] as const)(
    'should use explicit model when overriding provider to %s',
    (provider, model) => {
      const config = createTestConfig();

      const result = applyExecOverrides(config, { provider, model }, DEFAULT_PROVIDER_MODEL);

      expect(result.session).toMatchObject({ provider, model });
      expect(result.workers[0]).toMatchObject({ provider, model });
      expect(result.reviews[0]).toMatchObject({ provider, model });
    },
  );

  it('should return original config when no overrides provided', () => {
    const config = createTestConfig();

    const result = applyExecOverrides(config, undefined, DEFAULT_PROVIDER_MODEL);

    expect(result).toBe(config);
  });

  it('should return original config when overrides have no provider or model', () => {
    const config = createTestConfig();

    const result = applyExecOverrides(config, {}, DEFAULT_PROVIDER_MODEL);

    expect(result).toBe(config);
  });

  it('should not mutate original config', () => {
    const config = createTestConfig();
    const originalProvider = config.session.provider;

    applyExecOverrides(config, { provider: 'codex' }, DEFAULT_PROVIDER_MODEL);

    expect(config.session.provider).toBe(originalProvider);
  });
});
