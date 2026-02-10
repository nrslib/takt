/**
 * Tests for instruction-builder module
 */

import { describe, it, expect } from 'vitest';
import {
  InstructionBuilder,
  isOutputContractItem,
  ReportInstructionBuilder,
  StatusJudgmentBuilder,
  generateStatusRulesComponents,
  type ReportInstructionContext,
  type StatusJudgmentContext,
  type InstructionContext,
} from '../core/piece/index.js';

// Function wrappers for test readability
function buildInstruction(step: PieceMovement, ctx: InstructionContext): string {
  return new InstructionBuilder(step, ctx).build();
}
function buildReportInstruction(step: PieceMovement, ctx: ReportInstructionContext): string {
  return new ReportInstructionBuilder(step, ctx).build();
}
function buildStatusJudgmentInstruction(step: PieceMovement, ctx: StatusJudgmentContext): string {
  return new StatusJudgmentBuilder(step, ctx).build();
}
import type { PieceMovement, PieceRule } from '../core/models/index.js';


function createMinimalStep(template: string): PieceMovement {
  return {
    name: 'test-step',
    persona: 'test-agent',
    personaDisplayName: 'Test Agent',
    instructionTemplate: template,
    passPreviousResponse: false,
  };
}

function createMinimalContext(overrides: Partial<InstructionContext> = {}): InstructionContext {
  return {
    task: 'Test task',
    iteration: 1,
    maxIterations: 10,
    movementIteration: 1,
    cwd: '/project',
    projectCwd: '/project',
    userInputs: [],
    pieceName: 'test-piece',
    pieceDescription: 'Test piece description',
    ...overrides,
  };
}

describe('instruction-builder', () => {
  describe('execution context metadata', () => {
    it('should always include Working Directory', () => {
      const step = createMinimalStep('Do some work');
      const context = createMinimalContext({ cwd: '/project' });

      const result = buildInstruction(step, context);

      expect(result).toContain('## Execution Context');
      expect(result).toContain('Working Directory: /project');
      expect(result).toContain('Do some work');
    });

    it('should NOT include Project Root even when cwd !== projectCwd', () => {
      const step = createMinimalStep('Do some work');
      const context = createMinimalContext({
        cwd: '/worktree-path',
        projectCwd: '/project-path',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('## Execution Context');
      expect(result).toContain('Working Directory: /worktree-path');
      expect(result).not.toContain('Project Root');
      expect(result).not.toContain('Mode:');
      expect(result).toContain('Do some work');
    });

    it('should prepend metadata before the instruction body', () => {
      const step = createMinimalStep('Do some work');
      const context = createMinimalContext({ cwd: '/project' });

      const result = buildInstruction(step, context);
      const metadataIndex = result.indexOf('## Execution Context');
      const bodyIndex = result.indexOf('Do some work');

      expect(metadataIndex).toBeLessThan(bodyIndex);
    });

    it('should include edit enabled prompt when step.edit is true', () => {
      const step = { ...createMinimalStep('Implement feature'), edit: true as const };
      const context = createMinimalContext({ cwd: '/project' });

      const result = buildInstruction(step, context);

      expect(result).toContain('Editing is ENABLED');
    });

    it('should include edit disabled prompt when step.edit is false', () => {
      const step = { ...createMinimalStep('Review code'), edit: false as const };
      const context = createMinimalContext({ cwd: '/project' });

      const result = buildInstruction(step, context);

      expect(result).toContain('Editing is DISABLED');
    });

    it('should not include edit prompt when step.edit is undefined', () => {
      const step = createMinimalStep('Do some work');
      const context = createMinimalContext({ cwd: '/project' });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Editing is ENABLED');
      expect(result).not.toContain('Editing is DISABLED');
    });
  });

  describe('report_dir replacement', () => {
    it('should replace {report_dir} with absolute path', () => {
      const step = createMinimalStep(
        '- Report Directory: {report_dir}/'
      );
      const context = createMinimalContext({
        cwd: '/project',
        reportDir: '/project/.takt/runs/20260128-test-report/reports',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain(
        '- Report Directory: /project/.takt/runs/20260128-test-report/reports/'
      );
    });

    it('should use absolute reportDir path in worktree mode', () => {
      const step = createMinimalStep(
        '- Report: {report_dir}/00-plan.md'
      );
      const context = createMinimalContext({
        cwd: '/clone/my-task',
        projectCwd: '/project',
        reportDir: '/project/.takt/runs/20260128-worktree-report/reports',
      });

      const result = buildInstruction(step, context);

      // reportDir is now absolute, pointing to projectCwd
      expect(result).toContain(
        '- Report: /project/.takt/runs/20260128-worktree-report/reports/00-plan.md'
      );
      expect(result).toContain('Working Directory: /clone/my-task');
    });

    it('should replace multiple {report_dir} occurrences with absolute path', () => {
      const step = createMinimalStep(
        '- Scope: {report_dir}/01-scope.md\n- Decisions: {report_dir}/02-decisions.md'
      );
      const context = createMinimalContext({
        projectCwd: '/project',
        cwd: '/worktree',
        reportDir: '/project/.takt/runs/20260128-multi/reports',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('/project/.takt/runs/20260128-multi/reports/01-scope.md');
      expect(result).toContain('/project/.takt/runs/20260128-multi/reports/02-decisions.md');
    });

    it('should replace standalone {report_dir} with absolute path', () => {
      const step = createMinimalStep(
        'Report dir name: {report_dir}'
      );
      const context = createMinimalContext({
        reportDir: '/project/.takt/runs/20260128-standalone/reports',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('Report dir name: /project/.takt/runs/20260128-standalone/reports');
    });
  });

  describe('context length control and source path injection', () => {
    it('should truncate previous response and inject source path with conflict notice', () => {
      const step = createMinimalStep('Continue work');
      step.passPreviousResponse = true;
      const longResponse = 'x'.repeat(2100);
      const context = createMinimalContext({
        previousOutput: {
          persona: 'coder',
          status: 'done',
          content: longResponse,
          timestamp: new Date(),
        },
        previousResponseSourcePath: '.takt/runs/test/context/previous_responses/latest.md',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('...TRUNCATED...');
      expect(result).toContain('Source: .takt/runs/test/context/previous_responses/latest.md');
      expect(result).toContain('If prompt content conflicts with source files, source files take precedence.');
    });

    it('should always inject source paths when content is not truncated', () => {
      const step = createMinimalStep('Do work');
      step.passPreviousResponse = true;
      const context = createMinimalContext({
        previousOutput: {
          persona: 'reviewer',
          status: 'done',
          content: 'short previous response',
          timestamp: new Date(),
        },
        previousResponseSourcePath: '.takt/runs/test/context/previous_responses/latest.md',
        knowledgeContents: ['short knowledge'],
        knowledgeSourcePath: '.takt/runs/test/context/knowledge/implement.1.20260210T010203Z.md',
        policyContents: ['short policy'],
        policySourcePath: '.takt/runs/test/context/policy/implement.1.20260210T010203Z.md',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('Knowledge Source: .takt/runs/test/context/knowledge/implement.1.20260210T010203Z.md');
      expect(result).toContain('Policy Source: .takt/runs/test/context/policy/implement.1.20260210T010203Z.md');
      expect(result).toContain('Source: .takt/runs/test/context/previous_responses/latest.md');
      expect(result).not.toContain('...TRUNCATED...');
      expect(result).not.toContain('Knowledge is truncated.');
      expect(result).not.toContain('Policy is authoritative. If truncated');
      expect(result).not.toContain('Previous Response is truncated.');
    });

    it('should not truncate when content length is exactly 2000 chars', () => {
      const step = createMinimalStep('Do work');
      step.passPreviousResponse = true;
      const exactBoundary = 'x'.repeat(2000);
      const context = createMinimalContext({
        previousOutput: {
          persona: 'reviewer',
          status: 'done',
          content: exactBoundary,
          timestamp: new Date(),
        },
        previousResponseSourcePath: '.takt/runs/test/context/previous_responses/latest.md',
        knowledgeContents: [exactBoundary],
        knowledgeSourcePath: '.takt/runs/test/context/knowledge/implement.1.20260210T010203Z.md',
        policyContents: [exactBoundary],
        policySourcePath: '.takt/runs/test/context/policy/implement.1.20260210T010203Z.md',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('Knowledge Source: .takt/runs/test/context/knowledge/implement.1.20260210T010203Z.md');
      expect(result).toContain('Policy Source: .takt/runs/test/context/policy/implement.1.20260210T010203Z.md');
      expect(result).toContain('Source: .takt/runs/test/context/previous_responses/latest.md');
      expect(result).not.toContain('...TRUNCATED...');
    });

    it('should inject required truncated warning and source path for knowledge/policy', () => {
      const step = createMinimalStep('Do work');
      const longKnowledge = 'k'.repeat(2200);
      const longPolicy = 'p'.repeat(2200);
      const context = createMinimalContext({
        knowledgeContents: [longKnowledge],
        knowledgeSourcePath: '.takt/runs/test/context/knowledge/implement.1.20260210T010203Z.md',
        policyContents: [longPolicy],
        policySourcePath: '.takt/runs/test/context/policy/implement.1.20260210T010203Z.md',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('Knowledge is truncated. You MUST consult the source files before making decisions.');
      expect(result).toContain('Policy is authoritative. If truncated, you MUST read the full policy file and follow it strictly.');
      expect(result).toContain('Knowledge Source: .takt/runs/test/context/knowledge/implement.1.20260210T010203Z.md');
      expect(result).toContain('Policy Source: .takt/runs/test/context/policy/implement.1.20260210T010203Z.md');
    });
  });

  describe('generateStatusRulesComponents', () => {
    const rules: PieceRule[] = [
      { condition: '要件が明確で実装可能', next: 'implement' },
      { condition: 'ユーザーが質問をしている', next: 'COMPLETE' },
      { condition: '要件が不明確、情報不足', next: 'ABORT', appendix: '確認事項:\n- {質問1}\n- {質問2}' },
    ];

    it('should generate criteria table with numbered tags (ja)', () => {
      const result = generateStatusRulesComponents('plan', rules, 'ja');

      expect(result.criteriaTable).toContain('| 1 | 要件が明確で実装可能 | `[PLAN:1]` |');
      expect(result.criteriaTable).toContain('| 2 | ユーザーが質問をしている | `[PLAN:2]` |');
      expect(result.criteriaTable).toContain('| 3 | 要件が不明確、情報不足 | `[PLAN:3]` |');
    });

    it('should generate criteria table with numbered tags (en)', () => {
      const enRules: PieceRule[] = [
        { condition: 'Requirements are clear', next: 'implement' },
        { condition: 'User is asking a question', next: 'COMPLETE' },
      ];
      const result = generateStatusRulesComponents('plan', enRules, 'en');

      expect(result.criteriaTable).toContain('| 1 | Requirements are clear | `[PLAN:1]` |');
      expect(result.criteriaTable).toContain('| 2 | User is asking a question | `[PLAN:2]` |');
    });

    it('should generate output list with condition labels', () => {
      const result = generateStatusRulesComponents('plan', rules, 'ja');

      expect(result.outputList).toContain('`[PLAN:1]` — 要件が明確で実装可能');
      expect(result.outputList).toContain('`[PLAN:2]` — ユーザーが質問をしている');
      expect(result.outputList).toContain('`[PLAN:3]` — 要件が不明確、情報不足');
    });

    it('should generate appendix content when rules have appendix', () => {
      const result = generateStatusRulesComponents('plan', rules, 'ja');

      expect(result.hasAppendix).toBe(true);
      expect(result.appendixContent).toContain('[[PLAN:3]]');
      expect(result.appendixContent).toContain('確認事項:');
      expect(result.appendixContent).toContain('- {質問1}');
    });

    it('should not generate appendix when no rules have appendix', () => {
      const noAppendixRules: PieceRule[] = [
        { condition: 'Done', next: 'review' },
        { condition: 'Blocked', next: 'plan' },
      ];
      const result = generateStatusRulesComponents('implement', noAppendixRules, 'en');

      expect(result.hasAppendix).toBe(false);
      expect(result.appendixContent).toBe('');
    });

    it('should uppercase step name in tags', () => {
      const result = generateStatusRulesComponents('ai_review', [
        { condition: 'No issues', next: 'supervise' },
      ], 'en');

      expect(result.criteriaTable).toContain('`[AI_REVIEW:1]`');
    });

    it('should omit interactive-only rules when interactive is false', () => {
      const filteredRules: PieceRule[] = [
        { condition: 'Clear', next: 'implement' },
        { condition: 'User input required', next: 'implement', interactiveOnly: true },
        { condition: 'Blocked', next: 'plan' },
      ];
      const result = generateStatusRulesComponents('implement', filteredRules, 'en', { interactive: false });

      expect(result.criteriaTable).toContain('`[IMPLEMENT:1]`');
      expect(result.criteriaTable).toContain('`[IMPLEMENT:3]`');
      expect(result.criteriaTable).not.toContain('User input required');
      expect(result.criteriaTable).not.toContain('`[IMPLEMENT:2]`');
    });
  });

  describe('buildInstruction with rules (Phase 1 — status rules injection)', () => {
    it('should include status rules when tag-based rules exist', () => {
      const step = createMinimalStep('Do work');
      step.name = 'plan';
      step.rules = [
        { condition: 'Clear requirements', next: 'implement' },
        { condition: 'Unclear', next: 'ABORT' },
      ];
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      // Status rules are no longer injected in Phase 1 (only in Phase 3)
      expect(result).not.toContain('Decision Criteria');
    });

    it('should not add status rules when rules do not exist', () => {
      const step = createMinimalStep('Do work');
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Decision Criteria');
    });

    it('should not auto-generate when rules array is empty', () => {
      const step = createMinimalStep('Do work');
      step.rules = [];
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Decision Criteria');
    });
  });

  describe('auto-injected Piece Context section', () => {
    it('should include piece name when provided', () => {
      const step = createMinimalStep('Do work');
      const context = createMinimalContext({
        pieceName: 'my-piece',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('## Piece Context');
      expect(result).toContain('- Piece: my-piece');
    });

    it('should include piece description when provided', () => {
      const step = createMinimalStep('Do work');
      const context = createMinimalContext({
        pieceName: 'my-piece',
        pieceDescription: 'A test piece for validation',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('## Piece Context');
      expect(result).toContain('- Piece: my-piece');
      expect(result).toContain('- Description: A test piece for validation');
    });

    it('should not show description when not provided', () => {
      const step = createMinimalStep('Do work');
      const context = createMinimalContext({
        pieceName: 'my-piece',
        pieceDescription: undefined,
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('- Piece: my-piece');
      expect(result).not.toContain('- Description:');
    });

    it('should render piece context in Japanese', () => {
      const step = createMinimalStep('Do work');
      const context = createMinimalContext({
        pieceName: 'coding',
        pieceDescription: 'コーディングピース',
        language: 'ja',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('- ピース: coding');
      expect(result).toContain('- 説明: コーディングピース');
    });

    it('should include iteration, step iteration, and step name', () => {
      const step = createMinimalStep('Do work');
      step.name = 'implement';
      const context = createMinimalContext({
        iteration: 3,
        maxIterations: 20,
        movementIteration: 2,
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('## Piece Context');
      expect(result).toContain('- Iteration: 3/20');
      expect(result).toContain('- Movement Iteration: 2');
      expect(result).toContain('- Movement: implement');
    });

    it('should include report info in Phase 1 when step has report', () => {
      const step = createMinimalStep('Do work');
      step.name = 'plan';
      step.outputContracts = [{ name: '00-plan.md' }];
      const context = createMinimalContext({
        reportDir: '/project/.takt/runs/20260129-test/reports',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('## Piece Context');
      expect(result).toContain('Report Directory');
      expect(result).toContain('Report File');
      expect(result).toContain('Phase 1');
    });

    it('should include report info for OutputContractEntry[] in Phase 1', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [
        { label: 'Scope', path: '01-scope.md' },
        { label: 'Decisions', path: '02-decisions.md' },
      ];
      const context = createMinimalContext({
        reportDir: '/project/.takt/runs/20260129-test/reports',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('Report Directory');
      expect(result).toContain('Report Files');
      expect(result).toContain('Phase 1');
    });

    it('should include report info for OutputContractItem in Phase 1', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [{ name: '00-plan.md' }];
      const context = createMinimalContext({
        reportDir: '/project/.takt/runs/20260129-test/reports',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      // Phase 1 now includes Report Directory info and phase note
      expect(result).toContain('Report Directory');
      expect(result).toContain('Report File');
      expect(result).toContain('Phase 1');
    });

    it('should render Japanese step iteration suffix', () => {
      const step = createMinimalStep('Do work');
      const context = createMinimalContext({
        movementIteration: 3,
        language: 'ja',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('- Movement Iteration: 3（このムーブメントの実行回数）');
    });

    it('should include piece structure when pieceSteps is provided', () => {
      const step = createMinimalStep('Do work');
      step.name = 'implement';
      const context = createMinimalContext({
        language: 'en',
        pieceMovements: [
          { name: 'plan' },
          { name: 'implement' },
          { name: 'review' },
        ],
        currentMovementIndex: 1,
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('This piece consists of 3 movements:');
      expect(result).toContain('- Movement 1: plan');
      expect(result).toContain('- Movement 2: implement');
      expect(result).toContain('← current');
      expect(result).toContain('- Movement 3: review');
    });

    it('should mark current step with marker', () => {
      const step = createMinimalStep('Do work');
      step.name = 'plan';
      const context = createMinimalContext({
        language: 'en',
        pieceMovements: [
          { name: 'plan' },
          { name: 'implement' },
        ],
        currentMovementIndex: 0,
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('- Movement 1: plan ← current');
      expect(result).not.toContain('- Movement 2: implement ← current');
    });

    it('should include description in parentheses when provided', () => {
      const step = createMinimalStep('Do work');
      step.name = 'plan';
      const context = createMinimalContext({
        language: 'ja',
        pieceMovements: [
          { name: 'plan', description: 'タスクを分析し実装計画を作成する' },
          { name: 'implement' },
        ],
        currentMovementIndex: 0,
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('- Movement 1: plan（タスクを分析し実装計画を作成する） ← 現在');
    });

    it('should skip piece structure when pieceSteps is not provided', () => {
      const step = createMinimalStep('Do work');
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('This piece consists of');
    });

    it('should skip piece structure when pieceSteps is empty', () => {
      const step = createMinimalStep('Do work');
      const context = createMinimalContext({
        language: 'en',
        pieceMovements: [],
        currentMovementIndex: -1,
      });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('This piece consists of');
    });

    it('should render piece structure in Japanese', () => {
      const step = createMinimalStep('Do work');
      step.name = 'plan';
      const context = createMinimalContext({
        language: 'ja',
        pieceMovements: [
          { name: 'plan' },
          { name: 'implement' },
        ],
        currentMovementIndex: 0,
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('このピースは2ムーブメントで構成されています:');
      expect(result).toContain('← 現在');
    });

    it('should not show current marker when currentMovementIndex is -1', () => {
      const step = createMinimalStep('Do work');
      step.name = 'sub-step';
      const context = createMinimalContext({
        language: 'en',
        pieceMovements: [
          { name: 'plan' },
          { name: 'implement' },
        ],
        currentMovementIndex: -1,
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('This piece consists of 2 movements:');
      expect(result).not.toContain('← current');
    });
  });

  describe('buildInstruction report-free (phase separation)', () => {
    it('should include Report Directory info but NOT report output instruction in Phase 1', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [{ name: '00-plan.md' }];
      const context = createMinimalContext({
        reportDir: '/project/.takt/runs/20260129-test/reports',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      // Phase 1 includes Report Directory info and phase note
      expect(result).toContain('Report Directory');
      expect(result).toContain('Report File');
      expect(result).toContain('Phase 1');
      expect(result).toContain('Phase 2 will automatically generate the report');

      // But NOT the report output instruction (that's for Phase 2)
      expect(result).not.toContain('**Report output:**');
    });

    it('should NOT include output contract in buildInstruction', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [{ name: '00-plan.md', format: '**Format:**\n# Plan' }];
      const context = createMinimalContext({
        reportDir: '/project/.takt/runs/20260129-test/reports',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('**Format:**');
    });

    it('should NOT include report order in buildInstruction', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [{
        name: '00-plan.md',
        order: 'Custom order instruction',
      }];
      const context = createMinimalContext({
        reportDir: '/project/.takt/runs/20260129-test/reports',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Custom order instruction');
    });

    it('should still replace {report:filename} in instruction_template', () => {
      const step = createMinimalStep('Write to {report:00-plan.md}');
      const context = createMinimalContext({
        reportDir: '/project/.takt/runs/20260129-test/reports',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('Write to /project/.takt/runs/20260129-test/reports/00-plan.md');
      expect(result).not.toContain('{report:00-plan.md}');
    });
  });

  describe('buildReportInstruction (phase 2)', () => {
    function createReportContext(overrides: Partial<ReportInstructionContext> = {}): ReportInstructionContext {
      return {
        cwd: '/project',
        reportDir: '/project/.takt/runs/20260129-test/reports',
        movementIteration: 1,
        language: 'en',
        ...overrides,
      };
    }

    it('should include execution context with working directory', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [{ name: '00-plan.md' }];
      const ctx = createReportContext({ cwd: '/my/project' });

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('Working Directory: /my/project');
    });

    it('should include no-source-edit rule in execution rules', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [{ name: '00-plan.md' }];
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('Do NOT modify project source files');
    });

    it('should include no-commit and no-cd rules', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [{ name: '00-plan.md' }];
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('Do NOT run git commit');
      expect(result).toContain('Do NOT use `cd`');
    });

    it('should include report directory and file for string report', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [{ name: '00-plan.md' }];
      const ctx = createReportContext({ reportDir: '/project/.takt/runs/20260130-test/reports' });

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('- Report Directory: /project/.takt/runs/20260130-test/reports/');
      expect(result).toContain('- Report File: /project/.takt/runs/20260130-test/reports/00-plan.md');
    });

    it('should include report files for OutputContractEntry[] report', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [
        { label: 'Scope', path: '01-scope.md' },
        { label: 'Decisions', path: '02-decisions.md' },
      ];
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('- Report Directory: /project/.takt/runs/20260129-test/reports/');
      expect(result).toContain('- Report Files:');
      expect(result).toContain('  - Scope: /project/.takt/runs/20260129-test/reports/01-scope.md');
      expect(result).toContain('  - Decisions: /project/.takt/runs/20260129-test/reports/02-decisions.md');
    });

    it('should include report file for OutputContractItem report', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [{ name: '00-plan.md' }];
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('- Report File: /project/.takt/runs/20260129-test/reports/00-plan.md');
    });

    it('should include auto-generated report output instruction', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [{ name: '00-plan.md' }];
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('**Report output:** Output to the `Report File` specified above.');
      expect(result).toContain('- If file does not exist: Create new file');
      expect(result).toContain('Append with `## Iteration 1` section');
    });

    it('should include explicit order instead of auto-generated', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [{
        name: '00-plan.md',
        order: 'Output to {report:00-plan.md} file.',
      }];
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('Output to /project/.takt/runs/20260129-test/reports/00-plan.md file.');
      expect(result).not.toContain('**Report output:**');
    });

    it('should include format from OutputContractItem', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [{
        name: '00-plan.md',
        format: '**Format:**\n```markdown\n# Plan\n```',
      }];
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('**Format:**');
      expect(result).toContain('# Plan');
    });

    it('should replace {movement_iteration} in report output instruction', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [{ name: '00-plan.md' }];
      const ctx = createReportContext({ movementIteration: 5 });

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('Append with `## Iteration 5` section');
    });

    it('should include instruction body text', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [{ name: '00-plan.md' }];
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('## Instructions');
      expect(result).toContain('Respond with the results of the work you just completed as a report');
    });

    it('should NOT include user request, previous response, or status rules', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [{ name: '00-plan.md' }];
      step.rules = [
        { condition: 'Done', next: 'COMPLETE' },
      ];
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).not.toContain('User Request');
      expect(result).not.toContain('Previous Response');
      expect(result).not.toContain('Additional User Inputs');
      expect(result).not.toContain('Status Output Rules');
    });

    it('should render Japanese report instruction', () => {
      const step = createMinimalStep('作業する');
      step.outputContracts = [{ name: '00-plan.md' }];
      const ctx = createReportContext({ language: 'ja' });

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('あなたが今行った作業の結果をレポートとして回答してください');
      expect(result).toContain('プロジェクトのソースファイルを変更しないでください');
      expect(result).toContain('**レポート出力:** `Report File` に出力してください。');
    });

    it('should throw error when step has no output contracts', () => {
      const step = createMinimalStep('Do work');
      const ctx = createReportContext();

      expect(() => buildReportInstruction(step, ctx)).toThrow('no output contracts');
    });

    it('should include multi-file report output instruction for OutputContractEntry[]', () => {
      const step = createMinimalStep('Do work');
      step.outputContracts = [
        { label: 'Scope', path: '01-scope.md' },
        { label: 'Decisions', path: '02-decisions.md' },
      ];
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('**Report output:** Output to the `Report Files` specified above.');
    });
  });

  describe('auto-injected User Request and Additional User Inputs sections', () => {
    it('should include User Request section with task', () => {
      const step = createMinimalStep('Do work');
      const context = createMinimalContext({ task: 'Build the feature', language: 'en' });

      const result = buildInstruction(step, context);

      expect(result).toContain('## User Request\n');
    });

    it('should include Additional User Inputs section', () => {
      const step = createMinimalStep('Do work');
      const context = createMinimalContext({
        userInputs: ['input1', 'input2'],
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('## Additional User Inputs\n');
    });

    it('should include Previous Response when passPreviousResponse is true and output exists', () => {
      const step = createMinimalStep('Do work');
      step.passPreviousResponse = true;
      const context = createMinimalContext({
        previousOutput: { content: 'Previous result', tag: '[TEST:1]' },
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('## Previous Response\n');
    });

    it('should NOT include Previous Response when passPreviousResponse is false', () => {
      const step = createMinimalStep('Do work');
      step.passPreviousResponse = false;
      const context = createMinimalContext({
        previousOutput: { content: 'Previous result', tag: '[TEST:1]' },
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('## Previous Response');
    });

    it('should include Instructions header before template content', () => {
      const step = createMinimalStep('My specific instructions here');
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      const instructionsIdx = result.indexOf('## Instructions');
      const contentIdx = result.indexOf('My specific instructions here');
      expect(instructionsIdx).toBeGreaterThan(-1);
      expect(contentIdx).toBeGreaterThan(instructionsIdx);
    });

    it('should skip auto-injected User Request when template contains {task}', () => {
      const step = createMinimalStep('Process this: {task}');
      const context = createMinimalContext({ task: 'My task', language: 'en' });

      const result = buildInstruction(step, context);

      // Auto-injected section should NOT appear
      expect(result).not.toContain('## User Request');
      // But template placeholder should be replaced
      expect(result).toContain('Process this: My task');
    });

    it('should skip auto-injected Previous Response when template contains {previous_response}', () => {
      const step = createMinimalStep('## Feedback\n{previous_response}\n\nFix the issues.');
      step.passPreviousResponse = true;
      const context = createMinimalContext({
        previousOutput: { content: 'Review feedback here', tag: '[TEST:1]' },
        language: 'en',
      });

      const result = buildInstruction(step, context);

      // Auto-injected section should NOT appear
      expect(result).not.toContain('## Previous Response\n');
      // But template placeholder should be replaced with content
      expect(result).toContain('## Feedback\nReview feedback here');
    });

    it('should apply truncation and source path when {previous_response} placeholder is used', () => {
      const step = createMinimalStep('## Feedback\n{previous_response}\n\nFix the issues.');
      step.passPreviousResponse = true;
      const context = createMinimalContext({
        previousOutput: { content: 'x'.repeat(2100), tag: '[TEST:1]' },
        previousResponseSourcePath: '.takt/runs/test/context/previous_responses/latest.md',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('## Previous Response\n');
      expect(result).toContain('## Feedback');
      expect(result).toContain('...TRUNCATED...');
      expect(result).toContain('Source: .takt/runs/test/context/previous_responses/latest.md');
      expect(result).toContain('If prompt content conflicts with source files, source files take precedence.');
    });

    it('should skip auto-injected Additional User Inputs when template contains {user_inputs}', () => {
      const step = createMinimalStep('Inputs: {user_inputs}');
      const context = createMinimalContext({
        userInputs: ['extra info'],
        language: 'en',
      });

      const result = buildInstruction(step, context);

      // Auto-injected section should NOT appear
      expect(result).not.toContain('## Additional User Inputs');
      // But template placeholder should be replaced
      expect(result).toContain('Inputs: extra info');
    });
  });

  describe('basic placeholder replacement', () => {
    it('should replace {task} placeholder', () => {
      const step = createMinimalStep('Execute: {task}');
      const context = createMinimalContext({ task: 'Build the app' });

      const result = buildInstruction(step, context);

      expect(result).toContain('Build the app');
    });

    it('should replace {iteration} and {max_iterations}', () => {
      const step = createMinimalStep('Step {iteration}/{max_iterations}');
      const context = createMinimalContext({ iteration: 3, maxIterations: 20 });

      const result = buildInstruction(step, context);

      expect(result).toContain('Step 3/20');
    });

    it('should replace {movement_iteration}', () => {
      const step = createMinimalStep('Run #{movement_iteration}');
      const context = createMinimalContext({ movementIteration: 2 });

      const result = buildInstruction(step, context);

      expect(result).toContain('Run #2');
    });
  });

  describe('status rules injection — skip when all rules are ai()/aggregate', () => {
    it('should NOT include status rules when all rules are ai() conditions', () => {
      const step = createMinimalStep('Do work');
      step.rules = [
        { condition: 'ai("No issues")', next: 'COMPLETE', isAiCondition: true, aiConditionText: 'No issues' },
        { condition: 'ai("Issues found")', next: 'fix', isAiCondition: true, aiConditionText: 'Issues found' },
      ];
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Decision Criteria');
      expect(result).not.toContain('[TEST-STEP:');
    });

    it('should NOT include status rules with mixed regular and ai() conditions (Phase 1 no longer has status rules)', () => {
      const step = createMinimalStep('Do work');
      step.name = 'review';
      step.rules = [
        { condition: 'Error occurred', next: 'ABORT' },
        { condition: 'ai("Issues found")', next: 'fix', isAiCondition: true, aiConditionText: 'Issues found' },
      ];
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      // Status rules are no longer injected in Phase 1 (only in Phase 3)
      expect(result).not.toContain('Decision Criteria');
    });

    it('should NOT include status rules with regular conditions only (Phase 1 no longer has status rules)', () => {
      const step = createMinimalStep('Do work');
      step.name = 'plan';
      step.rules = [
        { condition: 'Done', next: 'COMPLETE' },
        { condition: 'Blocked', next: 'ABORT' },
      ];
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      // Status rules are no longer injected in Phase 1 (only in Phase 3)
      expect(result).not.toContain('Decision Criteria');
    });

    it('should NOT include status rules when all rules are aggregate conditions', () => {
      const step = createMinimalStep('Do work');
      step.rules = [
        { condition: 'all("approved")', next: 'COMPLETE', isAggregateCondition: true, aggregateType: 'all' as const, aggregateConditionText: 'approved' },
        { condition: 'any("rejected")', next: 'fix', isAggregateCondition: true, aggregateType: 'any' as const, aggregateConditionText: 'rejected' },
      ];
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Decision Criteria');
    });

    it('should NOT include status rules when all rules are ai() + aggregate', () => {
      const step = createMinimalStep('Do work');
      step.rules = [
        { condition: 'all("approved")', next: 'COMPLETE', isAggregateCondition: true, aggregateType: 'all' as const, aggregateConditionText: 'approved' },
        { condition: 'any("rejected")', next: 'fix', isAggregateCondition: true, aggregateType: 'any' as const, aggregateConditionText: 'rejected' },
        { condition: 'ai("Judgment needed")', next: 'manual', isAiCondition: true, aiConditionText: 'Judgment needed' },
      ];
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Decision Criteria');
    });

    it('should NOT include status rules with mixed aggregate and regular conditions (Phase 1 no longer has status rules)', () => {
      const step = createMinimalStep('Do work');
      step.name = 'supervise';
      step.rules = [
        { condition: 'all("approved")', next: 'COMPLETE', isAggregateCondition: true, aggregateType: 'all' as const, aggregateConditionText: 'approved' },
        { condition: 'Error occurred', next: 'ABORT' },
      ];
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      // Status rules are no longer injected in Phase 1 (only in Phase 3)
      expect(result).not.toContain('Decision Criteria');
    });
  });

  describe('isOutputContractItem', () => {
    it('should return true for OutputContractItem', () => {
      expect(isOutputContractItem({ name: '00-plan.md' })).toBe(true);
    });

    it('should return true for OutputContractItem with order/format', () => {
      expect(isOutputContractItem({ name: '00-plan.md', order: 'output to...', format: '# Plan' })).toBe(true);
    });

    it('should return false for OutputContractLabelPath', () => {
      expect(isOutputContractItem({ label: 'Scope', path: '01-scope.md' })).toBe(false);
    });
  });

  describe('buildStatusJudgmentInstruction (Phase 3)', () => {
    function createJudgmentContext(overrides: Partial<StatusJudgmentContext> = {}): StatusJudgmentContext {
      return {
        language: 'en',
        reportContent: '# Test Report\n\nReport content for testing.',
        ...overrides,
      };
    }

    it('should include header instruction (en)', () => {
      const step = createMinimalStep('Do work');
      step.name = 'plan';
      step.rules = [
        { condition: 'Clear requirements', next: 'implement' },
        { condition: 'Unclear', next: 'ABORT' },
      ];
      const ctx = createJudgmentContext();

      const result = buildStatusJudgmentInstruction(step, ctx);

      expect(result).toContain('Review is already complete');
      expect(result).toContain('Output exactly one tag corresponding to the judgment result');
    });

    it('should include header instruction (ja)', () => {
      const step = createMinimalStep('Do work');
      step.name = 'plan';
      step.rules = [
        { condition: '要件が明確', next: 'implement' },
        { condition: '不明確', next: 'ABORT' },
      ];
      const ctx = createJudgmentContext({ language: 'ja' });

      const result = buildStatusJudgmentInstruction(step, ctx);

      expect(result).toContain('既にレビューは完了しています');
      expect(result).toContain('レポートで示された判定結果に対応するタグを1つだけ出力してください');
    });

    it('should include criteria table with tags', () => {
      const step = createMinimalStep('Do work');
      step.name = 'plan';
      step.rules = [
        { condition: 'Clear requirements', next: 'implement' },
        { condition: 'Unclear', next: 'ABORT' },
      ];
      const ctx = createJudgmentContext();

      const result = buildStatusJudgmentInstruction(step, ctx);

      expect(result).toContain('## Decision Criteria');
      expect(result).toContain('`[PLAN:1]`');
      expect(result).toContain('`[PLAN:2]`');
    });

    it('should include output format section', () => {
      const step = createMinimalStep('Do work');
      step.name = 'review';
      step.rules = [
        { condition: 'Approved', next: 'COMPLETE' },
        { condition: 'Rejected', next: 'fix' },
      ];
      const ctx = createJudgmentContext();

      const result = buildStatusJudgmentInstruction(step, ctx);

      expect(result).toContain('## Output Format');
      expect(result).toContain('`[REVIEW:1]` — Approved');
      expect(result).toContain('`[REVIEW:2]` — Rejected');
    });

    it('should throw error when step has no rules', () => {
      const step = createMinimalStep('Do work');
      const ctx = createJudgmentContext();

      expect(() => buildStatusJudgmentInstruction(step, ctx)).toThrow('no rules');
    });

    it('should throw error when step has empty rules', () => {
      const step = createMinimalStep('Do work');
      step.rules = [];
      const ctx = createJudgmentContext();

      expect(() => buildStatusJudgmentInstruction(step, ctx)).toThrow('no rules');
    });

    it('should default language to en', () => {
      const step = createMinimalStep('Do work');
      step.name = 'test';
      step.rules = [{ condition: 'Done', next: 'COMPLETE' }];
      const ctx: StatusJudgmentContext = { reportContent: 'Test report content' };

      const result = buildStatusJudgmentInstruction(step, ctx);

      expect(result).toContain('Review is already complete');
      expect(result).toContain('## Decision Criteria');
    });

    it('should include appendix template when rules have appendix', () => {
      const step = createMinimalStep('Do work');
      step.name = 'plan';
      step.rules = [
        { condition: 'Done', next: 'COMPLETE' },
        { condition: 'Blocked', next: 'ABORT', appendix: '確認事項:\n- {質問1}' },
      ];
      const ctx = createJudgmentContext();

      const result = buildStatusJudgmentInstruction(step, ctx);

      expect(result).toContain('Appendix Template');
      expect(result).toContain('確認事項:');
    });
  });
});
