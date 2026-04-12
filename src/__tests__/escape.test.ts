/**
 * Unit tests for template escaping and placeholder replacement
 *
 * Tests escapeTemplateChars and replaceTemplatePlaceholders functions.
 */

import { describe, it, expect } from 'vitest';
import {
  escapeTemplateChars,
  replaceTemplatePlaceholders,
} from '../core/workflow/instruction/escape.js';
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

  it('should replace {report:filename} with full path', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({ reportDir: '/tmp/reports' });
    const template = 'Read {report:review.md} and {report:plan.md}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Read /tmp/reports/review.md and /tmp/reports/plan.md');
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
