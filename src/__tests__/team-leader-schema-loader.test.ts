import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { WorkflowStepRawSchema } from '../core/models/schemas.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

describe('team_leader schema', () => {
  it('max_parts <= 3 の設定を受け付ける', () => {
    const raw = {
      name: 'implement',
      team_leader: {
        persona: 'team-leader',
        max_parts: 3,
        timeout_ms: 120000,
      },
      instruction: 'decompose',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('max_concurrency と max_total_parts の設定を受け付ける', () => {
    const raw = {
      name: 'implement',
      team_leader: {
        persona: 'team-leader',
        max_concurrency: 2,
        max_total_parts: 5,
        timeout_ms: 120000,
      },
      instruction: 'decompose',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const teamLeader = result.data.team_leader as Record<string, unknown>;
    expect(teamLeader.max_concurrency).toBe(2);
    expect(teamLeader.max_total_parts).toBe(5);
  });

  it('max_parts > 3 は拒否する', () => {
    const raw = {
      name: 'implement',
      team_leader: {
        max_parts: 4,
      },
      instruction: 'decompose',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('max_concurrency > 3 は拒否する', () => {
    const raw = {
      name: 'implement',
      team_leader: {
        max_concurrency: 4,
      },
      instruction: 'decompose',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('max_total_parts > 20 は拒否する', () => {
    const raw = {
      name: 'implement',
      team_leader: {
        max_total_parts: 21,
      },
      instruction: 'decompose',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('max_parts と max_concurrency の同時指定は拒否する', () => {
    const raw = {
      name: 'implement',
      team_leader: {
        max_parts: 2,
        max_concurrency: 2,
      },
      instruction: 'decompose',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('refill_threshold > max_parts は拒否する', () => {
    const raw = {
      name: 'implement',
      team_leader: {
        max_parts: 2,
        refill_threshold: 3,
      },
      instruction: 'decompose',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('refill_threshold > max_concurrency は拒否する', () => {
    const raw = {
      name: 'implement',
      team_leader: {
        max_concurrency: 2,
        refill_threshold: 3,
      },
      instruction: 'decompose',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('parallel と team_leader の同時指定は拒否する', () => {
    const raw = {
      name: 'implement',
      parallel: [{ name: 'sub', instruction: 'x' }],
      team_leader: {
        max_parts: 2,
      },
      instruction: 'decompose',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('arpeggio と team_leader の同時指定は拒否する', () => {
    const raw = {
      name: 'implement',
      arpeggio: {
        source: 'csv',
        source_path: './data.csv',
        template: './prompt.md',
      },
      team_leader: {
        max_parts: 2,
      },
      instruction: 'decompose',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('team_leader では allow_git_commit を受け付ける', () => {
    const raw = {
      name: 'implement',
      allow_git_commit: true,
      team_leader: {
        max_parts: 2,
      },
      instruction: 'decompose',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('Given team_leader.part_tags, When parsing a step, Then part_tags are preserved', () => {
    const raw = {
      name: 'implement',
      tags: ['leader'],
      team_leader: {
        part_tags: ['coding'],
      },
      instruction: 'decompose',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.team_leader?.part_tags).toEqual(['coding']);
  });
});

describe('normalizeWorkflowConfig team_leader', () => {
  it('team_leader の新しい上限設定を内部形式へ正規化する', () => {
    const workflowDir = join(process.cwd(), 'src', '__tests__');
    const raw = {
      name: 'workflow',
      steps: [
        {
          name: 'implement',
          allow_git_commit: true,
          team_leader: {
            persona: 'team-leader',
            max_concurrency: 2,
            max_total_parts: 5,
            timeout_ms: 90000,
            part_tags: [' coding ', 'review'],
            part_persona: 'coder',
            part_allowed_tools: ['Read', 'Edit'],
            part_edit: true,
            part_permission_mode: 'edit',
          },
          instruction: 'decompose',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, workflowDir);
    const step = config.steps[0];
    expect(step).toBeDefined();
    expect(step!.allowGitCommit).toBe(true);
    expect(step!.teamLeader).toEqual({
      persona: 'team-leader',
      personaPath: undefined,
      maxConcurrency: 2,
      maxTotalParts: 5,
      refillThreshold: 0,
      timeoutMs: 90000,
      partTags: ['coding', 'review'],
      partPersona: 'coder',
      partPersonaPath: undefined,
      partAllowedTools: ['Read', 'Edit'],
      partEdit: true,
      partPermissionMode: 'edit',
    });
  });

  it('旧名 max_parts を maxConcurrency として正規化する', () => {
    const workflowDir = join(process.cwd(), 'src', '__tests__');
    const raw = {
      name: 'workflow',
      steps: [
        {
          name: 'implement',
          team_leader: {
            max_parts: 2,
          },
          instruction: 'decompose',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, workflowDir);
    const step = config.steps[0];
    expect(step).toBeDefined();
    expect(step!.teamLeader).toEqual({
      persona: undefined,
      personaPath: undefined,
      maxConcurrency: 2,
      maxTotalParts: 20,
      refillThreshold: 0,
      timeoutMs: 900000,
      partPersona: undefined,
      partPersonaPath: undefined,
      partAllowedTools: undefined,
      partEdit: undefined,
      partPermissionMode: undefined,
    });
  });

  it('Given a blank team_leader.part_tags entry, When normalizing workflow config, Then it fails fast', () => {
    const workflowDir = join(process.cwd(), 'src', '__tests__');
    const raw = {
      name: 'workflow',
      steps: [
        {
          name: 'implement',
          team_leader: {
            part_tags: ['  '],
          },
          instruction: 'decompose',
        },
      ],
    };

    expect(() => normalizeWorkflowConfig(raw, workflowDir)).toThrow(/team_leader\.part_tags/);
  });
});
