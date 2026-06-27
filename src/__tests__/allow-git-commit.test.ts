import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ParallelSubStepRawSchema,
  WorkflowStepRawSchema,
} from '../core/models/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'takt-allow-git-commit-'));
}

function withTestDir<T>(run: (testDir: string) => T): T {
  const testDir = createTestDir();
  try {
    return run(testDir);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
}

function normalizeFirstStep(
  rawStep: Record<string, unknown>,
  testDir: string,
) {
  const config = normalizeWorkflowConfig({
    name: 'allow-git-commit-test',
    steps: [rawStep],
  }, testDir);

  return config.steps[0]!;
}

describe('allow_git_commit', () => {
  describe('raw schema', () => {
    it('should default allow_git_commit to false for agent steps when omitted', () => {
      const result = WorkflowStepRawSchema.safeParse({
        name: 'implement',
        persona: 'coder',
        instruction: '{task}',
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.allow_git_commit).toBe(false);
    });

    it('should accept allow_git_commit on parallel sub-steps and preserve omission for parent inheritance', () => {
      const omitted = ParallelSubStepRawSchema.safeParse({
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review the implementation',
      });
      const enabled = ParallelSubStepRawSchema.safeParse({
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review the implementation',
        allow_git_commit: true,
      });

      expect(omitted.success).toBe(true);
      if (omitted.success) {
        expect(omitted.data.allow_git_commit).toBeUndefined();
      }

      expect(enabled.success).toBe(true);
      if (enabled.success) {
        expect(enabled.data.allow_git_commit).toBe(true);
      }
    });

    it('should reject allow_git_commit on workflow_call steps', () => {
      const result = WorkflowStepRawSchema.safeParse({
        name: 'delegate',
        kind: 'workflow_call',
        call: 'shared/review-loop',
        allow_git_commit: true,
        rules: [
          {
            condition: 'COMPLETE',
            next: 'COMPLETE',
          },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['allow_git_commit'],
          message: 'workflow_call step does not allow "allow_git_commit"',
        }),
      ]));
    });

    it('should reject allow_git_commit on system steps', () => {
      const result = WorkflowStepRawSchema.safeParse({
        name: 'route_context',
        mode: 'system',
        allow_git_commit: true,
        rules: [
          {
            when: 'true',
            next: 'COMPLETE',
          },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['allow_git_commit'],
          message: 'System step does not allow "allow_git_commit"',
        }),
      ]));
    });

    it('should accept allow_git_commit on team_leader steps and default it when omitted', () => {
      const omitted = WorkflowStepRawSchema.safeParse({
        name: 'delegate',
        persona: 'coder',
        instruction: '{task}',
        team_leader: {
          max_parts: 2,
        },
      });
      const enabled = WorkflowStepRawSchema.safeParse({
        name: 'delegate',
        persona: 'coder',
        instruction: '{task}',
        allow_git_commit: true,
        team_leader: {
          max_parts: 2,
        },
      });

      expect(omitted.success).toBe(true);
      if (omitted.success) {
        expect(omitted.data.allow_git_commit).toBe(false);
      }

      expect(enabled.success).toBe(true);
      if (enabled.success) {
        expect(enabled.data.allow_git_commit).toBe(true);
      }
    });

    it('should accept allow_git_commit on arpeggio steps and default it when omitted', () => {
      const omitted = WorkflowStepRawSchema.safeParse({
        name: 'batch',
        persona: 'coder',
        instruction: '{task}',
        arpeggio: {
          source: 'csv',
          source_path: './data.csv',
          template: './prompt.md',
        },
      });
      const enabled = WorkflowStepRawSchema.safeParse({
        name: 'batch',
        persona: 'coder',
        instruction: '{task}',
        allow_git_commit: true,
        arpeggio: {
          source: 'csv',
          source_path: './data.csv',
          template: './prompt.md',
        },
      });

      expect(omitted.success).toBe(true);
      if (omitted.success) {
        expect(omitted.data.allow_git_commit).toBe(false);
      }

      expect(enabled.success).toBe(true);
      if (enabled.success) {
        expect(enabled.data.allow_git_commit).toBe(true);
      }
    });
  });

  describe('normalization', () => {
    it('should preserve allowGitCommit for agent, arpeggio, parallel, and team_leader steps', () => {
      withTestDir((testDir) => {
        const config = normalizeWorkflowConfig({
          name: 'allow-git-commit-test',
          steps: [
            {
              name: 'implement',
              persona: 'coder',
              instruction: '{task}',
              allow_git_commit: true,
            },
            {
              name: 'delegate',
              persona: 'coder',
              instruction: '{task}',
              allow_git_commit: true,
              team_leader: {
                max_parts: 2,
              },
            },
            {
              name: 'batch',
              persona: 'coder',
              instruction: '{task}',
              allow_git_commit: true,
              arpeggio: {
                source: 'csv',
                source_path: './data.csv',
                template: './prompt.md',
              },
            },
            {
              name: 'review',
              parallel: [
                {
                  name: 'security',
                  persona: 'reviewer',
                  instruction: 'Review the security impact',
                  allow_git_commit: true,
                },
                {
                  name: 'qa',
                  persona: 'reviewer',
                  instruction: 'Review the regression risk',
                },
              ],
              rules: [
                {
                  condition: 'all("done")',
                  next: 'COMPLETE',
                },
              ],
            },
          ],
        }, testDir);

        expect(config.steps[0]).toMatchObject({ allowGitCommit: true });
        expect(config.steps[1]).toMatchObject({ allowGitCommit: true });
        expect(config.steps[2]).toMatchObject({ allowGitCommit: true });
        expect(config.steps[3]!.parallel?.[0]).toMatchObject({ allowGitCommit: true });
        expect(config.steps[3]!.parallel?.[1]).toMatchObject({ allowGitCommit: false });
      });
    });

    it('should inherit allowGitCommit from a parallel parent only when the sub-step omits it', () => {
      withTestDir((testDir) => {
        const config = normalizeWorkflowConfig({
          name: 'allow-git-commit-parallel-inherit-test',
          steps: [
            {
              name: 'review',
              persona: 'reviewer',
              instruction: '{task}',
              allow_git_commit: true,
              parallel: [
                {
                  name: 'security',
                  persona: 'reviewer',
                  instruction: 'Review the security impact',
                },
                {
                  name: 'qa',
                  persona: 'reviewer',
                  instruction: 'Review the regression risk',
                  allow_git_commit: false,
                },
                {
                  name: 'docs',
                  persona: 'reviewer',
                  instruction: 'Review the documentation impact',
                  allow_git_commit: true,
                },
              ],
              rules: [
                {
                  condition: 'all("done")',
                  next: 'COMPLETE',
                },
              ],
            },
          ],
        }, testDir);

        expect(config.steps[0]).toMatchObject({ allowGitCommit: true });
        expect(config.steps[0]!.parallel?.[0]).toMatchObject({ allowGitCommit: true });
        expect(config.steps[0]!.parallel?.[1]).toMatchObject({ allowGitCommit: false });
        expect(config.steps[0]!.parallel?.[2]).toMatchObject({ allowGitCommit: true });
      });
    });
  });

});
