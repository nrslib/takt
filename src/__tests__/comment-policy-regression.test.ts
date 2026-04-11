import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const TEST_FILES = [
  'config.test.ts',
  'projectConfig.test.ts',
  'globalConfig.test.ts',
] as const;

const ISSUE_562_TASK_TEST_FILES = [
  'task-exceed-service.test.ts',
  'worktree-exceeded-requeue.test.ts',
] as const;

const ISSUE_562_POLICY_COMMENT_SOURCES = ['../features/tasks/execute/taskExecution.ts'] as const;

const ISSUE_606_INTERACTIVE_OPT_IN_TEST_FILES = [
  'piece-interactive-opt-in.test.ts',
  'cli-routing-interactive-opt-in.test.ts',
  'interactive-mode-none.test.ts',
  'interactive-mode-doc-policy-contract.test.ts',
] as const;

const gwtLineComment = /^\s*\/\/\s*(Given|When|Then)(:|\/)/;

describe('test comment policy regression', () => {
  it('should not contain Given/When/Then explanation comments in config-related tests', () => {
    for (const file of TEST_FILES) {
      const content = readFileSync(new URL(file, import.meta.url), 'utf-8');
      expect(content).not.toMatch(/\bGiven:\b/);
      expect(content).not.toMatch(/\bWhen:\b/);
      expect(content).not.toMatch(/\bThen:\b/);
    }
  });

  it('should not reintroduce removed judge-provider explanatory comments (#556 policy)', () => {
    const banned: readonly { path: string; needle: string }[] = [
      { path: '../agents/judge-status-usecase.ts', needle: 'Same as Phase 1' },
      { path: '../core/piece/evaluation/RuleEvaluator.ts', needle: 'Phase-1-aligned' },
      { path: '../core/piece/engine/OptionsBuilder.ts', needle: 'same logic as buildBaseOptions' },
      { path: '../core/piece/phase-runner.ts', needle: 'Same provider/model resolution as Phase 1' },
      { path: 'judge-runagent-provider-resolution.test.ts', needle: '実装完了まで失敗' },
    ];
    for (const { path, needle } of banned) {
      const content = readFileSync(new URL(path, import.meta.url), 'utf-8');
      expect(content).not.toContain(needle);
    }
  });

  it('should not contain Given/When/Then line comments in Issue #562 task tests (policy-comment)', () => {
    for (const file of ISSUE_562_TASK_TEST_FILES) {
      const lines = readFileSync(new URL(file, import.meta.url), 'utf-8').split('\n');
      const offenders = lines
        .map((line, i) => (gwtLineComment.test(line) ? i + 1 : null))
        .filter((n): n is number => n !== null);
      expect(offenders, file).toEqual([]);
    }
  });

  it('should not contain procedural How comments in Issue #562 task tests (policy-comment)', () => {
    const forbidden = [
      /must be before imports that use these modules/i,
      /Imports \(after mocks\)/i,
      /writeExceededRecord must come first/i,
      /addTask then reads and appends/i,
    ] as const;
    for (const file of ISSUE_562_TASK_TEST_FILES) {
      const content = readFileSync(new URL(file, import.meta.url), 'utf-8');
      for (const pattern of forbidden) {
        expect(content, `${file}: ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it('should not contain cwd/projectCwd What-How line comments in taskExecution (policy-comment)', () => {
    const forbidden = [
      /\bcwd is always the project root\b/i,
      /pass it as projectCwd/i,
    ] as const;
    for (const rel of ISSUE_562_POLICY_COMMENT_SOURCES) {
      const content = readFileSync(new URL(rel, import.meta.url), 'utf-8');
      for (const pattern of forbidden) {
        expect(content, `${rel}: ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it('should not start with file-level block doc comments in interactive opt-in tests (#606 policy-comment)', () => {
    for (const file of ISSUE_606_INTERACTIVE_OPT_IN_TEST_FILES) {
      const content = readFileSync(new URL(file, import.meta.url), 'utf-8');
      expect(content.trimStart().startsWith('/**'), file).toBe(false);
    }
  });
});
