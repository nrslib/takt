import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  WorkflowConfigRawSchema,
  LoopMonitorJudgeSchema,
  ParallelSubStepRawSchema,
  WorkflowStepRawSchema,
} from '../core/models/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

const workflowDir = join(process.cwd(), 'src', '__tests__');

function readText(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function expectFailurePath(
  result:
    | ReturnType<typeof WorkflowStepRawSchema.safeParse>
    | ReturnType<typeof ParallelSubStepRawSchema.safeParse>
    | ReturnType<typeof LoopMonitorJudgeSchema.safeParse>
    | ReturnType<typeof WorkflowConfigRawSchema.safeParse>,
  expectedPath: Array<string | number>,
): void {
  expect(result.success).toBe(false);
  if (result.success) {
    return;
  }

  expect(result.error.issues.some((issue) => issue.path.join('.') === expectedPath.join('.'))).toBe(true);
}

describe('instruction_template removal', () => {
  it('step schema should reject instruction_template', () => {
    const raw = {
      name: 'implement',
      instruction_template: 'Legacy instruction',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);

    expectFailurePath(result, ['instruction_template']);
  });

  it('parallel sub-step schema should reject instruction_template', () => {
    const raw = {
      name: 'review',
      instruction_template: 'Legacy review instruction',
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);

    expectFailurePath(result, ['instruction_template']);
  });

  it('loop monitor judge schema should reject instruction_template', () => {
    const raw = {
      persona: 'reviewer',
      instruction_template: 'Legacy judge instruction',
      rules: [{ condition: 'continue', next: 'ai_fix' }],
    };

    const result = LoopMonitorJudgeSchema.safeParse(raw);

    expectFailurePath(result, ['instruction_template']);
  });

  it('workflow config schema should reject instruction_template on a step', () => {
    const raw = {
      name: 'test-workflow',
      steps: [
        {
          name: 'implement',
          persona: 'coder',
          instruction_template: 'Legacy step instruction',
        },
      ],
    };

    const result = WorkflowConfigRawSchema.safeParse(raw);

    expectFailurePath(result, ['steps', 0, 'instruction_template']);
  });

  it('workflow config schema should reject instruction_template on a parallel sub-step', () => {
    const raw = {
      name: 'test-workflow',
      steps: [
        {
          name: 'review',
          parallel: [
            {
              name: 'security',
              persona: 'reviewer',
              instruction_template: 'Legacy parallel instruction',
            },
          ],
        },
      ],
    };

    const result = WorkflowConfigRawSchema.safeParse(raw);

    expectFailurePath(result, ['steps', 0, 'parallel', 0, 'instruction_template']);
  });

  it('workflow config schema should reject instruction_template on a loop monitor judge', () => {
    const raw = {
      name: 'test-workflow',
      steps: [
        {
          name: 'step1',
          persona: 'coder',
          instruction: '{task}',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
      loop_monitors: [
        {
          cycle: ['step1', 'step1'],
          threshold: 2,
          judge: {
            persona: 'reviewer',
            instruction_template: 'Legacy judge instruction',
            rules: [{ condition: 'continue', next: 'step1' }],
          },
        },
      ],
    };

    const result = WorkflowConfigRawSchema.safeParse(raw);

    expectFailurePath(result, ['loop_monitors', 0, 'judge', 'instruction_template']);
  });

  it('normalizeWorkflowConfig should fail fast without deprecation warning when a step uses instruction_template', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const raw = {
        name: 'test-workflow',
        steps: [
          {
            name: 'implement',
            persona: 'coder',
            instruction_template: 'Legacy step instruction',
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, workflowDir)).toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('normalizeWorkflowConfig should fail fast without deprecation warning when a loop monitor judge uses instruction_template', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const raw = {
        name: 'test-workflow',
        steps: [
          {
            name: 'step1',
            persona: 'coder',
            instruction: '{task}',
            rules: [{ condition: 'next', next: 'step2' }],
          },
          {
            name: 'step2',
            persona: 'coder',
            instruction: '{task}',
            rules: [{ condition: 'done', next: 'COMPLETE' }],
          },
        ],
        loop_monitors: [
          {
            cycle: ['step1', 'step2'],
            threshold: 2,
            judge: {
              persona: 'reviewer',
              instruction_template: 'Legacy judge instruction',
              rules: [{ condition: 'continue', next: 'step2' }],
            },
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, workflowDir)).toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps removed instruction_template terminology out of docs and internal comments', () => {
    const dataFlow = readText('../../docs/data-flow.md');
    const runner = readText('../agents/runner.ts');
    const escape = readText('../core/workflow/instruction/escape.ts');
    const skillReference = readText('../../builtins/skill/references/engine.md');
    const schemaReference = readText('../../builtins/skill-codex/references/yaml-schema.md');

    expect(dataFlow).not.toContain('instruction_template');
    expect(runner).not.toContain('instruction_template');
    expect(escape).not.toContain('instruction_template');
    expect(skillReference).not.toContain('instruction_template');
    expect(schemaReference).toContain('`instruction`');
    expect(schemaReference).toContain('受理されない');
  });
});
