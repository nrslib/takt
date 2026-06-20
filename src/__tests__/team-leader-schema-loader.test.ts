import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  it('Given team_leader.inspect_tools, When parsing a step, Then inspect_tools are preserved', () => {
    const raw = {
      name: 'implement',
      team_leader: {
        inspect_tools: ['read', 'glob', 'grep'],
      },
      instruction: 'decompose',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.team_leader?.inspect_tools).toEqual(['read', 'glob', 'grep']);
  });

  it('Given null team_leader.inspect_tools, When parsing a step, Then it fails schema validation', () => {
    const raw = {
      name: 'implement',
      team_leader: {
        inspect_tools: null,
      },
      instruction: 'decompose',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });

  it('Given object team_leader.inspect_tools, When parsing a step, Then it fails schema validation', () => {
    const raw = {
      name: 'implement',
      team_leader: {
        inspect_tools: { read: true },
      },
      instruction: 'decompose',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
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
            inspect_tools: [' Read ', 'Glob', 'grep'],
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
      personaDisplayName: 'team-leader',
      providerRoutingPersonaKey: 'team-leader',
      maxConcurrency: 2,
      maxTotalParts: 5,
      refillThreshold: 0,
      timeoutMs: 90000,
      inspectTools: ['read', 'glob', 'grep'],
      partTags: ['coding', 'review'],
      partPersona: 'coder',
      partPersonaPath: undefined,
      partAllowedTools: ['Read', 'Edit'],
      partEdit: true,
      partPermissionMode: 'edit',
    });
  });

  it('Given direct path team_leader.persona, When normalizing workflow config, Then provider routing key keeps the raw persona path', () => {
    const workflowDir = mkdtempSync(join(tmpdir(), 'takt-test-team-leader-persona-'));
    try {
      mkdirSync(join(workflowDir, 'agents'), { recursive: true });
      writeFileSync(join(workflowDir, 'agents', 'lead.md'), 'You are the planning lead.', 'utf-8');
      const raw = {
        name: 'workflow',
        steps: [
          {
            name: 'implement',
            team_leader: {
              persona: './agents/lead.md',
              inspect_tools: ['read'],
            },
            instruction: 'decompose',
          },
        ],
      };

      const config = normalizeWorkflowConfig(raw, workflowDir);
      const step = config.steps[0];

      expect(step?.teamLeader?.providerRoutingPersonaKey).toBe('./agents/lead.md');
      expect(step?.teamLeader?.personaDisplayName).toBe('lead');
    } finally {
      rmSync(workflowDir, { recursive: true, force: true });
    }
  });

  it('Given blank team_leader.persona, When normalizing workflow config, Then provider routing key is unset', () => {
    const workflowDir = join(process.cwd(), 'src', '__tests__');
    const raw = {
      name: 'workflow',
      steps: [
        {
          name: 'implement',
          persona: 'coder',
          team_leader: {
            persona: '   ',
          },
          instruction: 'decompose',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, workflowDir);
    const step = config.steps[0];

    expect(step?.teamLeader?.providerRoutingPersonaKey).toBeUndefined();
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
      personaDisplayName: undefined,
      providerRoutingPersonaKey: undefined,
      maxConcurrency: 2,
      maxTotalParts: 20,
      refillThreshold: 0,
      timeoutMs: 900000,
      inspectTools: undefined,
      partPersona: undefined,
      partPersonaPath: undefined,
      partAllowedTools: undefined,
      partEdit: undefined,
      partPermissionMode: undefined,
    });
  });

  it('Given empty team_leader.inspect_tools, When normalizing workflow config, Then it is treated as unset', () => {
    const workflowDir = join(process.cwd(), 'src', '__tests__');
    const raw = {
      name: 'workflow',
      steps: [
        {
          name: 'implement',
          team_leader: {
            inspect_tools: [],
          },
          instruction: 'decompose',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, workflowDir);
    const step = config.steps[0];

    expect(step?.teamLeader?.inspectTools).toBeUndefined();
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

  it('Given non-read-only team_leader.inspect_tools, When normalizing workflow config, Then it fails fast', () => {
    const workflowDir = join(process.cwd(), 'src', '__tests__');
    const invalidTools = ['edit', 'write', 'bash', 'websearch', 'webfetch'];

    for (const invalidTool of invalidTools) {
      const raw = {
        name: 'workflow',
        steps: [
          {
            name: 'implement',
            team_leader: {
              inspect_tools: ['read', invalidTool],
            },
            instruction: 'decompose',
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, workflowDir))
        .toThrow(new RegExp(`team_leader\\.inspect_tools.*${invalidTool}`));
    }
  });

  it('Given a blank team_leader.inspect_tools entry, When normalizing workflow config, Then it fails fast', () => {
    const workflowDir = join(process.cwd(), 'src', '__tests__');
    const raw = {
      name: 'workflow',
      steps: [
        {
          name: 'implement',
          team_leader: {
            inspect_tools: ['  '],
          },
          instruction: 'decompose',
        },
      ],
    };

    expect(() => normalizeWorkflowConfig(raw, workflowDir)).toThrow(/team_leader\.inspect_tools/);
  });
});
