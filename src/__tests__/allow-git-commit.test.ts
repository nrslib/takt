import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ParallelSubStepRawSchema,
  WorkflowStepRawSchema,
} from '../core/models/index.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import {
  ReportInstructionBuilder,
  type ReportInstructionContext,
} from '../core/workflow/instruction/ReportInstructionBuilder.js';
import type { InstructionContext } from '../core/workflow/instruction/instruction-context.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { loadTemplate } from '../shared/prompts/index.js';

type Language = 'en' | 'ja';

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

function createInstructionContext(language: Language): InstructionContext {
  return {
    task: 'Implement the requested change.',
    iteration: 1,
    maxSteps: 5,
    stepIteration: 1,
    cwd: '/tmp/project',
    projectCwd: '/tmp/project',
    userInputs: [],
    language,
  };
}

function createReportContext(language: Language): ReportInstructionContext {
  return {
    cwd: '/tmp/project',
    reportDir: '/tmp/project/.takt/runs/test/reports',
    stepIteration: 1,
    language,
  };
}

function gitRuleText(language: Language): { commit: string; push: string; add?: string } {
  if (language === 'ja') {
    return {
      commit: 'git commit を実行しないでください',
      push: 'git push を実行しないでください',
      add: 'git add を実行しないでください',
    };
  }

  return {
    commit: 'Do NOT run git commit',
    push: 'Do NOT run git push',
    add: 'Do NOT run git add',
  };
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

  describe('phase 1 instruction', () => {
    it.each([
      { language: 'en' as const, allowGitCommit: undefined, expectsGitRules: true },
      { language: 'en' as const, allowGitCommit: false, expectsGitRules: true },
      { language: 'en' as const, allowGitCommit: true, expectsGitRules: false },
      { language: 'ja' as const, allowGitCommit: undefined, expectsGitRules: true },
      { language: 'ja' as const, allowGitCommit: false, expectsGitRules: true },
      { language: 'ja' as const, allowGitCommit: true, expectsGitRules: false },
    ])(
      'should toggle git execution rules in Phase 1 when allow_git_commit is $allowGitCommit ($language)',
      ({ language, allowGitCommit, expectsGitRules }) => {
        withTestDir((testDir) => {
          const step = normalizeFirstStep({
            name: 'implement',
            persona: 'coder',
            instruction: '{task}',
            ...(allowGitCommit === undefined ? {} : { allow_git_commit: allowGitCommit }),
          }, testDir);

          const result = new InstructionBuilder(step, createInstructionContext(language)).build();
          const gitRule = gitRuleText(language);

          if (expectsGitRules) {
            expect(result).toContain(gitRule.commit);
            expect(result).toContain(gitRule.push);
            expect(result).toContain(gitRule.add!);
          } else {
            expect(result).not.toContain(gitRule.commit);
            expect(result).not.toContain(gitRule.push);
            expect(result).not.toContain(gitRule.add!);
          }
        });
      },
    );
  });

  describe('phase 2 instruction', () => {
    it.each([
      { language: 'en' as const, allowGitCommit: undefined, expectsGitRules: true },
      { language: 'en' as const, allowGitCommit: false, expectsGitRules: true },
      { language: 'en' as const, allowGitCommit: true, expectsGitRules: false },
      { language: 'ja' as const, allowGitCommit: undefined, expectsGitRules: true },
      { language: 'ja' as const, allowGitCommit: false, expectsGitRules: true },
      { language: 'ja' as const, allowGitCommit: true, expectsGitRules: false },
    ])(
      'should toggle git execution rules in Phase 2 when allow_git_commit is $allowGitCommit ($language)',
      ({ language, allowGitCommit, expectsGitRules }) => {
        withTestDir((testDir) => {
          const step = normalizeFirstStep({
            name: 'plan',
            persona: 'planner',
            instruction: '{task}',
            ...(allowGitCommit === undefined ? {} : { allow_git_commit: allowGitCommit }),
            output_contracts: {
              report: [
                {
                  name: '00-plan.md',
                  format: '# Plan Report',
                  use_judge: true,
                },
              ],
            },
          }, testDir);

          const result = new ReportInstructionBuilder(step, createReportContext(language)).build();
          const gitRule = gitRuleText(language);

          if (expectsGitRules) {
            expect(result).toContain(gitRule.commit);
            expect(result).toContain(gitRule.push);
          } else {
            expect(result).not.toContain(gitRule.commit);
            expect(result).not.toContain(gitRule.push);
          }
        });
      },
    );
  });

  describe('templates', () => {
    it('should keep git prohibition text out of phase templates so builders can inject it conditionally', () => {
      const phase1En = loadTemplate('perform_phase1_message', 'en');
      const phase1Ja = loadTemplate('perform_phase1_message', 'ja');
      const phase2En = loadTemplate('perform_phase2_message', 'en');
      const phase2Ja = loadTemplate('perform_phase2_message', 'ja');

      expect(phase1En).not.toContain('Do NOT run git commit');
      expect(phase1En).not.toContain('Do NOT run git push');
      expect(phase1En).not.toContain('Do NOT run git add');
      expect(phase1Ja).not.toContain('git commit を実行しないでください');
      expect(phase1Ja).not.toContain('git push を実行しないでください');
      expect(phase1Ja).not.toContain('git add を実行しないでください');
      expect(phase2En).not.toContain('Do NOT run git commit');
      expect(phase2En).not.toContain('Do NOT run git push');
      expect(phase2Ja).not.toContain('git commit を実行しないでください');
      expect(phase2Ja).not.toContain('git push を実行しないでください');
    });
  });
});
