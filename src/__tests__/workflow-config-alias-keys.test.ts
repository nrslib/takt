import { describe, expect, it } from 'vitest';
import { WorkflowConfigRawSchema } from '../core/models/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

const minimalStep = {
  name: 'plan',
  persona: 'coder',
  instruction: '{task}',
  rules: [{ condition: 'done', next: 'COMPLETE' }],
};

describe('WorkflowConfigRawSchema canonical workflow keys', () => {
  it('steps と initial_step をそのまま受理する', () => {
    const raw = {
      name: 'wf-steps-only',
      steps: [minimalStep],
      initial_step: 'plan',
    };

    const result = WorkflowConfigRawSchema.parse(raw);

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.name).toBe('plan');
    expect(result.initial_step).toBe('plan');
  });

  it('workflow_config と max_steps をそのまま受理する', () => {
    const raw = {
      name: 'wf-canonical',
      workflow_config: {
        provider: 'codex',
      },
      max_steps: 7,
      steps: [minimalStep],
    };

    const result = WorkflowConfigRawSchema.parse(raw);

    expect(result.workflow_config.provider).toBe('codex');
    expect(result.max_steps).toBe(7);
  });
});

describe('WorkflowConfigRawSchema removed workflow keys', () => {
  it.each([
    {
      name: 'removed_workflow_config_key',
      raw: {
        name: 'wf-legacy-workflow-config',
        piece_config: {},
        steps: [minimalStep],
      },
      expected: /piece_config/i,
    },
    {
      name: 'removed_step_list_key',
      raw: {
        name: 'wf-legacy-step-list',
        movements: [minimalStep],
      },
      expected: /movements/i,
    },
    {
      name: 'removed_initial_step_key',
      raw: {
        name: 'wf-legacy-initial',
        steps: [minimalStep],
        initial_movement: 'plan',
      },
      expected: /initial_movement/i,
    },
    {
      name: 'removed_max_steps_key',
      raw: {
        name: 'wf-legacy-max',
        steps: [minimalStep],
        max_movements: 3,
      },
      expected: /max_movements/i,
    },
  ])('$name を reject する', ({ raw, expected }) => {
    expect(() => WorkflowConfigRawSchema.parse(raw)).toThrow(expected);
  });
});

describe('normalizeWorkflowConfig canonical workflow keys', () => {
  it('steps-only raw config を内部 workflow 形式に正規化する', () => {
    const raw = {
      name: 'wf-normalize-steps',
      steps: [minimalStep],
      initial_step: 'plan',
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());

    expect(config.steps).toHaveLength(1);
    expect(config.steps[0]?.name).toBe('plan');
    expect(config.initialStep).toBe('plan');
    expect(config.maxSteps).toBe(10);
  });

  it('workflow_config の provider を step に継承する', () => {
    const raw = {
      name: 'wf-normalize-provider',
      workflow_config: {
        provider: 'codex',
      },
      steps: [minimalStep],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());

    expect(config.providerOptions).toBeUndefined();
    expect(config.steps[0]?.provider).toBe('codex');
    expect(config.steps[0]?.model).toBeUndefined();
  });

  it('parallel sub-step では legacy key の step を reject する', () => {
    const raw = {
      name: 'wf-parallel-legacy-step',
      steps: [
        {
          name: 'review',
          parallel: [
            {
              step: 'arch-review',
              persona: 'arch.md',
              instruction: 'Review architecture',
            },
          ],
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
      initial_step: 'review',
    };

    expect(() => normalizeWorkflowConfig(raw, process.cwd())).toThrow(/name/i);
  });

  it('removed top-level workflow aliases are still rejected during normalization', () => {
    const raw = {
      name: 'wf-normalize-removed-alias',
      piece_config: {
        provider: 'codex',
      },
      steps: [minimalStep],
    };

    expect(() => normalizeWorkflowConfig(raw, process.cwd())).toThrow(/piece_config/i);
  });

  it('removed step list aliases are rejected during normalization', () => {
    const raw = {
      name: 'wf-normalize-removed-step-list',
      movements: [minimalStep],
    };

    expect(() => normalizeWorkflowConfig(raw, process.cwd())).toThrow(/movements/i);
  });
});
