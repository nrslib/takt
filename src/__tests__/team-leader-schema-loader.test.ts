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
});

describe('normalizeWorkflowConfig team_leader', () => {
  it('team_leader を内部形式へ正規化する', () => {
    const workflowDir = join(process.cwd(), 'src', '__tests__');
    const raw = {
      name: 'workflow',
      steps: [
        {
          name: 'implement',
          allow_git_commit: true,
          team_leader: {
            persona: 'team-leader',
            max_parts: 2,
            timeout_ms: 90000,
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
      maxParts: 2,
      refillThreshold: 0,
      timeoutMs: 90000,
      partPersona: 'coder',
      partPersonaPath: undefined,
      partAllowedTools: ['Read', 'Edit'],
      partEdit: true,
      partPermissionMode: 'edit',
    });
  });
});
