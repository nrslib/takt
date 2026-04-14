import { describe, expect, it } from 'vitest';
import { WorkflowConfigRawSchema, WorkflowStepRawSchema } from '../core/models/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

function createWorkflowCallStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'delegate',
    kind: 'workflow_call',
    call: 'takt/review-loop',
    rules: [
      {
        condition: 'COMPLETE',
        next: 'COMPLETE',
      },
    ],
    ...overrides,
  };
}

const workflowCallForbiddenFieldCases = [
  { field: 'persona', value: 'coder' },
  { field: 'persona_name', value: 'Coder' },
  { field: 'policy', value: 'secure-defaults' },
  { field: 'knowledge', value: 'architecture' },
  {
    field: 'mcp_servers',
    value: {
      local: {
        command: 'echo',
      },
    },
  },
  { field: 'provider', value: 'codex' },
  { field: 'model', value: 'gpt-5-codex' },
  {
    field: 'provider_options',
    value: {
      codex: {
        network_access: true,
      },
    },
  },
  { field: 'required_permission_mode', value: 'full' },
  { field: 'edit', value: false },
  { field: 'instruction', value: 'Do not allow inline instructions.' },
  { field: 'session', value: 'continue' },
  { field: 'delay_before_ms', value: 1000 },
  {
    field: 'structured_output',
    value: {
      schema_ref: 'review.schema.json',
    },
  },
  {
    field: 'system_inputs',
    value: [
      {
        type: 'task_context',
        source: 'current_task',
        as: 'task',
      },
    ],
  },
  {
    field: 'effects',
    value: [
      {
        type: 'merge_pr',
        pr: 42,
      },
    ],
  },
  {
    field: 'parallel',
    value: [
      {
        name: 'substep',
      },
    ],
  },
  { field: 'concurrency', value: 2 },
  {
    field: 'arpeggio',
    value: {
      source: 'items',
      source_path: 'items.json',
      template: 'Process {item}',
    },
  },
  {
    field: 'team_leader',
    value: {
      persona: 'leader',
    },
  },
  {
    field: 'output_contracts',
    value: {
      report: [
        {
          name: 'summary',
          format: 'markdown',
        },
      ],
    },
  },
  {
    field: 'quality_gates',
    value: ['must pass'],
  },
  { field: 'pass_previous_response', value: false },
] as const;

describe('workflow_call schema', () => {
  it('subworkflow callable と workflow_call step の DSL を保持できる', () => {
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'takt/coding',
      subworkflow: {
        callable: true,
      },
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/review-loop',
          overrides: {
            provider: 'codex',
            model: 'gpt-5-codex',
            provider_options: {
              codex: {
                network_access: true,
              },
            },
          },
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    const config = result.data as Record<string, unknown>;
    const steps = config.steps as Array<Record<string, unknown>>;

    expect(config.subworkflow).toEqual({ callable: true });
    expect(steps[0]).toMatchObject({
      kind: 'workflow_call',
      call: 'takt/review-loop',
      overrides: {
        provider: 'codex',
        model: 'gpt-5-codex',
        provider_options: {
          codex: {
            network_access: true,
          },
        },
      },
    });
  });

  it.each(workflowCallForbiddenFieldCases)(
    'workflow_call step で $field を reject する',
    ({ field, value }) => {
      const result = WorkflowStepRawSchema.safeParse(createWorkflowCallStep({
        [field]: value,
      }));

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
      }
    },
  );

  it('workflow_call step で call 欠落を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'delegate',
      kind: 'workflow_call',
      rules: [
        {
          condition: 'COMPLETE',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: ['call'],
      }));
    }
  });

  it('workflow_call step で COMPLETE と ABORT の rules を許可する', () => {
    const result = WorkflowStepRawSchema.safeParse(createWorkflowCallStep({
      rules: [
        {
          condition: 'COMPLETE',
          next: 'plan',
        },
        {
          condition: 'ABORT',
          next: 'ABORT',
        },
      ],
    }));

    expect(result.success).toBe(true);
  });

  it('workflow_call step で when rule を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse(createWorkflowCallStep({
      rules: [
        {
          when: 'true',
          next: 'COMPLETE',
        },
      ],
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['rules', 0, 'when'],
        }),
      ]));
    }
  });

  it('workflow_call step で ai() condition を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse(createWorkflowCallStep({
      rules: [
        {
          condition: 'ai("route to plan")',
          next: 'plan',
        },
      ],
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['rules', 0, 'condition'],
        }),
      ]));
    }
  });

  it('workflow_call step で COMPLETE と ABORT 以外の condition を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse(createWorkflowCallStep({
      rules: [
        {
          condition: 'done',
          next: 'COMPLETE',
        },
      ],
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['rules', 0, 'condition'],
        }),
      ]));
    }
  });

  it.each([
    {
      label: 'when rule',
      rule: {
        when: 'true',
        next: 'COMPLETE',
      },
    },
    {
      label: 'ai() condition',
      rule: {
        condition: 'ai("route to plan")',
        next: 'plan',
      },
    },
  ])('workflow 全体の正規化で不正な workflow_call $label を reject する', ({ rule }) => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'parent',
        initial_step: 'delegate',
        max_steps: 3,
        steps: [
          {
            name: 'delegate',
            kind: 'workflow_call',
            call: 'takt/review-loop',
            rules: [rule],
          },
        ],
      },
      process.cwd(),
    )).toThrow();
  });

  it.each(['agent', 'system'] as const)('%s step で call を reject する', (kind) => {
    const baseStep = kind === 'agent'
      ? {
          name: 'implement',
          kind,
          persona: 'coder',
          instruction: 'Implement the task',
          rules: [
            {
              condition: 'done',
              next: 'COMPLETE',
            },
          ],
        }
      : {
          name: 'route_context',
          kind,
          rules: [
            {
              when: 'true',
              next: 'COMPLETE',
            },
          ],
        };
    const result = WorkflowStepRawSchema.safeParse({
      ...baseStep,
      call: 'takt/review-loop',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: ['call'],
      }));
    }
  });

  it('workflow_call step は step-local execution fields を internal model に積まない', () => {
    const normalized = normalizeWorkflowConfig(
      {
        name: 'parent',
        initial_step: 'delegate',
        max_steps: 3,
        workflow_config: {
          provider: 'codex',
          model: 'gpt-5-codex',
          provider_options: {
            codex: {
              network_access: true,
            },
          },
        },
        steps: [
          {
            name: 'delegate',
            kind: 'workflow_call',
            call: 'takt/review-loop',
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    );

    const delegate = normalized.steps[0] as Record<string, unknown>;

    expect('delayBeforeMs' in delegate).toBe(false);
    expect('passPreviousResponse' in delegate).toBe(false);
    expect('provider' in delegate).toBe(false);
    expect('model' in delegate).toBe(false);
    expect('providerOptions' in delegate).toBe(false);
  });

  it('agent step で overrides を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      persona: 'coder',
      instruction: 'Implement the task',
      overrides: {
        provider: 'codex',
      },
      rules: [
        {
          condition: 'done',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'overrides')).toBe(true);
    }
  });

  it('workflow_call step で空の overrides を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'delegate',
      kind: 'workflow_call',
      call: 'takt/review-loop',
      overrides: {},
      rules: [
        {
          condition: 'COMPLETE',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) =>
        issue.message.includes('workflow_call overrides require at least one of'),
      )).toBe(true);
    }
  });

  it('workflow_call step で未知キーを含む overrides を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'delegate',
      kind: 'workflow_call',
      call: 'takt/review-loop',
      overrides: {
        provider: 'codex',
        foo: 'bar',
      },
      rules: [
        {
          condition: 'COMPLETE',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) =>
        issue.code === 'unrecognized_keys'
        && issue.path[0] === 'overrides',
      )).toBe(true);
    }
  });

  it('call を持つ step を workflow_call として正規化する', () => {
    const normalized = normalizeWorkflowConfig(
      {
        name: 'parent',
        initial_step: 'delegate',
        max_steps: 3,
        steps: [
          {
            name: 'plan',
            persona: 'planner',
            instruction: 'Plan the task',
            rules: [
              {
                condition: 'done',
                next: 'delegate',
              },
            ],
          },
          {
            name: 'delegate',
            call: 'takt/review-loop',
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
          {
            name: 'route_context',
            mode: 'system',
            rules: [
              {
                when: 'true',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    );

    const plan = normalized.steps[0] as Record<string, unknown>;
    const delegate = normalized.steps[1] as Record<string, unknown>;
    const routeContext = normalized.steps[2] as Record<string, unknown>;

    expect(plan.kind).toBe('agent');
    expect(delegate.kind).toBe('workflow_call');
    expect(delegate.call).toBe('takt/review-loop');
    expect(routeContext.kind).toBe('system');
    expect('provider' in delegate).toBe(false);
    expect('persona' in routeContext).toBe(false);
  });

  it('mode: agent を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      mode: 'agent',
      persona: 'coder',
      instruction: 'Implement the task',
      rules: [
        {
          condition: 'done',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'mode')).toBe(true);
    }
  });

  it('kind と mode の併存を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'route_context',
      kind: 'system',
      mode: 'system',
      rules: [
        {
          when: 'true',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: ['kind'],
        message: 'Step kind must be expressed with either "kind" or "mode", not both',
      }));
    }
  });

  it('callable subworkflow で workflow-level provider を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        workflow_config: {
          provider: 'codex',
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review the task',
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    )).toThrow();
  });

  it('callable subworkflow で workflow-level model を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        workflow_config: {
          model: 'gpt-5-codex',
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review the task',
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    )).toThrow();
  });

  it('callable subworkflow で workflow-level provider_options を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        workflow_config: {
          provider_options: {
            codex: {
              network_access: true,
            },
          },
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review the task',
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    )).toThrow();
  });

  it('callable subworkflow で workflow-level runtime を保持する', () => {
    const workflow = normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        workflow_config: {
          runtime: {
            prepare: ['node'],
          },
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review the task',
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    );

    expect(workflow.runtime).toEqual({
      prepare: ['node'],
    });
  });

  it('callable subworkflow で step-level provider を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            provider: 'codex',
            instruction: 'Review the task',
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    )).toThrow();
  });

  it('callable subworkflow で step-level model を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            model: 'gpt-5-codex',
            instruction: 'Review the task',
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    )).toThrow();
  });

  it('callable subworkflow で step-level provider_options を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            provider_options: {
              codex: {
                network_access: true,
              },
            },
            instruction: 'Review the task',
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    )).toThrow();
  });

  it('callable subworkflow で workflow_call overrides を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        steps: [
          {
            name: 'delegate',
            kind: 'workflow_call',
            call: 'takt/review-loop',
            overrides: {
              provider: 'codex',
            },
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    )).toThrow(/delegate/);
  });

  it('callable subworkflow で workflow_call overrides.model を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        steps: [
          {
            name: 'delegate',
            kind: 'workflow_call',
            call: 'takt/review-loop',
            overrides: {
              model: 'gpt-5-codex',
            },
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    )).toThrow(/delegate/);
  });

  it('callable subworkflow で workflow_call overrides.provider_options を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        steps: [
          {
            name: 'delegate',
            kind: 'workflow_call',
            call: 'takt/review-loop',
            overrides: {
              provider_options: {
                codex: {
                  network_access: true,
                },
              },
            },
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    )).toThrow(/delegate/);
  });

  it('callable subworkflow で parallel substep の provider を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review the task',
            parallel: [
              {
                name: 'security',
                persona: 'security-reviewer',
                provider: 'codex',
                instruction: 'Security review',
              },
            ],
            rules: [
              {
                condition: 'done',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      process.cwd(),
    )).toThrow(/security/);
  });

  it('callable subworkflow で loop monitor judge の provider を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review the task',
            rules: [
              {
                condition: 'done',
                next: 'COMPLETE',
              },
            ],
          },
        ],
        loop_monitors: [
          {
            cycle: ['review', 'review'],
            judge: {
              provider: 'codex',
              rules: [
                {
                  condition: 'stop',
                  next: 'ABORT',
                },
              ],
            },
          },
        ],
      },
      process.cwd(),
    )).toThrow(/review -> review/);
  });

  it('callable subworkflow で loop monitor judge の provider block option を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review the task',
            rules: [
              {
                condition: 'done',
                next: 'COMPLETE',
              },
            ],
          },
        ],
        loop_monitors: [
          {
            cycle: ['review', 'review'],
            judge: {
              provider: {
                type: 'codex',
                network_access: true,
              },
              rules: [
                {
                  condition: 'stop',
                  next: 'ABORT',
                },
              ],
            },
          },
        ],
      },
      process.cwd(),
    )).toThrow(/review -> review/);
  });

  it('callable subworkflow で loop monitor judge の model を reject する', () => {
    expect(() => normalizeWorkflowConfig(
      {
        name: 'takt/coding',
        subworkflow: {
          callable: true,
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review the task',
            rules: [
              {
                condition: 'done',
                next: 'COMPLETE',
              },
            ],
          },
        ],
        loop_monitors: [
          {
            cycle: ['review', 'review'],
            judge: {
              model: 'gpt-5-codex',
              rules: [
                {
                  condition: 'stop',
                  next: 'ABORT',
                },
              ],
            },
          },
        ],
      },
      process.cwd(),
    )).toThrow(/review -> review/);
  });
});
