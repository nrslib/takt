import { describe, expect, it } from 'vitest';

import {
  preparePreviousResponseContent,
  prepareReferenceContent,
  InstructionBuilder,
} from '../core/workflow/instruction/InstructionBuilder.js';
import { ReportInstructionBuilder } from '../core/workflow/instruction/ReportInstructionBuilder.js';
import { makeInstructionContext, makeStep } from './test-helpers.js';

describe('InstructionBuilder reference content', () => {
  it.each(['ja', 'en'] as const)('always includes the current work result section, including an empty response (%s)', (language) => {
    for (const lastResponse of [undefined, '', '   ']) {
      const report = new ReportInstructionBuilder(makeStep({ outputContracts: [{ name: 'result.md', format: '' }] }), {
        cwd: '/project', reportDir: '/reports', stepIteration: 2, language, lastResponse,
      }).build();
      const heading = language === 'ja' ? '## 作業結果' : '## Work Results';
      const message = language === 'ja' ? '今回の作業フェーズの回答を取得できませんでした。' : 'The response from the current work phase could not be retrieved.';
      expect(report).toContain(`${heading}\n\n`);
      expect(report).toContain(message);
      expect(report).toContain('Step Iteration: 2');
      expect(report).not.toContain('undefined');
    }
  });

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

  it.each(['en', 'ja'] as const)('reserves policy space for decisions across a merged runtime snapshot (%s)', (language) => {
    const contents = [
      '<!-- policy-priority -->FIRST-DECISION<!-- /policy-priority -->\n' + 'a'.repeat(2_100),
      '<!-- policy-priority -->LAST-DECISION<!-- /policy-priority -->\n'
        + '<!-- policy-priority -->FIRST-DECISION<!-- /policy-priority -->\nTAIL-DETAIL',
    ];
    const step = makeStep({ policyContents: contents.map(content => ({ content, sourcePath: '/original.md' })) });
    const context = makeInstructionContext({ language, policySourcePath: '/snapshot.md' });
    const direct = new InstructionBuilder(step, context).build();
    const snapshot = new InstructionBuilder(step, {
      ...context,
      policyContents: [{ content: contents.join('\n\n---\n\n'), sourcePath: '/snapshot.md' }],
    }).build();

    expect(snapshot).toBe(direct);
    expect(snapshot).toContain('FIRST-DECISION\n\nLAST-DECISION\n\n');
    expect(snapshot.split('FIRST-DECISION')).toHaveLength(2);
    expect(snapshot).not.toContain('policy-priority');
    expect(snapshot).not.toContain('TAIL-DETAIL');
    expect(snapshot).toContain('/snapshot.md');
  });

  it('keeps unmarked policies in their original order', () => {
    const content = 'LEGACY-HEAD\n' + 'x'.repeat(2_100) + 'LEGACY-TAIL';
    const prompt = new InstructionBuilder(makeStep({ policyContents: [{ content }] }), makeInstructionContext()).build();
    expect(prompt).toContain(content.slice(0, 2_000));
    expect(prompt).not.toContain('LEGACY-TAIL');
  });

  it.each(['\n', '\r\n'])('preserves headers and continuous rows when extracting part of a table (%j)', (newline) => {
    const header = '| Condition | Decision |\n|-----------|----------|';
    const selected = '| Priority condition | REJECT |';
    const remaining = '| Remaining condition | OK |\n| Last condition | OK |';
    const content = `# Policy\n\n<!-- policy-priority -->\n${header}\n${selected}\n<!-- /policy-priority -->\n${remaining}\n\nAfter table.`.replaceAll('\n', newline);
    const prompt = new InstructionBuilder(makeStep({ policyContents: [{ content }] }), makeInstructionContext()).build().replaceAll('\r\n', '\n');

    expect(prompt).toContain(`${header}\n${selected}\n\n# Policy`);
    expect(prompt).toContain(`# Policy\n\n${header}\n${remaining}\n\nAfter table.`);
    expect(prompt.split(selected)).toHaveLength(2);
    expect(prompt).not.toContain('policy-priority');
  });

  it.each([2_000, 2_001])('enforces the combined priority budget at %i characters', (length) => {
    const first = 'A'.repeat(998);
    const second = 'B'.repeat(length - first.length - 2);
    const step = makeStep({ policyContents: [first, second].map(content => ({
      content: `<!-- policy-priority -->${content}<!-- /policy-priority -->`,
    })) });
    const build = () => new InstructionBuilder(step, makeInstructionContext()).build();
    if (length === 2_000) expect(build()).toContain(`${first}\n\n${second}`);
    else expect(build).toThrow(/Policy priority content exceeds 2000/);
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
