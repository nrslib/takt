import { describe, expect, it } from 'vitest';

import {
  preparePreviousResponseContent,
  prepareReferenceContent,
  InstructionBuilder,
} from '../core/workflow/instruction/InstructionBuilder.js';
import { ReportInstructionBuilder } from '../core/workflow/instruction/ReportInstructionBuilder.js';
import { makeInstructionContext, makeStep } from './test-helpers.js';

describe('InstructionBuilder reference content', () => {
  it('keeps short reference material free of source metadata', () => {
    expect(prepareReferenceContent('短い資料', '/tmp/reference.md', 'ja')).toBe('短い資料');
  });

  it('truncates long reference material and preserves the path to the full source', () => {
    const content = 'あ'.repeat(2_000) + 'SOURCE_TAIL';
    const result = prepareReferenceContent(content, '/tmp/reference.md', 'ja');

    expect(result).toContain('あ'.repeat(2_000));
    expect(result).not.toContain('SOURCE_TAIL');
    expect(result).toContain('/tmp/reference.md');
  });

  it('omits source metadata when a previous response is not truncated', () => {
    const result = preparePreviousResponseContent('完了内容', '/tmp/response.md', false, 'ja');

    expect(result).toBe('完了内容');
  });

  it.each(['en', 'ja'] as const)('preserves exactly the upstream content supplied to Phase 1 (%s)', (language) => {
    const upstream = 'UPSTREAM-CONTRACT\n' + 'x'.repeat(2_100) + '\nUPSTREAM-TAIL';
    for (const preserveFullPreviousResponse of [false, true]) {
      const userInputs = ['Withdraw the old obligation.', 'Use the revised acceptance condition.'];
      const step = makeStep({
        passPreviousResponse: true,
        ...(preserveFullPreviousResponse ? { preserveFullPreviousResponse: true as const } : {}),
        instruction: 'Use {previous_response} and {user_inputs}.',
        outputContracts: [{ name: 'result.md', format: '' }],
      });
      const context = makeInstructionContext({
        language, userInputs, previousResponseSourcePath: '/previous-source.md',
        previousOutput: { persona: 'planner', status: 'done', content: upstream, timestamp: new Date() },
      });
      const prepared = new InstructionBuilder(step, context).prepare();
      const expected = preparePreviousResponseContent(upstream, '/previous-source.md', preserveFullPreviousResponse, language);
      expect(prepared.reportInputs).toEqual({ userInputs, previousResponse: expected });
      expect(prepared.text).toContain(expected);
      userInputs.push('Not supplied at preparation time');
      const report = new ReportInstructionBuilder(step, {
        cwd: context.cwd, reportDir: '/reports', stepIteration: 1, language,
        reportInputs: prepared.reportInputs, lastResponse: 'Generic completed result',
      }).build();
      expect(report).toContain(JSON.stringify(expected));
      expect(report).not.toContain('Not supplied at preparation time');
      expect(report.includes('UPSTREAM-TAIL')).toBe(preserveFullPreviousResponse);
    }
  });

  it('does not preserve upstream content when the step disables previous responses', () => {
    const prepared = new InstructionBuilder(makeStep({ passPreviousResponse: false }), makeInstructionContext({
      previousOutput: { persona: 'planner', status: 'done', content: 'HIDDEN-UPSTREAM', timestamp: new Date() },
    })).prepare();
    expect(prepared.reportInputs).toEqual({ userInputs: [] });
    expect(prepared.text).not.toContain('HIDDEN-UPSTREAM');
  });

  it.each(['en', 'ja'] as const)('makes the report evidence requirements available while work tools are usable (%s)', (language) => {
    const format = '# REPORT-STRUCTURE\n| Contract | Location | Observation | Original execution |\n| {ID} | {file:line} | {value} | {record} |';
    const order = 'PRESERVE-CONTRACT-ORDER';
    const step = makeStep({
      instruction: 'Respond under WORK-RESULT-HEADING.',
      outputContracts: [{ name: 'result.md', format, order }],
    });
    const prepared = new InstructionBuilder(step, makeInstructionContext({ language, reportDir: '/reports' })).prepare();
    const report = new ReportInstructionBuilder(step, { cwd: '/project', reportDir: '/reports', stepIteration: 1, language }).build();
    expect(prepared.text).toContain(format);
    expect(report).toContain(format);
    expect(prepared.text).toContain(order);
    expect(report).toContain(order);
    expect(prepared.text).toContain('WORK-RESULT-HEADING');
    expect(prepared.injectedReports).toEqual([]);
  });
});
