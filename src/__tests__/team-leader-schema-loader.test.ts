import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { PieceMovementRawSchema } from '../core/models/schemas.js';
import { normalizePieceConfig } from '../infra/config/loaders/pieceParser.js';

describe('team_leader schema', () => {
  it('max_subtasks <= 3 の設定を受け付ける', () => {
    const raw = {
      name: 'implement',
      team_leader: {
        persona: 'team-leader',
        max_subtasks: 3,
        timeout_ms: 120000,
      },
      instruction_template: 'decompose',
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('max_subtasks > 3 は拒否する', () => {
    const raw = {
      name: 'implement',
      team_leader: {
        max_subtasks: 4,
      },
      instruction_template: 'decompose',
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('parallel と team_leader の同時指定は拒否する', () => {
    const raw = {
      name: 'implement',
      parallel: [{ name: 'sub', instruction_template: 'x' }],
      team_leader: {
        max_subtasks: 2,
      },
      instruction_template: 'decompose',
    };

    const result = PieceMovementRawSchema.safeParse(raw);
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
        max_subtasks: 2,
      },
      instruction_template: 'decompose',
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });
});

describe('normalizePieceConfig team_leader', () => {
  it('team_leader を内部形式へ正規化する', () => {
    const pieceDir = join(process.cwd(), 'src', '__tests__');
    const raw = {
      name: 'piece',
      movements: [
        {
          name: 'implement',
          team_leader: {
            persona: 'team-leader',
            max_subtasks: 2,
            timeout_ms: 90000,
            subtask_persona: 'coder',
            subtask_allowed_tools: ['Read', 'Edit'],
            subtask_edit: true,
            subtask_permission_mode: 'edit',
          },
          instruction_template: 'decompose',
        },
      ],
    };

    const config = normalizePieceConfig(raw, pieceDir);
    const movement = config.movements[0];
    expect(movement).toBeDefined();
    expect(movement!.teamLeader).toEqual({
      persona: 'team-leader',
      personaPath: undefined,
      maxSubtasks: 2,
      timeoutMs: 90000,
      subtaskPersona: 'coder',
      subtaskPersonaPath: undefined,
      subtaskAllowedTools: ['Read', 'Edit'],
      subtaskEdit: true,
      subtaskPermissionMode: 'edit',
    });
  });
});
