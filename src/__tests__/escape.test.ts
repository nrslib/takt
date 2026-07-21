/**
 * Unit tests for template escaping and placeholder replacement
 *
 * Tests escapeTemplateChars and replaceTemplatePlaceholders functions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  escapeTemplateChars,
  replaceTemplatePlaceholders,
} from '../core/workflow/instruction/escape.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import type { InstructionContext } from '../core/workflow/instruction/instruction-context.js';
import { makeStep, makeInstructionContext } from './test-helpers.js';

describe('escapeTemplateChars', () => {
  it('should replace curly braces with full-width equivalents', () => {
    expect(escapeTemplateChars('{hello}')).toBe('｛hello｝');
  });

  it('should handle multiple braces', () => {
    expect(escapeTemplateChars('{{nested}}')).toBe('｛｛nested｝｝');
  });

  it('should return unchanged string when no braces', () => {
    expect(escapeTemplateChars('no braces here')).toBe('no braces here');
  });

  it('should handle empty string', () => {
    expect(escapeTemplateChars('')).toBe('');
  });

  it('should handle braces in code snippets', () => {
    const input = 'function foo() { return { a: 1 }; }';
    const expected = 'function foo() ｛ return ｛ a: 1 ｝; ｝';
    expect(escapeTemplateChars(input)).toBe(expected);
  });
});

describe('replaceTemplatePlaceholders', () => {
  it('should replace {task} placeholder', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({ task: 'implement feature X' });
    const template = 'Your task is: {task}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Your task is: implement feature X');
  });

  it('should escape braces in task content', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({ task: 'fix {bug} in code' });
    const template = '{task}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('fix ｛bug｝ in code');
  });

  it('should replace {iteration} and {max_steps}', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({ iteration: 3, maxSteps: 20 });
    const template = 'Iteration {iteration}/{max_steps}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Iteration 3/20');
  });

  it('should replace {step_iteration}', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({ stepIteration: 5 });
    const template = 'Step run #{step_iteration}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Step run #5');
  });

  it('should replace {previous_response} when passPreviousResponse is true', () => {
    const step = makeStep({ passPreviousResponse: true });
    const ctx = makeInstructionContext({
      previousOutput: {
        persona: 'coder',
        status: 'done',
        content: 'previous output text',
        timestamp: new Date(),
      },
    });
    const template = 'Previous: {previous_response}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Previous: previous output text');
  });

  it('should prefer preprocessed previous response text when provided', () => {
    const step = makeStep({ passPreviousResponse: true });
    const ctx = makeInstructionContext({
      previousOutput: {
        persona: 'coder',
        status: 'done',
        content: 'raw previous output',
        timestamp: new Date(),
      },
      previousResponseText: 'processed previous output',
    });
    const template = 'Previous: {previous_response}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Previous: processed previous output');
  });

  it('should replace {previous_response} with empty string when no previous output', () => {
    const step = makeStep({ passPreviousResponse: true });
    const ctx = makeInstructionContext();
    const template = 'Previous: {previous_response}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Previous: ');
  });

  it('should not replace {previous_response} when passPreviousResponse is false', () => {
    const step = makeStep({ passPreviousResponse: false });
    const ctx = makeInstructionContext({
      previousOutput: {
        persona: 'coder',
        status: 'done',
        content: 'should not appear',
        timestamp: new Date(),
      },
    });
    const template = 'Previous: {previous_response}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Previous: {previous_response}');
  });

  it('should replace {user_inputs} with joined inputs', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({ userInputs: ['input 1', 'input 2', 'input 3'] });
    const template = 'Inputs: {user_inputs}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Inputs: input 1\ninput 2\ninput 3');
  });

  it('should replace {report_dir} with report directory', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({ reportDir: '/tmp/reports/run-1' });
    const template = 'Reports: {report_dir}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Reports: /tmp/reports/run-1');
  });

  describe('{report:filename} resolution', () => {
    let reportDir: string;

    beforeEach(() => {
      reportDir = mkdtempSync(join(tmpdir(), 'takt-escape-report-'));
    });

    afterEach(() => {
      rmSync(reportDir, { recursive: true, force: true });
    });

    it('should replace {report:filename} with the verified report content', () => {
      writeFileSync(join(reportDir, 'review.md'), 'review');
      writeFileSync(join(reportDir, 'plan.md'), 'plan');
      const step = makeStep();
      const ctx = makeInstructionContext({ reportDir });
      const template = 'Read {report:review.md} and {report:plan.md}';

      const result = replaceTemplatePlaceholders(template, step, ctx);
      expect(result).toBe('Read review and plan');
    });

    it('should preserve ASCII braces in report content', () => {
      const report = '{"finding":{"line":12,"evidence":"const value = { safe: true };"}}';
      writeFileSync(join(reportDir, 'review.md'), report);
      const step = makeStep();
      const ctx = makeInstructionContext({ reportDir });

      expect(replaceTemplatePlaceholders('{report:review.md}', step, ctx)).toBe(report);
    });

    it('should preserve report code and JSON through InstructionBuilder', () => {
      const report = '```json\n{"finding":{"line":12}}\n```\nconst value = { safe: true };';
      writeFileSync(join(reportDir, 'review.md'), report);
      const step = makeStep({ instruction: 'Use this evidence exactly:\n{report:review.md}' });
      const ctx = makeInstructionContext({ reportDir });

      const instruction = new InstructionBuilder(step, ctx).build();

      expect(instruction).toContain(report);
      expect(instruction).not.toContain('｛"finding"');
    });

    // v3-r4 resume 境界バグの再発防止: {report:X} は存在チェックなしの
    // 単純パス置換だったため、レポートが無いままエージェントが起動して
    // 実在しないパスを探して詰んでいた。欠落はエージェント起動前に
    // 明確なエラーで落とす。
    it('should fail before agent launch when the referenced report is missing', () => {
      const step = makeStep({ name: 'arbitrate' });
      const ctx = makeInstructionContext({ reportDir });
      const template = 'Read {report:missing-review.md}';

      expect(() => replaceTemplatePlaceholders(template, step, ctx)).toThrow(
        /Report reference "missing-review\.md" is unavailable for step "arbitrate"/,
      );
    });

    it('should reject report references escaping the report directory', () => {
      const step = makeStep({ name: 'arbitrate' });
      const ctx = makeInstructionContext({ reportDir });
      const template = 'Read {report:../../secrets.md}';

      expect(() => replaceTemplatePlaceholders(template, step, ctx)).toThrow(
        /escapes the report directory/,
      );
    });

    // workflow_call の子は名前空間付き reportDir（reports/subworkflows/...）を
    // 持つ。親 run の成果物（例: draft の implement が参照する plan.md）は、
    // engine から明示的に渡された reports ルートへ read-only フォールバック
    // して解決される。
    it('should fall back to the run reports root for subworkflow namespace dirs (explicit reportsRootDir)', () => {
      const runRoot = join(reportDir, '.takt', 'runs', 'run-slug');
      const reportsRoot = join(runRoot, 'reports');
      const childReportDir = join(reportsRoot, 'subworkflows', 'draft#3');
      mkdirSync(childReportDir, { recursive: true });
      writeFileSync(join(reportsRoot, 'plan.md'), 'parent plan');

      const step = makeStep({ name: 'implement' });
      const ctx = makeInstructionContext({ reportDir: childReportDir, reportsRootDir: reportsRoot });
      const result = replaceTemplatePlaceholders('Read {report:plan.md}', step, ctx);
      expect(result).toBe('Read parent plan');

      // ルートにも無い場合は明確なエラー。
      expect(() => replaceTemplatePlaceholders('Read {report:ghost.md}', step, ctx)).toThrow(
        /Report reference "ghost\.md" is unavailable for step "implement"/,
      );
    });

    it('should prefer the child report over the parent when both exist', () => {
      const reportsRoot = join(reportDir, '.takt', 'runs', 'run-slug', 'reports');
      const childReportDir = join(reportsRoot, 'subworkflows', 'draft#3');
      mkdirSync(childReportDir, { recursive: true });
      writeFileSync(join(reportsRoot, 'plan.md'), 'parent plan');
      writeFileSync(join(childReportDir, 'plan.md'), 'child plan');

      const step = makeStep({ name: 'implement' });
      const ctx = makeInstructionContext({ reportDir: childReportDir, reportsRootDir: reportsRoot });
      const result = replaceTemplatePlaceholders('Read {report:plan.md}', step, ctx);
      expect(result).toBe('Read child plan');
    });

    it('should not fall back for nested report dirs outside the subworkflows namespace', () => {
      const reportsRoot = join(reportDir, '.takt', 'runs', 'run-slug', 'reports');
      const nestedDir = join(reportsRoot, 'nested', 'not-a-subworkflow');
      mkdirSync(nestedDir, { recursive: true });
      // 親に実在しても、subworkflows 名前空間の外では掴まない。
      writeFileSync(join(reportsRoot, 'plan.md'), 'parent plan');

      const step = makeStep({ name: 'implement' });
      const ctx = makeInstructionContext({ reportDir: nestedDir, reportsRootDir: reportsRoot });
      expect(() => replaceTemplatePlaceholders('Read {report:plan.md}', step, ctx)).toThrow(
        /Report reference "plan\.md" is unavailable for step "implement"/,
      );
    });

    it('should not fall back when reportsRootDir is not provided', () => {
      const reportsRoot = join(reportDir, '.takt', 'runs', 'run-slug', 'reports');
      const childReportDir = join(reportsRoot, 'subworkflows', 'draft#3');
      mkdirSync(childReportDir, { recursive: true });
      writeFileSync(join(reportsRoot, 'plan.md'), 'parent plan');

      const step = makeStep({ name: 'implement' });
      const ctx = makeInstructionContext({ reportDir: childReportDir });
      expect(() => replaceTemplatePlaceholders('Read {report:plan.md}', step, ctx)).toThrow(
        /Report reference "plan\.md" is unavailable for step "implement"/,
      );
    });

    // resume-artifacts.json は内部予約名（resume スナップショット manifest）。
    // 通常レポートとして解決させない — 内部形式への依存を明示エラーで拒否。
    it('should reject references to the reserved resume-artifacts.json (case/whitespace insensitive)', () => {
      writeFileSync(join(reportDir, 'resume-artifacts.json'), '{}');
      const step = makeStep({ name: 'arbitrate' });
      const ctx = makeInstructionContext({ reportDir });
      // Windows 形式の区切り（sub\Resume-Artifacts.JSON）も拒否される。
      for (const reference of ['resume-artifacts.json', ' Resume-Artifacts.JSON ', 'sub\\Resume-Artifacts.JSON']) {
        expect(() => replaceTemplatePlaceholders(`Read {report:${reference}}`, step, ctx)).toThrow(
          /reserved internal file/,
        );
      }
    });

    // statSync はリンク先を追うため、reportDir 外を指す symlink の {report:X} を
    // 受理してしまう（codex 指摘）。lstat でリンク自体を拒否する。
    it('should reject report references that resolve to a symlink', () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'takt-escape-outside-'));
      const outside = join(outsideDir, 'outside.md');
      writeFileSync(outside, 'outside content');
      symlinkSync(outside, join(reportDir, 'link.md'));

      const step = makeStep({ name: 'arbitrate' });
      const ctx = makeInstructionContext({ reportDir });
      expect(() => replaceTemplatePlaceholders('Read {report:link.md}', step, ctx)).toThrow(
        /resolves to a symlink/,
      );
      rmSync(outsideDir, { recursive: true, force: true });
    });
  });

  it('should replace report handle placeholders with resolved paths', () => {
    const step = makeStep();
    const ctx = {
      ...makeInstructionContext(),
      currentReport: '/tmp/reports/07-fix.md',
      previousReport: '/tmp/reports/07-fix.md.20260420T010000Z',
      reportHistory: [
        '/tmp/reports/07-fix.md.20260420T010000Z',
        '/tmp/reports/07-fix.md.20260419T230000Z',
      ].join('\n'),
      peerReports: [
        '/tmp/reports/05-arch-review.md',
        '/tmp/reports/06-security-review.md',
      ].join('\n'),
    } as InstructionContext;
    const template = [
      'Current: {current_report}',
      'Previous: {previous_report}',
      'History: {report_history}',
      'Peers: {peer_reports}',
    ].join('\n');

    const result = replaceTemplatePlaceholders(template, step, ctx);

    expect(result).toContain('Current: /tmp/reports/07-fix.md');
    expect(result).toContain('Previous: /tmp/reports/07-fix.md.20260420T010000Z');
    expect(result).toContain('/tmp/reports/07-fix.md.20260419T230000Z');
    expect(result).toContain('/tmp/reports/05-arch-review.md');
    expect(result).toContain('/tmp/reports/06-security-review.md');
    expect(result).not.toContain('{current_report}');
    expect(result).not.toContain('{previous_report}');
    expect(result).not.toContain('{report_history}');
    expect(result).not.toContain('{peer_reports}');
  });

  it('should replace missing report handle placeholders with empty strings', () => {
    const step = makeStep();
    const ctx = makeInstructionContext() as InstructionContext;
    const template = 'Current:{current_report}|Previous:{previous_report}|History:{report_history}|Peers:{peer_reports}';

    const result = replaceTemplatePlaceholders(template, step, ctx);

    expect(result).toBe('Current:|Previous:|History:|Peers:');
  });

  it('should handle template with multiple different placeholders', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({
      task: 'test task',
      iteration: 2,
      maxSteps: 5,
      stepIteration: 1,
      reportDir: '/reports',
    });
    const template = '{task} - iter {iteration}/{max_steps} - step {step_iteration} - dir {report_dir}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('test task - iter 2/5 - step 1 - dir /reports');
  });

  it('should replace scalar effect placeholders from workflow state', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({
      workflowState: {
        systemContexts: new Map(),
        structuredOutputs: new Map(),
        effectResults: new Map([
          ['comment_on_pr', { comment_pr: { success: true } }],
        ]),
      } as never,
    });

    const result = replaceTemplatePlaceholders('Comment success: {effect:comment_on_pr.comment_pr.success}', step, ctx);
    expect(result).toBe('Comment success: true');
  });

  it('should replace array-based context placeholders from workflow state', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({
      workflowState: {
        systemContexts: new Map([
          ['route_context', { prs: [{ number: 42, author: 'nrslib' }] }],
        ]),
        structuredOutputs: new Map(),
        effectResults: new Map(),
      } as never,
    });

    const result = replaceTemplatePlaceholders('First PR: {context:route_context.prs[0].number}', step, ctx);
    expect(result).toBe('First PR: 42');
  });

  it('should replace array field projection placeholders from workflow state', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({
      workflowState: {
        systemContexts: new Map([
          ['route_context', { prs: [{ number: 42, author: 'nrslib' }] }],
        ]),
        structuredOutputs: new Map(),
        effectResults: new Map(),
      } as never,
    });

    const result = replaceTemplatePlaceholders('First author: {context:route_context.prs.author[0]}', step, ctx);
    expect(result).toBe('First author: nrslib');
  });

  it('should stringify non-scalar context placeholders from workflow state', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({
      workflowState: {
        systemContexts: new Map([
          ['route_context', {
            issues: [
              { number: 586 },
              { number: 587 },
            ],
          }],
        ]),
        structuredOutputs: new Map(),
        effectResults: new Map(),
      } as never,
    });

    const result = replaceTemplatePlaceholders('Issues:\n{context:route_context.issues}', step, ctx);

    expect(result).toContain('Issues:\n[');
    expect(result).toContain('"number": 586');
    expect(result).toContain('"number": 587');
  });

  it('should fail when structured placeholders resolve to non-scalar values', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({
      workflowState: {
        systemContexts: new Map(),
        structuredOutputs: new Map([
          ['plan_followup', { payload: { action: 'enqueue_new_task' } }],
        ]),
        effectResults: new Map(),
      } as never,
    });

    expect(() => replaceTemplatePlaceholders('{structured:plan_followup.payload}', step, ctx)).toThrow(
      'Instruction interpolation requires scalar value for "structured:plan_followup.payload"',
    );
  });

  it('should replace step-qualified effect placeholders from workflow state', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({
      workflowState: {
        systemContexts: new Map(),
        structuredOutputs: new Map(),
        effectResults: new Map([
          ['comment_on_pr', { comment_pr: { success: true } }],
        ]),
      } as never,
    });

    const result = replaceTemplatePlaceholders('Comment success: {effect:comment_on_pr.comment_pr.success}', step, ctx);
    expect(result).toBe('Comment success: true');
  });

  it('should fail when effect placeholders resolve to non-scalar values', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({
      workflowState: {
        systemContexts: new Map(),
        structuredOutputs: new Map(),
        effectResults: new Map([
          ['comment_on_pr', { comment_pr: { metadata: { failed: false } } }],
        ]),
      } as never,
    });

    expect(() => replaceTemplatePlaceholders('{effect:comment_on_pr.comment_pr.metadata}', step, ctx)).toThrow(
      'Instruction interpolation requires scalar value for "effect:comment_on_pr.comment_pr.metadata"',
    );
  });

  it('should reject unqualified effect placeholders', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({
      workflowState: {
        systemContexts: new Map(),
        structuredOutputs: new Map(),
        effectResults: new Map([
          ['comment_on_pr', { comment_pr: { success: true } }],
        ]),
      } as never,
    });

    expect(() => replaceTemplatePlaceholders('{effect:comment_pr.success}', step, ctx)).toThrow(
      'Effect references must use "effect.<step>.<type>.<field>" format: "effect.comment_pr.success"',
    );
  });

  it('should leave unreplaced placeholders when reportDir is undefined', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({ reportDir: undefined });
    const template = 'Dir: {report_dir} File: {report:test.md}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Dir: {report_dir} File: {report:test.md}');
  });
});
