import { describe, expect, it } from 'vitest';
import { renderToString } from 'ink';
import { createElement } from 'react';
import { formatGoalName, formatInquirySummary, formatPatrolSummary, formatPendingQuestion } from '../features/manager/goalDisplay.js';
import { ManagerGoalStatuses } from '../features/manager/ManagerGoalStatuses.js';
import { getLabel } from '../shared/i18n/index.js';

describe('manager patrol summaries', () => {
  it.each(['', '変化なし'])('keeps a short summary %j without an ellipsis', (summary) => {
    expect(formatPatrolSummary(summary)).toBe(summary);
  });

  it('normalizes whitespace and shortens without splitting graphemes', () => {
    expect(formatPatrolSummary(' 変化なし\r\n\t' + 'e\u0301👩‍💻'.repeat(30)))
      .toBe('変化なし ' + 'e\u0301👩‍💻'.repeat(17) + '…');
  });
});

describe('manager goal status priority', () => {
  it.each(['ja', 'en'] as const)('prioritizes paused and aborted execution over completion in %s', (lang) => {
    const output = renderToString(createElement(ManagerGoalStatuses, {
      lang, questions: [], goals: [
        { id: 'paused', objective: '停止対象', status: 'completed', executionStatus: 'paused' },
        { id: 'aborted', objective: '中止対象', status: 'awaiting_merge', executionStatus: 'aborted' },
      ],
    }), { columns: 160 });
    const rows = output.split('\n');
    expect(rows.find((row) => row.includes('停止対象'))).toContain(getLabel('manager.goalStates.paused', lang));
    expect(rows.find((row) => row.includes('中止対象'))).toContain(getLabel('manager.goalStates.aborted', lang));
    expect(output).not.toContain(getLabel('manager.goalStates.completed', lang));
    expect(output).not.toContain(getLabel('manager.goalStates.awaiting_merge', lang));
  });
});

describe('manager goal names', () => {
  it('normalizes line breaks and repeated whitespace before shortening', () => {
    expect(formatGoalName('  顧客\r出力\r\nを\n 改善\t  する  ')).toBe('顧客 出力 を 改善 する');
  });

  it.each(['', ' \t\r\n ', '\x1b[31m\x1b[0m'])('shows the same visible empty name for %j', (objective) => {
    expect(formatGoalName(objective)).toBe('—');
  });

  it.each([23, 24, 25])('limits a Japanese goal name of %i graphemes including the ellipsis', (length) => {
    const objective = '目'.repeat(length);
    expect(formatGoalName(objective)).toBe(length <= 24 ? objective : '目'.repeat(23) + '…');
  });

  it.each(['e\u0301', '👩‍💻'])('keeps %s graphemes intact when shortening', (grapheme) => {
    expect(formatGoalName(grapheme.repeat(25))).toBe(grapheme.repeat(23) + '…');
  });

  it('produces the same name on repeated calls and equivalent whitespace', () => {
    const expected = formatGoalName('同じ目的の表示をすべての一覧で統一するための長い説明');
    expect(formatGoalName('同じ目的の表示をすべての一覧で統一するための長い説明')).toBe(expected);
    expect(formatGoalName('  同じ目的の表示をすべての一覧で統一するための長い説明\n')).toBe(expected);
  });

  it('removes terminal control sequences before applying the name limit', () => {
    expect(formatGoalName('\x1b[31m顧客\x1b[0m\r\n出力\x07')).toBe('顧客 出力');
  });
});

describe('manager inquiry summaries', () => {
  it.each(['ja', 'en'] as const)('names a standalone approval without inventing a goal in %s', (lang) => {
    const row = formatPendingQuestion({ goalId: null, owner: { kind: 'repository', repositoryDirectory: '/fixture' },
      question: { id: 'standalone', kind: 'approval', recipient: 'human', status: 'pending', body: 'Write output' } }, lang);
    expect(row).toBe(`${getLabel('manager.inquiryKinds.approval', lang)}: ${formatGoalName(getLabel('manager.inquiryNoGoal', lang))} — Write output`);
  });
  it.each(['ja', 'en'] as const)('formats an inquiry row with the common name and summary in %s', (lang) => {
    const objective = '目的'.repeat(30);
    const body = '要点\n' + '本文'.repeat(40);
    expect(formatPendingQuestion({ goalId: 'goal', repositoryDirectory: '/fixture', objective, question: {
      id: 'question', recipient: 'human', status: 'pending', kind: 'approval', body,
    } }, lang)).toBe(`${getLabel('manager.inquiryKinds.approval', lang)}: ${formatGoalName(objective)} — ${formatInquirySummary(body)}`);
  });
  it('normalizes the body into a single line', () => {
    expect(formatInquirySummary('  保存先\r\n を\t 選ぶ\n  ')).toBe('保存先 を 選ぶ');
  });

  it.each([39, 40, 41])('limits a body of %i graphemes including the ellipsis', (length) => {
    const body = 'e\u0301'.repeat(length);
    expect(formatInquirySummary(body)).toBe(length <= 40 ? body : 'e\u0301'.repeat(39) + '…');
  });
});
