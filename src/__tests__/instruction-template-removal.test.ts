import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  PieceConfigRawSchema,
  LoopMonitorJudgeSchema,
  ParallelSubMovementRawSchema,
  PieceMovementRawSchema,
} from '../core/models/index.js';
import { normalizePieceConfig } from '../infra/config/loaders/pieceParser.js';

const pieceDir = join(process.cwd(), 'src', '__tests__');

function expectFailurePath(
  result:
    | ReturnType<typeof PieceMovementRawSchema.safeParse>
    | ReturnType<typeof ParallelSubMovementRawSchema.safeParse>
    | ReturnType<typeof LoopMonitorJudgeSchema.safeParse>
    | ReturnType<typeof PieceConfigRawSchema.safeParse>,
  expectedPath: Array<string | number>,
): void {
  expect(result.success).toBe(false);
  if (result.success) {
    return;
  }

  expect(result.error.issues.some((issue) => issue.path.join('.') === expectedPath.join('.'))).toBe(true);
}

describe('allow_git_commit schema and parser', () => {
  it('movement schema should accept allow_git_commit: true', () => {
    const raw = {
      name: 'implement',
      allow_git_commit: true,
    };

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allow_git_commit).toBe(true);
    }
  });

  it('movement schema should accept allow_git_commit: false', () => {
    const raw = {
      name: 'implement',
      allow_git_commit: false,
    };

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allow_git_commit).toBe(false);
    }
  });

  it('movement schema should default allow_git_commit to false when omitted', () => {
    const raw = {
      name: 'implement',
    };

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allow_git_commit).toBe(false);
    }
  });

  it('parallel sub-movement schema should accept allow_git_commit: true', () => {
    const raw = {
      name: 'review',
      allow_git_commit: true,
    };

    const result = ParallelSubMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allow_git_commit).toBe(true);
    }
  });

  it('parallel sub-movement schema should default allow_git_commit to false when omitted', () => {
    const raw = {
      name: 'review',
    };

    const result = ParallelSubMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allow_git_commit).toBe(false);
    }
  });

  it('normalizePieceConfig should map allow_git_commit: true to allowGitCommit: true', () => {
    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'commit-step',
          allow_git_commit: true,
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, pieceDir);

    expect(config.movements[0]?.allowGitCommit).toBe(true);
  });

  it('normalizePieceConfig should default allowGitCommit to false when allow_git_commit is omitted', () => {
    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'normal-step',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, pieceDir);

    expect(config.movements[0]?.allowGitCommit).toBe(false);
  });

  it('normalizePieceConfig should map allow_git_commit on parallel sub-movements', () => {
    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'reviews',
          parallel: [
            {
              name: 'review-a',
              allow_git_commit: true,
              instruction: '{task}',
            },
            {
              name: 'review-b',
              instruction: '{task}',
            },
          ],
          rules: [
            { condition: 'all("done")', next: 'COMPLETE' },
          ],
        },
      ],
    };

    const config = normalizePieceConfig(raw, pieceDir);

    expect(config.movements[0]?.parallel?.[0]?.allowGitCommit).toBe(true);
    expect(config.movements[0]?.parallel?.[1]?.allowGitCommit).toBe(false);
  });
});

describe('instruction_template removal', () => {
  it('movement schema should reject instruction_template', () => {
    const raw = {
      name: 'implement',
      instruction_template: 'Legacy instruction',
    };

    const result = PieceMovementRawSchema.safeParse(raw);

    expectFailurePath(result, ['instruction_template']);
  });

  it('parallel sub-movement schema should reject instruction_template', () => {
    const raw = {
      name: 'review',
      instruction_template: 'Legacy review instruction',
    };

    const result = ParallelSubMovementRawSchema.safeParse(raw);

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

  it('piece config schema should reject instruction_template on a movement', () => {
    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'implement',
          persona: 'coder',
          instruction_template: 'Legacy movement instruction',
        },
      ],
    };

    const result = PieceConfigRawSchema.safeParse(raw);

    expectFailurePath(result, ['movements', 0, 'instruction_template']);
  });

  it('piece config schema should reject instruction_template on a parallel sub-movement', () => {
    const raw = {
      name: 'test-piece',
      movements: [
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

    const result = PieceConfigRawSchema.safeParse(raw);

    expectFailurePath(result, ['movements', 0, 'parallel', 0, 'instruction_template']);
  });

  it('piece config schema should reject instruction_template on a loop monitor judge', () => {
    const raw = {
      name: 'test-piece',
      movements: [
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

    const result = PieceConfigRawSchema.safeParse(raw);

    expectFailurePath(result, ['loop_monitors', 0, 'judge', 'instruction_template']);
  });

  it('normalizePieceConfig should fail fast without deprecation warning when a movement uses instruction_template', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const raw = {
        name: 'test-piece',
        steps: [
          {
            name: 'implement',
            persona: 'coder',
            instruction_template: 'Legacy movement instruction',
          },
        ],
      };

      expect(() => normalizePieceConfig(raw, pieceDir)).toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('normalizePieceConfig should fail fast without deprecation warning when a loop monitor judge uses instruction_template', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const raw = {
        name: 'test-piece',
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

      expect(() => normalizePieceConfig(raw, pieceDir)).toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
