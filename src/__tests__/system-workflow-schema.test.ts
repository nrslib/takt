import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowConfigRawSchema, WorkflowStepRawSchema } from '../core/models/index.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

describe('system workflow schema', () => {
  it('system step で mode/system_inputs/effects/when を保持できる', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'route_context',
      mode: 'system',
      system_inputs: [
        { type: 'task_context', source: 'current_task', as: 'task' },
      ],
      effects: [
        {
          type: 'enqueue_task',
          mode: 'new',
          workflow: 'takt-default',
          task: '{structured:plan_from_issue.task_markdown}',
        },
      ],
      rules: [
        {
          when: 'context.route_context.task.exists == true',
          next: 'plan_from_issue',
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const step = result.data as Record<string, unknown>;
      expect(step.mode).toBe('system');
      expect(step.system_inputs).toEqual([
        { type: 'task_context', source: 'current_task', as: 'task' },
      ]);
      expect(step.effects).toEqual([
        {
          type: 'enqueue_task',
          mode: 'new',
          workflow: 'takt-default',
          task: '{structured:plan_from_issue.task_markdown}',
        },
      ]);
      expect(step.rules).toEqual([
        {
          when: 'context.route_context.task.exists == true',
          next: 'plan_from_issue',
        },
      ]);
    }
  });

  it('system input の type/source 契約違反を拒否する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'route_context',
      mode: 'system',
      system_inputs: [
        { type: 'task_queue_context', source: 'current_task', as: 'queue' },
      ],
      rules: [
        {
          when: 'true',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('pr_list system input の where filter を受け付ける', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'route_context',
      mode: 'system',
      system_inputs: [
        {
          type: 'pr_list',
          source: 'current_project',
          as: 'prs',
          where: {
            author: 'nrslib',
            base_branch: 'improve',
            head_branch: 'task/*',
            managed_by_takt: true,
            same_repository: true,
            draft: false,
          },
        },
      ],
      rules: [
        {
          when: 'context.route_context.prs.length > 0',
          next: 'plan_from_existing_pr',
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const step = result.data as Record<string, unknown>;
      expect(step.system_inputs).toEqual([
        {
          type: 'pr_list',
          source: 'current_project',
          as: 'prs',
          where: {
            author: 'nrslib',
            base_branch: 'improve',
            head_branch: 'task/*',
            managed_by_takt: true,
            same_repository: true,
            draft: false,
          },
        },
      ]);
    }
  });

  it('pr_selection system input の where filter を受け付ける', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'route_context',
      mode: 'system',
      system_inputs: [
        {
          type: 'pr_selection',
          source: 'current_project',
          as: 'selected_pr',
          where: {
            head_branch: 'takt/*',
            managed_by_takt: true,
            same_repository: true,
            draft: false,
          },
        },
      ],
      rules: [
        {
          when: 'context.route_context.selected_pr.exists == true',
          next: 'plan_from_existing_pr',
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const step = result.data as Record<string, unknown>;
      expect(step.system_inputs).toEqual([
        {
          type: 'pr_selection',
          source: 'current_project',
          as: 'selected_pr',
          where: {
            head_branch: 'takt/*',
            managed_by_takt: true,
            same_repository: true,
            draft: false,
          },
        },
      ]);
    }
  });

  it('pr_selection の where がキー順だけ異なっても同じ step の pr_list と一致として扱う', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'route_context',
      mode: 'system',
      system_inputs: [
        {
          type: 'pr_list',
          source: 'current_project',
          as: 'prs',
          where: {
            head_branch: 'takt/*',
            managed_by_takt: true,
            same_repository: true,
            draft: false,
          },
        },
        {
          type: 'pr_selection',
          source: 'current_project',
          as: 'selected_pr',
          where: {
            draft: false,
            managed_by_takt: true,
            same_repository: true,
            head_branch: 'takt/*',
          },
        },
      ],
      rules: [
        {
          when: 'context.route_context.selected_pr.exists == true',
          next: 'plan_from_existing_pr',
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('pr_selection の where が同じ step の pr_list と一致しない場合は reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'route_context',
      mode: 'system',
      system_inputs: [
        {
          type: 'pr_list',
          source: 'current_project',
          as: 'prs',
          where: {
            head_branch: 'takt/*',
            managed_by_takt: true,
            same_repository: true,
            draft: false,
          },
        },
        {
          type: 'pr_selection',
          source: 'current_project',
          as: 'selected_pr',
          where: {
            head_branch: 'feature/*',
            managed_by_takt: true,
            same_repository: true,
            draft: false,
          },
        },
      ],
      rules: [
        {
          when: 'context.route_context.selected_pr.exists == true',
          next: 'plan_from_existing_pr',
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['system_inputs', 1, 'where'],
          message: 'pr_selection.where must match a pr_list.where in the same step',
        }),
      ]),
    );
  });

  it('task_queue_context system input で exclude_current_task を受け付ける', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'wait_before_next_scan',
      mode: 'system',
      system_inputs: [
        {
          type: 'task_queue_context',
          source: 'current_project',
          as: 'queue',
          exclude_current_task: true,
        },
      ],
      rules: [
        {
          when: 'exists(context.wait_before_next_scan.queue.items, item.kind == "running")',
          next: 'wait_before_next_scan',
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const step = result.data as Record<string, unknown>;
      expect(step.system_inputs).toEqual([
        {
          type: 'task_queue_context',
          source: 'current_project',
          as: 'queue',
          exclude_current_task: true,
        },
      ]);
    }
  });

  it('同じ as の system_inputs 重複を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'route_context',
      mode: 'system',
      system_inputs: [
        { type: 'task_context', source: 'current_task', as: 'task' },
        { type: 'issue_context', source: 'current_task', as: 'task' },
      ],
      rules: [
        {
          when: 'true',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['system_inputs', 1, 'as'],
          message: 'Duplicate system input binding "task" is not allowed in a single step',
        }),
      ]),
    );
  });

  it('effect の type ごとの必須フィールドを検証する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'enqueue_from_pr',
      mode: 'system',
      effects: [
        {
          type: 'enqueue_task',
          mode: 'from_pr',
          workflow: 'takt-default',
          task: '{structured:plan.task_markdown}',
        },
      ],
      rules: [
        {
          when: 'true',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('system step で parallel / arpeggio / team_leader の併用を reject する', () => {
    const parallel = WorkflowStepRawSchema.safeParse({
      name: 'route_context',
      mode: 'system',
      parallel: [{ name: 'substep' }],
      rules: [{ when: 'true', next: 'COMPLETE' }],
    });
    const arpeggio = WorkflowStepRawSchema.safeParse({
      name: 'route_context',
      mode: 'system',
      arpeggio: {
        source: 'items',
        source_path: 'items.json',
        template: '{item}',
      },
      rules: [{ when: 'true', next: 'COMPLETE' }],
    });
    const teamLeader = WorkflowStepRawSchema.safeParse({
      name: 'route_context',
      mode: 'system',
      team_leader: {},
      rules: [{ when: 'true', next: 'COMPLETE' }],
    });

    for (const [result, field] of [
      [parallel, 'parallel'],
      [arpeggio, 'arpeggio'],
      [teamLeader, 'team_leader'],
    ] as const) {
      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: [field],
            message: `System step does not allow "${field}"`,
          }),
        ]),
      );
    }
  });

  it('enqueue_task mode ごとの禁止フィールドを reject する', () => {
    const newMode = WorkflowStepRawSchema.safeParse({
      name: 'enqueue_from_issue',
      mode: 'system',
      effects: [
        {
          type: 'enqueue_task',
          mode: 'new',
          workflow: 'takt-default',
          task: '{structured:plan.task_markdown}',
          pr: 42,
        },
      ],
      rules: [{ when: 'true', next: 'COMPLETE' }],
    });
    const fromPrMode = WorkflowStepRawSchema.safeParse({
      name: 'enqueue_from_pr',
      mode: 'system',
      effects: [
        {
          type: 'enqueue_task',
          mode: 'from_pr',
          workflow: 'takt-default',
          task: '{structured:plan.task_markdown}',
          pr: 42,
          issue: { create: true },
          worktree: { enabled: true },
        },
      ],
      rules: [{ when: 'true', next: 'COMPLETE' }],
    });

    expect(newMode.success).toBe(false);
    expect(newMode.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['effects', 0, 'pr'],
          message: 'enqueue_task mode "new" does not allow "pr"',
        }),
      ]),
    );
    expect(fromPrMode.success).toBe(false);
    expect(fromPrMode.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['effects', 0, 'issue'],
          message: 'enqueue_task mode "from_pr" does not allow "issue"',
        }),
        expect.objectContaining({
          path: ['effects', 0, 'worktree'],
          message: 'enqueue_task mode "from_pr" does not allow "worktree"',
        }),
      ]),
    );
  });

  it('system_inputs または effects を持つ step では kind: system を必須にする', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'route_context',
      system_inputs: [
        { type: 'task_context', source: 'current_task', as: 'task' },
      ],
      rules: [
        {
          when: 'true',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['mode'],
          message: 'Steps with "system_inputs" or "effects" must set kind to "system"',
        }),
      ]),
    );
  });

  it('空の system_inputs でも kind: system を必須にする', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'route_context',
      system_inputs: [],
      rules: [
        {
          when: 'true',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['mode'],
          message: 'Steps with "system_inputs" or "effects" must set kind to "system"',
        }),
      ]),
    );
  });

  it('空の effects でも kind: system を必須にする', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'route_context',
      effects: [],
      rules: [
        {
          when: 'true',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['mode'],
          message: 'Steps with "system_inputs" or "effects" must set kind to "system"',
        }),
      ]),
    );
  });

  it('effect の bare string payload を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'comment_on_existing_pr',
      mode: 'system',
      effects: [
        {
          type: 'comment_pr',
          pr: '42',
          body: 'Looks good',
        },
      ],
      rules: [
        {
          when: 'true',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('step 修飾のない effect scalar template を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'comment_on_existing_pr',
      mode: 'system',
      effects: [
        {
          type: 'comment_pr',
          pr: '{effect:comment_pr.success}',
          body: 'Looks good',
        },
      ],
      rules: [
        {
          when: 'true',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['effects', 0, 'pr']);
    expect(JSON.stringify(result.error?.issues)).toContain('Effect references must use');
  });

  it('深い structured/effect テンプレート参照を受け付ける', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'comment_on_existing_pr',
      mode: 'system',
      effects: [
        {
          type: 'comment_pr',
          pr: '{effect:lookup_pr.comment_pr.result.id}',
          body: '{structured:plan.payload.pr.comment}',
        },
      ],
      rules: [
        {
          when: 'true',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('enqueue_task issue の bare string payload を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'enqueue_from_issue',
      mode: 'system',
      effects: [
        {
          type: 'enqueue_task',
          mode: 'new',
          workflow: 'takt-default',
          task: '{structured:plan.task_markdown}',
          issue: 'labels-only',
        },
      ],
      rules: [
        {
          when: 'true',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('同じ type の effect 重複を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'prepare_merge',
      mode: 'system',
      effects: [
        {
          type: 'sync_with_root',
          pr: '{context:prepare_merge.pr.number}',
        },
        {
          type: 'sync_with_root',
          pr: '{context:prepare_merge.pr.number}',
        },
      ],
      rules: [
        {
          when: 'true',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['effects', 1, 'type'],
          message: 'Duplicate effect type "sync_with_root" is not allowed in a single step',
        }),
      ]),
    );
  });

  it('structured_output.schema_ref と delay_before_ms を受け付ける', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'plan_from_issue',
      persona: 'supervisor',
      delay_before_ms: 60000,
      instruction: 'Plan follow-up task',
      structured_output: {
        schema_ref: 'followup-task',
      },
      rules: [
        {
          when: 'structured.plan_from_issue.action == "enqueue_new_task"',
          next: 'enqueue_from_issue',
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const step = result.data as Record<string, unknown>;
      expect(step.delay_before_ms).toBe(60000);
      expect(step.structured_output).toEqual({ schema_ref: 'followup-task' });
    }
  });

  it('system step では agent 用フィールドを拒否する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'route_context',
      mode: 'system',
      persona: 'supervisor',
      mcp_servers: {
        docs: {
          type: 'http',
          url: 'https://example.test/mcp',
        },
      },
      provider_options: {
        codex: {
          network_access: true,
        },
      },
      required_permission_mode: 'edit',
      instruction: 'should not be allowed',
      structured_output: {
        schema_ref: 'followup-task',
      },
      rules: [
        {
          when: 'true',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['persona'], message: 'System step does not allow "persona"' }),
        expect.objectContaining({ path: ['mcp_servers'], message: 'System step does not allow "mcp_servers"' }),
        expect.objectContaining({ path: ['provider_options'], message: 'System step does not allow "provider_options"' }),
        expect.objectContaining({
          path: ['required_permission_mode'],
          message: 'System step does not allow "required_permission_mode"',
        }),
        expect.objectContaining({
          path: ['structured_output'],
          message: 'System step does not allow "structured_output"',
        }),
      ]),
    );
  });

  it('workflow-level schemas と schema_ref を正規化時に解決できる', () => {
    const workflowDir = mkdtempSync(join(tmpdir(), 'takt-system-schema-'));
    mkdirSync(join(workflowDir, '.takt', 'schemas'), { recursive: true });
    writeFileSync(
      join(workflowDir, '.takt', 'schemas', 'followup-task.json'),
      JSON.stringify({
        type: 'object',
        properties: {
          action: { type: 'string' },
          task_markdown: { type: 'string' },
        },
        required: ['action'],
      }),
      'utf-8',
    );

    try {
      const raw = WorkflowConfigRawSchema.parse({
        name: 'auto-improvement-loop',
        max_steps: 3,
        initial_step: 'plan_from_issue',
        schemas: {
          'followup-task': 'followup-task',
        },
        steps: [
          {
            name: 'plan_from_issue',
            persona: 'supervisor',
            instruction: 'Plan follow-up task',
            structured_output: {
              schema_ref: 'followup-task',
            },
            rules: [
              {
                when: 'structured.plan_from_issue.action == "noop"',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      });

      const normalized = normalizeWorkflowConfig(raw, workflowDir);
      const step = normalized.steps[0] as Record<string, unknown>;

      expect((normalized as Record<string, unknown>).schemas).toEqual({
        'followup-task': 'followup-task',
      });
      expect(step.structuredOutput).toEqual({
        schemaRef: 'followup-task',
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            task_markdown: { type: 'string' },
          },
          required: ['action'],
        },
      });
    } finally {
      rmSync(workflowDir, { recursive: true, force: true });
    }
  });

  it('builtin schema fallback を getResourcesDir 基準で解決できる', () => {
    const workflowDir = mkdtempSync(join(tmpdir(), 'takt-system-schema-builtins-'));

    try {
      const raw = WorkflowConfigRawSchema.parse({
        name: 'auto-improvement-loop',
        max_steps: 3,
        initial_step: 'judge',
        steps: [
          {
            name: 'judge',
            persona: 'supervisor',
            instruction: 'Judge the result',
            structured_output: {
              schema_ref: 'evaluation',
            },
            rules: [
              {
                when: 'true',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      });

      const normalized = normalizeWorkflowConfig(raw, workflowDir);
      const step = normalized.steps[0] as Record<string, unknown>;
      expect(step.structuredOutput).toEqual({
        schemaRef: 'evaluation',
        schema: expect.objectContaining({
          type: 'object',
        }),
      });
    } finally {
      rmSync(workflowDir, { recursive: true, force: true });
    }
  });

  it('builtin followup-task schema fallback を解決できる', () => {
    const workflowDir = mkdtempSync(join(tmpdir(), 'takt-system-schema-followup-builtins-'));

    try {
      const raw = WorkflowConfigRawSchema.parse({
        name: 'auto-improvement-loop',
        max_steps: 3,
        initial_step: 'plan_followup',
        steps: [
          {
            name: 'plan_followup',
            persona: 'supervisor',
            instruction: 'Plan follow-up task',
            structured_output: {
              schema_ref: 'followup-task',
            },
            rules: [
              {
                when: 'true',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      });

      const normalized = normalizeWorkflowConfig(raw, workflowDir);
      const step = normalized.steps[0] as Record<string, unknown>;
      const structuredOutput = step.structuredOutput as { schemaRef: string; schema: Record<string, unknown> };

      expect(structuredOutput.schemaRef).toBe('followup-task');
      expect(structuredOutput.schema).toEqual(expect.objectContaining({
        type: 'object',
        required: ['action'],
        additionalProperties: false,
        properties: expect.objectContaining({
          action: {
            type: 'string',
            enum: [
              'enqueue_new_task',
              'comment_on_pr',
              'enqueue_from_pr',
              'prepare_merge',
              'noop',
            ],
          },
          issue: {
            type: 'object',
            properties: {
              create: { type: 'boolean' },
              labels: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            additionalProperties: false,
          },
        }),
      }));
    } finally {
      rmSync(workflowDir, { recursive: true, force: true });
    }
  });

  it('max_steps: infinite を受け付けて正規化後も保持する', () => {
    const workflowDir = mkdtempSync(join(tmpdir(), 'takt-system-schema-infinite-'));

    try {
      const result = WorkflowConfigRawSchema.safeParse({
        name: 'auto-improvement-loop',
        max_steps: 'infinite',
        initial_step: 'route_context',
        steps: [
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
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const normalized = normalizeWorkflowConfig(result.data, workflowDir);
        expect((normalized as Record<string, unknown>).maxSteps).toBe('infinite');
      }
    } finally {
      rmSync(workflowDir, { recursive: true, force: true });
    }
  });

  it('loadWorkflowFromFile 経由でも project-local schema_ref を解決できる', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-system-schema-project-'));
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const workflowPath = join(workflowDir, 'auto-improvement-loop.yaml');

    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(join(projectDir, '.takt', 'schemas'), { recursive: true });
    writeFileSync(
      join(projectDir, '.takt', 'schemas', 'followup-task.json'),
      JSON.stringify({
        type: 'object',
        properties: {
          action: { type: 'string' },
          task_markdown: { type: 'string' },
        },
        required: ['action'],
      }),
      'utf-8',
    );
    writeFileSync(
      workflowPath,
      `name: auto-improvement-loop
max_steps: 3
initial_step: plan_from_issue
schemas:
  followup-task: followup-task
steps:
  - name: plan_from_issue
    persona: supervisor
    instruction: Plan follow-up task
    structured_output:
      schema_ref: followup-task
    rules:
      - when: structured.plan_from_issue.action == "noop"
        next: COMPLETE
`,
      'utf-8',
    );

    try {
      const normalized = loadWorkflowFromFile(workflowPath, projectDir);
      const step = normalized.steps[0] as Record<string, unknown>;

      expect(step.structuredOutput).toEqual({
        schemaRef: 'followup-task',
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            task_markdown: { type: 'string' },
          },
          required: ['action'],
        },
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('project-local に無い場合は user-local schema_ref fallback を使う', () => {
    const workflowDir = mkdtempSync(join(tmpdir(), 'takt-system-schema-user-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-global-config-'));
    const userSchemaDir = join(globalConfigDir, 'schemas');
    const schemaName = `user-followup-${Date.now()}`;
    const previousConfigDir = process.env.TAKT_CONFIG_DIR;

    mkdirSync(userSchemaDir, { recursive: true });
    writeFileSync(
      join(userSchemaDir, `${schemaName}.json`),
      JSON.stringify({
        type: 'object',
        properties: {
          action: { type: 'string' },
          source: { type: 'string', const: 'user' },
        },
        required: ['action', 'source'],
      }),
      'utf-8',
    );

    try {
      process.env.TAKT_CONFIG_DIR = globalConfigDir;
      const raw = WorkflowConfigRawSchema.parse({
        name: 'auto-improvement-loop',
        max_steps: 3,
        initial_step: 'plan_from_issue',
        steps: [
          {
            name: 'plan_from_issue',
            persona: 'supervisor',
            instruction: 'Plan follow-up task',
            structured_output: {
              schema_ref: schemaName,
            },
            rules: [
              {
                when: 'true',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      });

      const normalized = normalizeWorkflowConfig(raw, workflowDir);
      const step = normalized.steps[0] as Record<string, unknown>;

      expect(step.structuredOutput).toEqual({
        schemaRef: schemaName,
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            source: { type: 'string', const: 'user' },
          },
          required: ['action', 'source'],
        },
      });
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.TAKT_CONFIG_DIR;
      } else {
        process.env.TAKT_CONFIG_DIR = previousConfigDir;
      }
      rmSync(workflowDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('privileged な project 任意 path workflow では normalize 時点で reject する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-system-schema-trust-project-'));
    const workflowDir = join(projectDir, 'adhoc-workflows');
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-global-config-trust-'));
    const userSchemaDir = join(globalConfigDir, 'schemas');
    const previousConfigDir = process.env.TAKT_CONFIG_DIR;

    mkdirSync(join(projectDir, '.takt', 'schemas'), { recursive: true });
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(userSchemaDir, { recursive: true });
    writeFileSync(
      join(projectDir, '.takt', 'schemas', 'followup-task.json'),
      JSON.stringify({
        type: 'object',
        properties: {
          action: { type: 'string' },
          source: { type: 'string', const: 'project' },
        },
        required: ['action', 'source'],
      }),
      'utf-8',
    );
    writeFileSync(
      join(userSchemaDir, 'followup-task.json'),
      JSON.stringify({
        type: 'object',
        properties: {
          action: { type: 'string' },
          source: { type: 'string', const: 'user' },
        },
        required: ['action', 'source'],
      }),
      'utf-8',
    );

    try {
      process.env.TAKT_CONFIG_DIR = globalConfigDir;
      const raw = WorkflowConfigRawSchema.parse({
        name: 'privileged-user-workflow',
        max_steps: 3,
        initial_step: 'plan_followup',
        steps: [
          {
            name: 'plan_followup',
            persona: 'supervisor',
            instruction: 'Plan follow-up task',
            structured_output: {
              schema_ref: 'followup-task',
            },
            rules: [
              {
                when: 'true',
                next: 'merge_ready_pr',
              },
            ],
          },
          {
            name: 'merge_ready_pr',
            mode: 'system',
            effects: [
              {
                type: 'merge_pr',
                pr: 42,
              },
            ],
            rules: [
              {
                when: 'true',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      });

      expect(() => normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
      })).toThrow(/cannot use privileged system execution/);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.TAKT_CONFIG_DIR;
      } else {
        process.env.TAKT_CONFIG_DIR = previousConfigDir;
      }
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(workflowDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('privileged project-local workflow でも project-local schema_ref を解決できる', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-system-schema-privileged-project-'));
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const workflowPath = join(workflowDir, 'auto-improvement-loop.yaml');

    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(join(projectDir, '.takt', 'schemas'), { recursive: true });
    writeFileSync(
      join(projectDir, '.takt', 'schemas', 'followup-task.json'),
      JSON.stringify({
        type: 'object',
        properties: {
          action: { type: 'string' },
          source: { type: 'string', const: 'project' },
        },
        required: ['action', 'source'],
      }),
      'utf-8',
    );
    writeFileSync(
      workflowPath,
      `name: auto-improvement-loop
max_steps: 3
initial_step: plan_followup
steps:
  - name: plan_followup
    persona: supervisor
    instruction: Plan follow-up task
    structured_output:
      schema_ref: followup-task
    rules:
      - when: "true"
        next: merge_ready_pr
  - name: merge_ready_pr
    mode: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - when: "true"
        next: COMPLETE
`,
      'utf-8',
    );

    try {
      const normalized = loadWorkflowFromFile(workflowPath, projectDir);
      const step = normalized.steps[0] as Record<string, unknown>;

      expect(step.structuredOutput).toEqual({
        schemaRef: 'followup-task',
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            source: { type: 'string', const: 'project' },
          },
          required: ['action', 'source'],
        },
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('schema_ref の path traversal を拒否する', () => {
    const workflowDir = mkdtempSync(join(tmpdir(), 'takt-system-schema-invalid-'));

    try {
      const raw = WorkflowConfigRawSchema.parse({
        name: 'auto-improvement-loop',
        max_steps: 3,
        initial_step: 'judge',
        steps: [
          {
            name: 'judge',
            persona: 'supervisor',
            instruction: 'Judge the result',
            structured_output: {
              schema_ref: '../secrets',
            },
            rules: [
              {
                when: 'true',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      });

      expect(() => normalizeWorkflowConfig(raw, workflowDir)).toThrow(/Invalid schema_ref/);
    } finally {
      rmSync(workflowDir, { recursive: true, force: true });
    }
  });

  it('enqueue_task の unknown key を reject する', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'enqueue_from_issue',
      mode: 'system',
      effects: [
        {
          type: 'enqueue_task',
          mode: 'new',
          workflow: 'takt-default',
          task: '{structured:plan.task_markdown}',
          baseBranch: 'improve',
        },
      ],
      rules: [
        {
          when: 'true',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('enqueue_task worktree.auto_pr と draft_pr には enabled: true を必須にする', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'enqueue_from_issue',
      mode: 'system',
      effects: [
        {
          type: 'enqueue_task',
          mode: 'new',
          workflow: 'takt-default',
          task: '{structured:plan.task_markdown}',
          worktree: {
            auto_pr: true,
            draft_pr: true,
          },
        },
      ],
      rules: [
        {
          when: 'true',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['effects', 0, 'worktree', 'enabled'],
          message: 'worktree.auto_pr and worktree.draft_pr require worktree.enabled to be true',
        }),
      ]),
    );
  });

  it('workflow-local schemas の不正な schema 名を拒否する', () => {
    const workflowDir = mkdtempSync(join(tmpdir(), 'takt-system-schema-alias-invalid-'));

    try {
      const raw = WorkflowConfigRawSchema.parse({
        name: 'auto-improvement-loop',
        max_steps: 3,
        initial_step: 'judge',
        schemas: {
          followup: '../secrets',
        },
        steps: [
          {
            name: 'judge',
            persona: 'supervisor',
            instruction: 'Judge the result',
            structured_output: {
              schema_ref: 'followup',
            },
            rules: [
              {
                when: 'true',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      });

      expect(() => normalizeWorkflowConfig(raw, workflowDir)).toThrow(/Invalid schema_ref/);
    } finally {
      rmSync(workflowDir, { recursive: true, force: true });
    }
  });

  it('project workflow でも system effect を含む step を読み込める', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-system-project-effects-'));
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const workflowPath = join(workflowDir, 'auto-improvement-loop.yaml');

    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      workflowPath,
      `name: auto-improvement-loop
max_steps: 2
initial_step: route_context
steps:
  - name: route_context
    mode: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - when: "true"
        next: COMPLETE
`,
      'utf-8',
    );

    try {
      const workflow = loadWorkflowFromFile(workflowPath, projectDir);
      expect(workflow.steps[0]?.effects).toEqual([
        { type: 'merge_pr', pr: 42 },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('loadWorkflowFromFile 経由で project workflow の mode: system を許可する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-system-project-workflow-'));
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const workflowPath = join(workflowDir, 'auto-improvement-loop.yaml');

    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(workflowPath, `name: auto-improvement-loop
initial_step: route_context
max_steps: 2

steps:
  - name: route_context
    mode: system
    system_inputs:
      - type: task_context
        source: current_task
        as: task
    rules:
      - when: "true"
        next: COMPLETE
`, 'utf-8');

    try {
      const workflow = loadWorkflowFromFile(workflowPath, projectDir);

      expect(workflow.steps[0]?.kind).toBe('system');
      expect(workflow.steps[0]?.systemInputs).toEqual([
        { type: 'task_context', source: 'current_task', as: 'task' },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
