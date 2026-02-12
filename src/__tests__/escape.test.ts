/**
 * Unit tests for template escaping and placeholder replacement
 *
 * Tests escapeTemplateChars and replaceTemplatePlaceholders functions.
 */

import { describe, it, expect } from 'vitest';
import {
  escapeTemplateChars,
  replaceTemplatePlaceholders,
} from '../core/piece/instruction/escape.js';
import { makeMovement, makeInstructionContext } from './test-helpers.js';

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
    const step = makeMovement();
    const ctx = makeInstructionContext({ task: 'implement feature X' });
    const template = 'Your task is: {task}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Your task is: implement feature X');
  });

  it('should escape braces in task content', () => {
    const step = makeMovement();
    const ctx = makeInstructionContext({ task: 'fix {bug} in code' });
    const template = '{task}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('fix ｛bug｝ in code');
  });

  it('should replace {iteration} and {max_movements}', () => {
    const step = makeMovement();
    const ctx = makeInstructionContext({ iteration: 3, maxMovements: 20 });
    const template = 'Iteration {iteration}/{max_movements}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Iteration 3/20');
  });

  it('should replace {movement_iteration}', () => {
    const step = makeMovement();
    const ctx = makeInstructionContext({ movementIteration: 5 });
    const template = 'Movement run #{movement_iteration}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Movement run #5');
  });

  it('should replace {previous_response} when passPreviousResponse is true', () => {
    const step = makeMovement({ passPreviousResponse: true });
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
    const step = makeMovement({ passPreviousResponse: true });
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
    const step = makeMovement({ passPreviousResponse: true });
    const ctx = makeInstructionContext();
    const template = 'Previous: {previous_response}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Previous: ');
  });

  it('should not replace {previous_response} when passPreviousResponse is false', () => {
    const step = makeMovement({ passPreviousResponse: false });
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
    const step = makeMovement();
    const ctx = makeInstructionContext({ userInputs: ['input 1', 'input 2', 'input 3'] });
    const template = 'Inputs: {user_inputs}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Inputs: input 1\ninput 2\ninput 3');
  });

  it('should replace {report_dir} with report directory', () => {
    const step = makeMovement();
    const ctx = makeInstructionContext({ reportDir: '/tmp/reports/run-1' });
    const template = 'Reports: {report_dir}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Reports: /tmp/reports/run-1');
  });

  it('should replace {report:filename} with full path', () => {
    const step = makeMovement();
    const ctx = makeInstructionContext({ reportDir: '/tmp/reports' });
    const template = 'Read {report:review.md} and {report:plan.md}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Read /tmp/reports/review.md and /tmp/reports/plan.md');
  });

  it('should handle template with multiple different placeholders', () => {
    const step = makeMovement();
    const ctx = makeInstructionContext({
      task: 'test task',
      iteration: 2,
      maxMovements: 5,
      movementIteration: 1,
      reportDir: '/reports',
    });
    const template = '{task} - iter {iteration}/{max_movements} - mv {movement_iteration} - dir {report_dir}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('test task - iter 2/5 - mv 1 - dir /reports');
  });

  it('should leave unreplaced placeholders when reportDir is undefined', () => {
    const step = makeMovement();
    const ctx = makeInstructionContext({ reportDir: undefined });
    const template = 'Dir: {report_dir} File: {report:test.md}';

    const result = replaceTemplatePlaceholders(template, step, ctx);
    expect(result).toBe('Dir: {report_dir} File: {report:test.md}');
  });
});
