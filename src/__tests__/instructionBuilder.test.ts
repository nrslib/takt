/**
 * Tests for instruction-builder module
 */

import { describe, it, expect } from 'vitest';
import {
  buildInstruction,
  buildReportInstruction,
  buildStatusJudgmentInstruction,
  buildExecutionMetadata,
  renderExecutionMetadata,
  generateStatusRulesFromRules,
  isReportObjectConfig,
  type InstructionContext,
  type ReportInstructionContext,
  type StatusJudgmentContext,
} from '../workflow/instruction-builder.js';
import type { WorkflowStep, WorkflowRule } from '../models/types.js';


function createMinimalStep(template: string): WorkflowStep {
  return {
    name: 'test-step',
    agent: 'test-agent',
    agentDisplayName: 'Test Agent',
    instructionTemplate: template,
    passPreviousResponse: false,
  };
}

function createMinimalContext(overrides: Partial<InstructionContext> = {}): InstructionContext {
  return {
    task: 'Test task',
    iteration: 1,
    maxIterations: 10,
    stepIteration: 1,
    cwd: '/project',
    userInputs: [],
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
    it('should replace {report_dir} in paths keeping them relative', () => {
      const step = createMinimalStep(
        '- Report Directory: .takt/reports/{report_dir}/'
      );
      const context = createMinimalContext({
        cwd: '/project',
        reportDir: '20260128-test-report',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain(
        '- Report Directory: .takt/reports/20260128-test-report/'
      );
    });

    it('should not leak projectCwd absolute path into instruction', () => {
      const step = createMinimalStep(
        '- Report: .takt/reports/{report_dir}/00-plan.md'
      );
      const context = createMinimalContext({
        cwd: '/clone/my-task',
        projectCwd: '/project',
        reportDir: '20260128-worktree-report',
      });

      const result = buildInstruction(step, context);

      // Path should be relative, not absolute with projectCwd
      expect(result).toContain(
        '- Report: .takt/reports/20260128-worktree-report/00-plan.md'
      );
      expect(result).not.toContain('/project/.takt/reports/');
      expect(result).toContain('Working Directory: /clone/my-task');
    });

    it('should replace multiple {report_dir} occurrences', () => {
      const step = createMinimalStep(
        '- Scope: .takt/reports/{report_dir}/01-scope.md\n- Decisions: .takt/reports/{report_dir}/02-decisions.md'
      );
      const context = createMinimalContext({
        projectCwd: '/project',
        cwd: '/worktree',
        reportDir: '20260128-multi',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('.takt/reports/20260128-multi/01-scope.md');
      expect(result).toContain('.takt/reports/20260128-multi/02-decisions.md');
      expect(result).not.toContain('/project/.takt/reports/');
    });

    it('should replace standalone {report_dir} with directory name only', () => {
      const step = createMinimalStep(
        'Report dir name: {report_dir}'
      );
      const context = createMinimalContext({
        reportDir: '20260128-standalone',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('Report dir name: 20260128-standalone');
    });
  });

  describe('buildExecutionMetadata', () => {
    it('should set workingDirectory', () => {
      const context = createMinimalContext({ cwd: '/project' });
      const metadata = buildExecutionMetadata(context);

      expect(metadata.workingDirectory).toBe('/project');
    });

    it('should use cwd as workingDirectory even in worktree mode', () => {
      const context = createMinimalContext({
        cwd: '/worktree-path',
        projectCwd: '/project-path',
      });
      const metadata = buildExecutionMetadata(context);

      expect(metadata.workingDirectory).toBe('/worktree-path');
    });

    it('should default language to en when not specified', () => {
      const context = createMinimalContext({ cwd: '/project' });
      const metadata = buildExecutionMetadata(context);

      expect(metadata.language).toBe('en');
    });

    it('should propagate language from context', () => {
      const context = createMinimalContext({ cwd: '/project', language: 'ja' });
      const metadata = buildExecutionMetadata(context);

      expect(metadata.language).toBe('ja');
    });

    it('should propagate edit field when provided', () => {
      const context = createMinimalContext({ cwd: '/project' });

      expect(buildExecutionMetadata(context, true).edit).toBe(true);
      expect(buildExecutionMetadata(context, false).edit).toBe(false);
    });

    it('should leave edit undefined when not provided', () => {
      const context = createMinimalContext({ cwd: '/project' });
      const metadata = buildExecutionMetadata(context);

      expect(metadata.edit).toBeUndefined();
    });
  });

  describe('renderExecutionMetadata', () => {
    it('should render Working Directory and Execution Rules', () => {
      const rendered = renderExecutionMetadata({ workingDirectory: '/project', language: 'en' });

      expect(rendered).toContain('## Execution Context');
      expect(rendered).toContain('- Working Directory: /project');
      expect(rendered).toContain('## Execution Rules');
      expect(rendered).toContain('Do NOT run git commit');
      expect(rendered).toContain('Do NOT use `cd`');
    });

    it('should end with a trailing empty line', () => {
      const rendered = renderExecutionMetadata({ workingDirectory: '/project', language: 'en' });

      expect(rendered).toMatch(/\n$/);
    });

    it('should render in Japanese when language is ja', () => {
      const rendered = renderExecutionMetadata({ workingDirectory: '/project', language: 'ja' });

      expect(rendered).toContain('## 実行コンテキスト');
      expect(rendered).toContain('- 作業ディレクトリ: /project');
      expect(rendered).toContain('## 実行ルール');
      expect(rendered).toContain('git commit を実行しないでください');
      expect(rendered).toContain('cd` を使用しないでください');
    });

    it('should include English note only for en, not for ja', () => {
      const enRendered = renderExecutionMetadata({ workingDirectory: '/project', language: 'en' });
      const jaRendered = renderExecutionMetadata({ workingDirectory: '/project', language: 'ja' });

      expect(enRendered).toContain('Note:');
      expect(jaRendered).not.toContain('Note:');
    });

    it('should include edit enabled prompt when edit is true (en)', () => {
      const rendered = renderExecutionMetadata({ workingDirectory: '/project', language: 'en', edit: true });

      expect(rendered).toContain('Editing is ENABLED');
      expect(rendered).not.toContain('Editing is DISABLED');
    });

    it('should include edit disabled prompt when edit is false (en)', () => {
      const rendered = renderExecutionMetadata({ workingDirectory: '/project', language: 'en', edit: false });

      expect(rendered).toContain('Editing is DISABLED');
      expect(rendered).not.toContain('Editing is ENABLED');
    });

    it('should not include edit prompt when edit is undefined', () => {
      const rendered = renderExecutionMetadata({ workingDirectory: '/project', language: 'en' });

      expect(rendered).not.toContain('Editing is ENABLED');
      expect(rendered).not.toContain('Editing is DISABLED');
      expect(rendered).not.toContain('編集が許可');
      expect(rendered).not.toContain('編集が禁止');
    });

    it('should render edit enabled prompt in Japanese when language is ja', () => {
      const rendered = renderExecutionMetadata({ workingDirectory: '/project', language: 'ja', edit: true });

      expect(rendered).toContain('編集が許可されています');
      expect(rendered).not.toContain('編集が禁止');
    });

    it('should render edit disabled prompt in Japanese when language is ja', () => {
      const rendered = renderExecutionMetadata({ workingDirectory: '/project', language: 'ja', edit: false });

      expect(rendered).toContain('編集が禁止されています');
      expect(rendered).not.toContain('編集が許可');
    });
  });

  describe('generateStatusRulesFromRules', () => {
    const rules: WorkflowRule[] = [
      { condition: '要件が明確で実装可能', next: 'implement' },
      { condition: 'ユーザーが質問をしている', next: 'COMPLETE' },
      { condition: '要件が不明確、情報不足', next: 'ABORT', appendix: '確認事項:\n- {質問1}\n- {質問2}' },
    ];

    it('should generate criteria table with numbered tags (ja)', () => {
      const result = generateStatusRulesFromRules('plan', rules, 'ja');

      expect(result).toContain('## 判定基準');
      expect(result).toContain('| 1 | 要件が明確で実装可能 | `[PLAN:1]` |');
      expect(result).toContain('| 2 | ユーザーが質問をしている | `[PLAN:2]` |');
      expect(result).toContain('| 3 | 要件が不明確、情報不足 | `[PLAN:3]` |');
    });

    it('should generate criteria table with numbered tags (en)', () => {
      const enRules: WorkflowRule[] = [
        { condition: 'Requirements are clear', next: 'implement' },
        { condition: 'User is asking a question', next: 'COMPLETE' },
      ];
      const result = generateStatusRulesFromRules('plan', enRules, 'en');

      expect(result).toContain('## Decision Criteria');
      expect(result).toContain('| 1 | Requirements are clear | `[PLAN:1]` |');
      expect(result).toContain('| 2 | User is asking a question | `[PLAN:2]` |');
    });

    it('should generate output format section with condition labels', () => {
      const result = generateStatusRulesFromRules('plan', rules, 'ja');

      expect(result).toContain('## 出力フォーマット');
      expect(result).toContain('`[PLAN:1]` — 要件が明確で実装可能');
      expect(result).toContain('`[PLAN:2]` — ユーザーが質問をしている');
      expect(result).toContain('`[PLAN:3]` — 要件が不明確、情報不足');
    });

    it('should generate appendix template section when rules have appendix', () => {
      const result = generateStatusRulesFromRules('plan', rules, 'ja');

      expect(result).toContain('### 追加出力テンプレート');
      expect(result).toContain('`[PLAN:3]`');
      expect(result).toContain('確認事項:');
      expect(result).toContain('- {質問1}');
    });

    it('should not generate appendix section when no rules have appendix', () => {
      const noAppendixRules: WorkflowRule[] = [
        { condition: 'Done', next: 'review' },
        { condition: 'Blocked', next: 'plan' },
      ];
      const result = generateStatusRulesFromRules('implement', noAppendixRules, 'en');

      expect(result).not.toContain('Appendix Template');
    });

    it('should uppercase step name in tags', () => {
      const result = generateStatusRulesFromRules('ai_review', [
        { condition: 'No issues', next: 'supervise' },
      ], 'en');

      expect(result).toContain('`[AI_REVIEW:1]`');
    });
  });

  describe('buildInstruction with rules (Phase 1 — no status tags)', () => {
    it('should NOT include status rules even when rules exist (phase separation)', () => {
      const step = createMinimalStep('Do work');
      step.name = 'plan';
      step.rules = [
        { condition: 'Clear requirements', next: 'implement' },
        { condition: 'Unclear', next: 'ABORT' },
      ];
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      // Phase 1 should NOT contain status header or criteria
      expect(result).not.toContain('Status Output Rules');
      expect(result).not.toContain('Decision Criteria');
      expect(result).not.toContain('[PLAN:');
    });

    it('should not add status rules when rules do not exist', () => {
      const step = createMinimalStep('Do work');
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Status Output Rules');
      expect(result).not.toContain('Decision Criteria');
    });

    it('should not auto-generate when rules array is empty', () => {
      const step = createMinimalStep('Do work');
      step.rules = [];
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Status Output Rules');
      expect(result).not.toContain('Decision Criteria');
    });
  });

  describe('auto-injected Workflow Context section', () => {
    it('should include iteration, step iteration, and step name', () => {
      const step = createMinimalStep('Do work');
      step.name = 'implement';
      const context = createMinimalContext({
        iteration: 3,
        maxIterations: 20,
        stepIteration: 2,
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('## Workflow Context');
      expect(result).toContain('- Iteration: 3/20');
      expect(result).toContain('- Step Iteration: 2');
      expect(result).toContain('- Step: implement');
    });

    it('should NOT include report info even when step has report (phase separation)', () => {
      const step = createMinimalStep('Do work');
      step.name = 'plan';
      step.report = '00-plan.md';
      const context = createMinimalContext({
        reportDir: '20260129-test',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('## Workflow Context');
      expect(result).not.toContain('Report Directory');
      expect(result).not.toContain('Report File');
    });

    it('should NOT include report info for ReportConfig[] (phase separation)', () => {
      const step = createMinimalStep('Do work');
      step.report = [
        { label: 'Scope', path: '01-scope.md' },
        { label: 'Decisions', path: '02-decisions.md' },
      ];
      const context = createMinimalContext({
        reportDir: '20260129-test',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Report Directory');
      expect(result).not.toContain('Report Files');
    });

    it('should NOT include report info for ReportObjectConfig (phase separation)', () => {
      const step = createMinimalStep('Do work');
      step.report = { name: '00-plan.md' };
      const context = createMinimalContext({
        reportDir: '20260129-test',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Report Directory');
      expect(result).not.toContain('Report File');
    });

    it('should render Japanese step iteration suffix', () => {
      const step = createMinimalStep('Do work');
      const context = createMinimalContext({
        stepIteration: 3,
        language: 'ja',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('- Step Iteration: 3（このステップの実行回数）');
    });
  });

  describe('buildInstruction report-free (phase separation)', () => {
    it('should NOT include report output instruction in buildInstruction', () => {
      const step = createMinimalStep('Do work');
      step.report = '00-plan.md';
      const context = createMinimalContext({
        reportDir: '20260129-test',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('**Report output:**');
      expect(result).not.toContain('Report File');
      expect(result).not.toContain('Report Directory');
    });

    it('should NOT include report format in buildInstruction', () => {
      const step = createMinimalStep('Do work');
      step.report = { name: '00-plan.md', format: '**Format:**\n# Plan' };
      const context = createMinimalContext({
        reportDir: '20260129-test',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('**Format:**');
    });

    it('should NOT include report order in buildInstruction', () => {
      const step = createMinimalStep('Do work');
      step.report = {
        name: '00-plan.md',
        order: 'Custom order instruction',
      };
      const context = createMinimalContext({
        reportDir: '20260129-test',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Custom order instruction');
    });

    it('should still replace {report:filename} in instruction_template', () => {
      const step = createMinimalStep('Write to {report:00-plan.md}');
      const context = createMinimalContext({
        reportDir: '20260129-test',
        language: 'en',
      });

      const result = buildInstruction(step, context);

      expect(result).toContain('Write to 20260129-test/00-plan.md');
      expect(result).not.toContain('{report:00-plan.md}');
    });
  });

  describe('buildReportInstruction (phase 2)', () => {
    function createReportContext(overrides: Partial<ReportInstructionContext> = {}): ReportInstructionContext {
      return {
        cwd: '/project',
        reportDir: '20260129-test',
        stepIteration: 1,
        language: 'en',
        ...overrides,
      };
    }

    it('should include execution context with working directory', () => {
      const step = createMinimalStep('Do work');
      step.report = '00-plan.md';
      const ctx = createReportContext({ cwd: '/my/project' });

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('Working Directory: /my/project');
    });

    it('should include no-source-edit rule in execution rules', () => {
      const step = createMinimalStep('Do work');
      step.report = '00-plan.md';
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('Do NOT modify project source files');
    });

    it('should include no-commit and no-cd rules', () => {
      const step = createMinimalStep('Do work');
      step.report = '00-plan.md';
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('Do NOT run git commit');
      expect(result).toContain('Do NOT use `cd`');
    });

    it('should include report directory and file for string report', () => {
      const step = createMinimalStep('Do work');
      step.report = '00-plan.md';
      const ctx = createReportContext({ reportDir: '20260130-test' });

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('- Report Directory: 20260130-test/');
      expect(result).toContain('- Report File: 20260130-test/00-plan.md');
    });

    it('should include report files for ReportConfig[] report', () => {
      const step = createMinimalStep('Do work');
      step.report = [
        { label: 'Scope', path: '01-scope.md' },
        { label: 'Decisions', path: '02-decisions.md' },
      ];
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('- Report Directory: 20260129-test/');
      expect(result).toContain('- Report Files:');
      expect(result).toContain('  - Scope: 20260129-test/01-scope.md');
      expect(result).toContain('  - Decisions: 20260129-test/02-decisions.md');
    });

    it('should include report file for ReportObjectConfig report', () => {
      const step = createMinimalStep('Do work');
      step.report = { name: '00-plan.md' };
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('- Report File: 20260129-test/00-plan.md');
    });

    it('should include auto-generated report output instruction', () => {
      const step = createMinimalStep('Do work');
      step.report = '00-plan.md';
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('**Report output:** Output to the `Report File` specified above.');
      expect(result).toContain('- If file does not exist: Create new file');
      expect(result).toContain('Append with `## Iteration 1` section');
    });

    it('should include explicit order instead of auto-generated', () => {
      const step = createMinimalStep('Do work');
      step.report = {
        name: '00-plan.md',
        order: 'Output to {report:00-plan.md} file.',
      };
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('Output to 20260129-test/00-plan.md file.');
      expect(result).not.toContain('**Report output:**');
    });

    it('should include format from ReportObjectConfig', () => {
      const step = createMinimalStep('Do work');
      step.report = {
        name: '00-plan.md',
        format: '**Format:**\n```markdown\n# Plan\n```',
      };
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('**Format:**');
      expect(result).toContain('# Plan');
    });

    it('should replace {step_iteration} in report output instruction', () => {
      const step = createMinimalStep('Do work');
      step.report = '00-plan.md';
      const ctx = createReportContext({ stepIteration: 5 });

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('Append with `## Iteration 5` section');
    });

    it('should include instruction body text', () => {
      const step = createMinimalStep('Do work');
      step.report = '00-plan.md';
      const ctx = createReportContext();

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('## Instructions');
      expect(result).toContain('Output the results of your previous work as a report');
    });

    it('should NOT include user request, previous response, or status rules', () => {
      const step = createMinimalStep('Do work');
      step.report = '00-plan.md';
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
      step.report = { name: '00-plan.md' };
      const ctx = createReportContext({ language: 'ja' });

      const result = buildReportInstruction(step, ctx);

      expect(result).toContain('前のステップの作業結果をレポートとして出力してください');
      expect(result).toContain('プロジェクトのソースファイルを変更しないでください');
      expect(result).toContain('**レポート出力:** `Report File` に出力してください。');
    });

    it('should throw error when step has no report config', () => {
      const step = createMinimalStep('Do work');
      const ctx = createReportContext();

      expect(() => buildReportInstruction(step, ctx)).toThrow('no report config');
    });

    it('should include multi-file report output instruction for ReportConfig[]', () => {
      const step = createMinimalStep('Do work');
      step.report = [{ label: 'Scope', path: '01-scope.md' }];
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

    it('should replace {step_iteration}', () => {
      const step = createMinimalStep('Run #{step_iteration}');
      const context = createMinimalContext({ stepIteration: 2 });

      const result = buildInstruction(step, context);

      expect(result).toContain('Run #2');
    });
  });

  describe('phase separation — buildInstruction never includes status rules', () => {
    it('should NOT include status rules even with ai() conditions', () => {
      const step = createMinimalStep('Do work');
      step.rules = [
        { condition: 'ai("No issues")', next: 'COMPLETE', isAiCondition: true, aiConditionText: 'No issues' },
        { condition: 'ai("Issues found")', next: 'fix', isAiCondition: true, aiConditionText: 'Issues found' },
      ];
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Status Output Rules');
      expect(result).not.toContain('[TEST-STEP:');
    });

    it('should NOT include status rules with mixed regular and ai() conditions', () => {
      const step = createMinimalStep('Do work');
      step.rules = [
        { condition: 'Error occurred', next: 'ABORT' },
        { condition: 'ai("Issues found")', next: 'fix', isAiCondition: true, aiConditionText: 'Issues found' },
      ];
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Status Output Rules');
    });

    it('should NOT include status rules with regular conditions only', () => {
      const step = createMinimalStep('Do work');
      step.rules = [
        { condition: 'Done', next: 'COMPLETE' },
        { condition: 'Blocked', next: 'ABORT' },
      ];
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Status Output Rules');
    });

    it('should NOT include status rules with aggregate conditions', () => {
      const step = createMinimalStep('Do work');
      step.rules = [
        { condition: 'all("approved")', next: 'COMPLETE', isAggregateCondition: true, aggregateType: 'all' as const, aggregateConditionText: 'approved' },
        { condition: 'any("rejected")', next: 'fix', isAggregateCondition: true, aggregateType: 'any' as const, aggregateConditionText: 'rejected' },
      ];
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Status Output Rules');
    });

    it('should NOT include status rules with mixed ai() and aggregate conditions', () => {
      const step = createMinimalStep('Do work');
      step.rules = [
        { condition: 'all("approved")', next: 'COMPLETE', isAggregateCondition: true, aggregateType: 'all' as const, aggregateConditionText: 'approved' },
        { condition: 'any("rejected")', next: 'fix', isAggregateCondition: true, aggregateType: 'any' as const, aggregateConditionText: 'rejected' },
        { condition: 'ai("Judgment needed")', next: 'manual', isAiCondition: true, aiConditionText: 'Judgment needed' },
      ];
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Status Output Rules');
    });

    it('should NOT include status rules with mixed aggregate and regular conditions', () => {
      const step = createMinimalStep('Do work');
      step.rules = [
        { condition: 'all("approved")', next: 'COMPLETE', isAggregateCondition: true, aggregateType: 'all' as const, aggregateConditionText: 'approved' },
        { condition: 'Error occurred', next: 'ABORT' },
      ];
      const context = createMinimalContext({ language: 'en' });

      const result = buildInstruction(step, context);

      expect(result).not.toContain('Status Output Rules');
    });
  });

  describe('isReportObjectConfig', () => {
    it('should return true for ReportObjectConfig', () => {
      expect(isReportObjectConfig({ name: '00-plan.md' })).toBe(true);
    });

    it('should return true for ReportObjectConfig with order/format', () => {
      expect(isReportObjectConfig({ name: '00-plan.md', order: 'output to...', format: '# Plan' })).toBe(true);
    });

    it('should return false for string', () => {
      expect(isReportObjectConfig('00-plan.md')).toBe(false);
    });

    it('should return false for ReportConfig[] (array)', () => {
      expect(isReportObjectConfig([{ label: 'Scope', path: '01-scope.md' }])).toBe(false);
    });
  });

  describe('buildStatusJudgmentInstruction (Phase 3)', () => {
    function createJudgmentContext(overrides: Partial<StatusJudgmentContext> = {}): StatusJudgmentContext {
      return {
        language: 'en',
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

      expect(result).toContain('Review your work results and determine the status');
      expect(result).toContain('Do NOT perform any additional work');
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

      expect(result).toContain('作業結果を振り返り、ステータスを判定してください');
      expect(result).toContain('追加の作業は行わないでください');
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
      const ctx: StatusJudgmentContext = {};

      const result = buildStatusJudgmentInstruction(step, ctx);

      expect(result).toContain('Review your work results');
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
