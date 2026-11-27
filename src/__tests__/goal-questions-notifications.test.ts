import * as crypto from 'node:crypto';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { MANAGER_NOTIFICATION_KINDS } from '../core/models/config-types.js';
import { appendGoalNotification,formatGoalNotification,formatGoalQuestionNotification,formatIntegratedWorkNotification } from '../infra/goals/notifications.js';
import { addGoalQuestion,answerGoalQuestion,withdrawGoalQuestion } from '../infra/goals/questions.js';
import { GoalSchema,type Goal,type GoalQuestion } from '../infra/goals/schema.js';
import { getLabel } from '../shared/i18n/index.js';
import { goalRecord } from './helpers/goal-fixtures.js';

vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
afterEach(() => vi.mocked(crypto.randomUUID).mockReset()
  .mockImplementation(() => '650e8400-e29b-41d4-a716-446655440001'));
const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
const answerMenuKey = /(?:Ctrl\+R|\^R)\b/iu;

function expectAnswerSelectionGuidance(text: string, questionId: string): void {
  const guidance = text.split('\n').filter((line) => answerMenuKey.test(line));
  expect(guidance).toHaveLength(1);
  expect(guidance[0]).toMatch(answerMenuKey);
  expect(guidance[0]).not.toContain(questionId);
}

describe('saved goal questions', () => {
  it('saves question creation time and preserves it when answering or withdrawing', () => {
    const before = Date.now();
    const created = addGoalQuestion(goalRecord(), { body: '形式はどれですか' });
    const createdAt = created.goal.questions![0]!.createdAt!;
    expect(Date.parse(createdAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(createdAt)).toBeLessThanOrEqual(Date.now());
    expect(answerGoalQuestion(created.goal, created.questionId, 'JSON').questions![0]!.createdAt).toBe(createdAt);
    expect(withdrawGoalQuestion(created.goal, created.questionId).questions![0]!.createdAt).toBe(createdAt);
  });

  it('rejects missing questions and blank answers without creating an event', () => {
    const created = addGoalQuestion(goalRecord(), { body: '形式はどれですか' });
    expect(() => answerGoalQuestion(created.goal, created.questionId, ' ')).toThrow();
    expect(() => answerGoalQuestion(created.goal, 'missing', 'JSON')).toThrow();
    expect(() => withdrawGoalQuestion(created.goal, 'missing')).toThrow();
    expect(created.goal.questions).toEqual([expect.objectContaining({ status: 'pending' })]);
  });
});

describe('saved goal notifications', () => {
  it.each(MANAGER_NOTIFICATION_KINDS)('persists %s only when enabled without changing the record shape', (kind) => {
    const original: Goal = goalRecord();
    const input = { kind, body: '人への通知', severity: 'warning' as const };
    const saved = appendGoalNotification(original, input, policy);
    expect(saved.notifications).toEqual([{ ...input, id: expect.any(String), recordedAt: expect.any(String) }]);
    expect(original.notifications).toBeUndefined();
    expect(GoalSchema.parse(saved)).toEqual(saved);
    expect(appendGoalNotification(original, input, { ...policy, [kind]: false }).notifications).toBeUndefined();
  });

  it('rejects notification ID collisions without changing the saved notification', () => {
    vi.mocked(crypto.randomUUID).mockReturnValue('650e8400-e29b-41d4-a716-446655440001');
    const input = { kind: 'custom' as const, body: '通知' };
    const saved = appendGoalNotification(goalRecord(), input, policy);
    expect(() => appendGoalNotification(saved, input, policy)).toThrow();
    expect(saved.notifications).toEqual([{ ...input, id: expect.any(String), recordedAt: expect.any(String) }]);
  });
});

describe.each(['ja', 'en'] as const)('human-readable goal notifications in %s', (language) => {
  const firstSentence = language === 'ja' ? 'CSV の書き出しを足す。' : 'Add CSV export.';
  const objective = firstSentence + (language === 'ja' ? '詳しい条件は次の通りです。' : ' The details follow.');
  const goal: Goal = { ...goalRecord(), objective };
  const completion = {
    goalBranch: goal.branch, goalSha: 'a'.repeat(40), targetBranch: 'release',
    summary: language === 'ja' ? 'CSV の書き出しを足しました。\n一覧から使えます。\n\n受け入れ条件: 完了。テスト: 10 件。'
      : 'Added CSV export.\nIt is available from the list.\n\nAcceptance criteria: passed. Tests: 10.',
    changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
    instructions: ['takt_complete_goal expectedSha=' + 'a'.repeat(40), 'takt_merge_goal_pr until=prepare'],
  };

  it.each(MANAGER_NOTIFICATION_KINDS)('shows a localized %s heading with project and a complete first objective sentence', (kind) => {
    const text = formatGoalNotification(goal, { kind, body: 'Result' }, language, 'customer-export');
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^\[customer-export\] /u);
    expect(lines[kind === 'awaiting_merge' ? 1 : 0]).toContain(firstSentence);
    expect(text).not.toContain(objective);
    expect(text).not.toContain(goal.id.slice(0, 8));
    expect(text).not.toContain('{');
    expect(lines[0]).toContain(getLabel(`manager.notificationHumanHeadings.${kind}`, language, { project: 'customer-export', context: '' }));
  });

  it.each(['1.', '1)', '-', '*', '+', '•', '・'])('extracts the first objective sentence after removing list markers (%s)', (marker) => {
    const secondSentence = language === 'ja' ? 'テストを足す。' : 'Add tests.';
    const objective = `${marker} ${firstSentence}\n2. ${secondSentence}`;
    const current = { ...goal, objective };
    const before = structuredClone(current);
    for (const kind of ['custom', 'awaiting_merge'] as const) {
      const lines = formatGoalNotification(current, { kind, body: 'Result' }, language, 'takt').split('\n');
      const goalLine = lines[kind === 'awaiting_merge' ? 1 : 0]!;
      expect(goalLine).toContain(firstSentence);
      expect(goalLine).not.toContain(marker);
      expect(goalLine).not.toContain(secondSentence);
    }
    expect(current).toEqual(before);
  });

  it.each(['1.', '1)', '-', '*', '+', '•', '・'])('preserves a trimmed marker-only objective (%s)', (marker) => {
    const current = { ...goal, objective: ` \t${marker} \t ` };
    for (const kind of ['custom', 'awaiting_merge'] as const) {
      const lines = formatGoalNotification(current, { kind, body: 'Result' }, language, 'takt').split('\n');
      if (kind === 'awaiting_merge') {
        expect(lines[1]).toBe(getLabel('manager.notificationHumanGoal', language, { objective: marker }));
      } else {
        expect(lines[0]).toContain(getLabel('manager.notificationGoalContext', language, { objective: marker }));
      }
    }
  });

  it.each(['1.', '1)', '-', '*', '+', '•', '・'])('preserves a trimmed marker-only completion summary (%s)', (marker) => {
    const summary = ` \t${marker} \t `;
    for (const current of [goal, { ...goal, completion: { ...completion, summary } }]) {
      const text = formatGoalNotification(current, { kind: 'awaiting_merge', body: summary }, language, 'takt');
      expect(text.split('\n').at(-1)).toBe(getLabel('manager.notificationChanges', language, { summary: marker }));
    }
  });

  it.each([false, true])('shows the PR link only when saved and hides completion instructions (PR=%s)', (hasPr) => {
    const current: Goal = { ...goal, completion,
      ...(hasPr ? { pullRequest: { number: 1987, url: 'https://github.com/nrslib/takt/pull/1987' } } : {}),
    };
    const before = structuredClone(current);
    const text = formatGoalNotification(current, { kind: 'awaiting_merge', body: completion.summary + '\n' + completion.instructions.join('\n') }, language, 'takt');
    const lines = text.split('\n');
    expect(lines[0]!.includes('PR #1987')).toBe(hasPr);
    expect(lines.includes('https://github.com/nrslib/takt/pull/1987')).toBe(hasPr);
    expect(lines[1]).toContain(firstSentence);
    expect(lines[2]).toBe(language === 'ja'
      ? '仕上げ（release の取り込み、レビュー、CI の通過）が終わってから、PR を確認して release にマージしてください。'
      : 'Once preparation is complete (incorporating release, code review, and passing CI), review the PR and merge it into release.');
    expect(lines.at(-2)).toBe('');
    expect(lines.at(-1)).toBe(getLabel('manager.notificationChanges', language, {
      summary: completion.summary.split('\n\n')[0]!.replace('\n', ' '),
    }));
    expect(text).not.toContain('10');
    expect(text).not.toContain('takt_complete_goal');
    expect(text).not.toContain('takt_merge_goal_pr');
    expect(current).toEqual(before);
  });

  it.each(['main', 'develop'])('requires preparation with %s without a completion record or a PR', (branch) => {
    const text = formatGoalNotification({ ...goal, integrationBranch: branch }, { kind: 'awaiting_merge', body: 'Ready.\n\nDetailed results.' }, language, 'takt');
    expect(text.split('\n')[2]).toBe(language === 'ja'
      ? `仕上げ（${branch} の取り込み、レビュー、CI の通過）が終わってから、PR を確認して ${branch} にマージしてください。`
      : `Once preparation is complete (incorporating ${branch}, code review, and passing CI), review the PR and merge it into ${branch}.`);
    expect(text).not.toContain('PR #');
    expect(text).not.toContain('Detailed results.');
    expect(text).toContain('Ready.');
  });

  it('ends a long summary at a sentence boundary without including the next paragraph', () => {
    const sentence = language === 'ja' ? '変更を確認しました。' : 'Verified the change. ';
    const summary = sentence.repeat(100) + '\r\n \r\nTEST RESULTS';
    const text = formatGoalNotification({ ...goal, completion: { ...completion, summary } }, { kind: 'awaiting_merge', body: 'unused' }, language, 'takt');
    const digest = text.split('\n').at(-1)!.replace(language === 'ja' ? /^変更: /u : /^Changes: /u, '');
    expect(digest.length).toBeLessThanOrEqual(600);
    expect(digest).toBe(sentence.repeat(Math.floor(600 / sentence.length)).trim());
    expect(text).not.toContain('TEST RESULTS');
    expect(text).not.toContain('…');
  });

  it.each(['1.', '1)', '-', '*', '+', '•', '・'])('uses the same list normalization for a long objective and completion summary (%s)', (marker) => {
    const sentence = language === 'ja' ? `CSV に${'指定された列と行を'.repeat(80)}書き出せるようにしました。`
      : `Added CSV export with ${'the selected columns and rows '.repeat(30)}included.`;
    const remainder = language === 'ja' ? '次の変更は省略します。' : 'Omit this subsequent change.';
    const paragraph = `${marker} ${sentence}\n2. ${remainder}`;
    const current = { ...goal, objective: paragraph, completion: { ...completion, summary: `${paragraph}\n\nTEST RESULTS` } };
    const before = structuredClone(current);
    expect(sentence.length).toBeGreaterThan(600);

    const lines = formatGoalNotification(current, { kind: 'awaiting_merge', body: 'unused' }, language, 'takt').split('\n');

    expect(lines[1]).toBe(getLabel('manager.notificationHumanGoal', language, { objective: sentence }));
    expect(lines.at(-1)).toBe(getLabel('manager.notificationChanges', language, { summary: sentence }));
    expect(lines.join('\n')).not.toContain(remainder);
    expect(lines.join('\n')).not.toContain('TEST RESULTS');
    expect(current).toEqual(before);
  });

  it.each([60, 61, 700])('keeps a single %s-grapheme objective and summary sentence complete', (length) => {
    const sentence = 'e\u0301'.repeat(length) + '。';
    const text = formatGoalNotification({ ...goal, objective: sentence, completion: { ...completion, summary: sentence + '\n\nDetails' } },
      { kind: 'awaiting_merge', body: 'unused' }, language, 'takt');
    expect(text.split('\n')[1]).toContain(sentence);
    expect(text.split('\n').at(-1)).toContain(sentence);
    expect(text).not.toContain('…');
    expect(text).not.toContain('Details');
  });

  it.each([60, 61])('preserves the TUI objective boundary at %s graphemes', (length) => {
    const objective = 'e\u0301'.repeat(length);
    const lines = formatGoalNotification({ ...goal, objective }, { kind: 'custom', body: 'Notice' }, language, 'takt', 'tui').split('\n');
    expect(lines[1]).toContain(length === 60 ? objective : 'e\u0301'.repeat(59) + '…');
    expect(lines[1]).toContain(goal.id.slice(0, 8));
  });

  it.each(['blocked', 'custom'] as const)('keeps explicitly supplied severity in Slack and TUI %s notifications', (kind) => {
    for (const severity of [undefined, 'info', 'warning', 'error'] as const) {
      for (const destination of ['slack', 'tui'] as const) {
        const text = formatGoalNotification(goal, { kind, body: 'Result', ...(severity === undefined ? {} : { severity }) }, language, 'takt', destination);
        const lines = text.split('\n');
        expect(lines).toContain('Result');
        const severityLines = lines.filter((line) => line.startsWith(language === 'ja' ? '重要度:' : 'Severity:'));
        if (severity === undefined) {
          expect(severityLines).toEqual([]);
        } else {
          const expected = getLabel('manager.notificationSeverity', language, {
            severity: getLabel(`manager.notificationSeverities.${severity}`, language),
          });
          expect(severityLines).toEqual([expected]);
          expect(lines[destination === 'slack' ? 1 : 2]).toBe(expected);
        }
      }
    }
  });

  it.each(['progress', 'completed', 'blocked', 'custom'] as const)('preserves short multiline %s bodies and bounds long ones without changing saved data', (kind) => {
    for (const length of [599, 600, 601]) {
      const body = 'e\u0301'.repeat(length);
      const current = appendGoalNotification(goal, { kind, body }, policy);
      const before = structuredClone(current);
      const text = formatGoalNotification(current, current.notifications![0]!, language, 'takt');
      expect(text.split('\n')[1]).toBe(length > 600 ? 'e\u0301'.repeat(599) + '…' : body);
      expect(current).toEqual(before);
      const hint = getLabel('manager.notificationFullMessage', language, { project: 'takt' });
      expect(text.includes(hint)).toBe(kind === 'custom' && length > 600);
      if (kind === 'blocked') expect(text.split('\n').at(-1)).toBe(getLabel('manager.notificationHumanBlockedAction', language));
    }
    const body = '理由: 認証に失敗しました。\n必要な操作: 認証情報を更新してください。  ';
    expect(formatGoalNotification(goal, { kind, body }, language, 'takt')).toContain(body);
  });

  it('removes trailing whitespace only from a shortened body prefix', () => {
    const prefix = 'e\u0301'.repeat(597) + '  ';
    expect(formatGoalNotification(goal, { kind: 'custom', body: prefix + 'XY' }, language, 'takt').split('\n')[1]).toBe('e\u0301'.repeat(597) + '…');
  });

  it.each([119, 120, 121])('preserves the full integrated purpose at %s graphemes', (length) => {
    const purpose = 'e\u0301'.repeat(length);
    expect(formatIntegratedWorkNotification(purpose, language)).toContain(purpose);
  });

  const question: GoalQuestion = {
    id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human', status: 'pending',
    body: '書き出す範囲をどちらにしますか？', options: ['表示中の一覧だけ', '条件に合う全件'],
    recommendation: '条件に合う全件（一覧の件数に上限があるため）',
  };
  function questionText(saved: GoalQuestion, destination: 'slack' | 'tui' = 'slack'): string {
    return formatGoalNotification({ ...goal, questions: [saved] }, { kind: 'question', body: formatGoalQuestionNotification(saved, language === 'ja' ? 'en' : 'ja') }, language, 'takt', destination);
  }

  it('numbers options on separate lines and keeps a recommendation with its reason unchanged', () => {
    const before = structuredClone(question);
    const lines = questionText(question).split('\n');
    expect(lines[1]).toBe(question.body);
    expect(lines[2]).toBe('1. 表示中の一覧だけ');
    expect(lines[3]).toBe('2. 条件に合う全件');
    expect(lines[4]).toBe(getLabel('manager.notificationRecommendation', language, { recommendation: question.recommendation! }));
    expectAnswerSelectionGuidance(lines.join('\n'), question.id);
    expect(question).toEqual(before);
  });

  it('retains a separate recommendation when it does not match an option', () => {
    const recommendation = 'Discuss the output format first';
    expect(questionText({ ...question, recommendation })).toContain(getLabel('manager.notificationRecommendation', language, { recommendation }));
  });

  it.each([
    { options: ['CSV', 'JSON'], recommendation: 'JSON', index: 1 },
    { options: ['CSV', 'JSON'], recommendation: 'JSON Lines（順次処理できるため）', index: null },
    { options: ['CSV', 'JSON'], recommendation: 'JSON（順次処理できるため）', index: null },
    { options: ['CSV', 'JSON'], recommendation: 'YAML', index: null },
    { options: ['JSON', 'JSON Lines'], recommendation: 'JSON Lines（順次処理できるため）', index: null },
    { options: ['JSON', 'JSON Lines'], recommendation: 'JSON Lines', index: 1 },
    { options: ['JSON Lines', 'JSON'], recommendation: 'JSON', index: 1 },
  ])('marks only an exact recommendation match: $recommendation ($options)', ({ options, recommendation, index }) => {
    const saved = { ...question, options, recommendation };
    const before = structuredClone(saved);
    const lines = questionText(saved).split('\n');
    const suffix = getLabel('manager.notificationRecommended', language);
    expect(lines.slice(2, 2 + options.length)).toEqual(options.map((option, optionIndex) =>
      `${optionIndex + 1}. ${option}${optionIndex === index ? suffix : ''}`));
    const recommendationLines = lines.filter((line) => /^(推奨:|Recommendation:)/u.test(line));
    expect(recommendationLines).toEqual(index === null
      ? [getLabel('manager.notificationRecommendation', language, { recommendation })] : []);
    expect(saved).toEqual(before);
  });

  it('marks every option that exactly matches the recommendation', () => {
    const options = ['JSON', 'JSON Lines', 'JSON Lines'];
    const recommendation = 'JSON Lines';
    const lines = questionText({ ...question, options, recommendation }).split('\n');
    const suffix = getLabel('manager.notificationRecommended', language);
    expect(lines.slice(2, 5)).toEqual(['1. JSON', `2. JSON Lines${suffix}`, `3. JSON Lines${suffix}`]);
    expect(lines).not.toContain(getLabel('manager.notificationRecommendation', language, { recommendation }));
  });

  it.each(['pending', 'answered', 'withdrawn'] as const)('shows answer guidance only for a %s question and keeps all TUI options', (status) => {
    const options = ['CSV', 'JSON', 'TSV', 'XML', 'YAML', 'Parquet', 'Avro'];
    const saved: GoalQuestion = { ...question, status, options, recommendation: 'Avro',
      ...(status === 'answered' ? { answer: { text: 'CSV', source: 'tui' as const, answeredAt: '2026-10-12T00:00:00Z' } } : {}),
    };
    const slack = questionText(saved);
    const tui = questionText(saved, 'tui');
    expect(slack).toContain('5. YAML');
    expect(slack).not.toContain('6. Parquet');
    expect(slack).toContain(getLabel('manager.notificationMoreOptions', language, { count: '2' }));
    expect(slack).toContain(getLabel('manager.notificationRecommendation', language, { recommendation: 'Avro' }));
    expect(tui).toContain(options.join(', '));
    for (const text of [slack, tui]) {
      expect(text.split('\n').filter((line) => answerMenuKey.test(line))).toHaveLength(status === 'pending' ? 1 : 0);
      expect(text).toContain(saved.body);
    }
    expect(formatGoalQuestionNotification(saved, language)).toContain(options.join(', '));
  });

  it.each([false, true])('preserves grapheme boundaries when shortening question details (exceeds=%s)', (exceeds) => {
    const extra = exceeds ? 1 : 0;
    const saved = { ...question, body: 'e\u0301'.repeat(300 + extra), options: ['e\u0301'.repeat(60 + extra), 'JSON', 'TSV', 'XML', 'YAML'],
      recommendation: 'e\u0301'.repeat(200 + extra),
    };
    const text = questionText(saved);
    const lines = text.split('\n');
    expect(lines[1]).toBe(exceeds ? 'e\u0301'.repeat(299) + '…' : saved.body);
    expect(lines[2]).toBe('1. ' + (exceeds ? 'e\u0301'.repeat(59) + '…' : saved.options[0]));
    expect(text).toContain(getLabel('manager.notificationRecommendation', language, { recommendation: saved.recommendation }));
    const tui = questionText(saved, 'tui').split('\n');
    expect(tui[2]).toBe(lines[1]);
    expect(tui[3]).toBe(getLabel('manager.notificationOptions', language, { options: saved.options.join(', ') }));
    expect(tui[4]).toBe(getLabel('manager.notificationRecommendation', language, { recommendation: exceeds ? 'e\u0301'.repeat(199) + '…' : saved.recommendation }));
  });

  it.each([5, 6, 7])('shows exactly the remaining count for %s options', (count) => {
    const saved = { ...question, options: ['CSV', 'JSON', 'TSV', 'XML', 'YAML', 'Parquet', 'Avro'].slice(0, count) };
    const text = questionText(saved);
    expect(text).toContain('5. YAML');
    const remainder = text.split('\n').filter((line) => /ほかに|Additional options/iu.test(line));
    expect(remainder).toEqual(count === 5 ? [] : [getLabel('manager.notificationMoreOptions', language, { count: String(count - 5) })]);
  });

  it('bounds a large options list and retains the full saved details', () => {
    const saved = { ...question, options: Array.from({ length: 100 }, (_, index) => `Format ${index} `.repeat(100)) };
    const text = questionText(saved);
    expect(text).toContain('Format 0');
    expect(text).toContain('Format 4');
    expect(text).toContain('95');
    expect(text.length).toBeLessThan(2000);
    expect(formatGoalQuestionNotification(saved, language)).toContain('Format 99');
  });

  it.each([
    { kind: 'question' as const, body: `関連質問 ${question.id}: 本文中のID` },
    { kind: 'question' as const, body: `> ${question.id}: 引用` },
    { kind: 'custom' as const, body: `${question.id}: 一般通知` },
  ])('does not infer question details from an ID in $kind text', (notification) => {
    const text = formatGoalNotification({ ...goal, questions: [question] }, notification, language, 'takt');
    expect(text).toContain(notification.body);
    expect(text).not.toContain('1. ' + question.options![0]);
    expect(text.split('\n').filter((line) => answerMenuKey.test(line))).toEqual([]);
  });

  it('keeps TUI goal IDs, body digest, merge instructions and unnumbered question options', () => {
    const current = { ...goal, completion };
    const before = structuredClone(current);
    const lines = formatGoalNotification(current, { kind: 'awaiting_merge', body: 'unused' }, language, 'takt', 'tui').split('\n');
    expect(lines[1]).toContain(goal.id.slice(0, 8));
    expect(lines.slice(-completion.instructions.length)).toEqual(completion.instructions);
    expect(questionText(question, 'tui')).toContain(getLabel('manager.notificationOptions', language, { options: question.options!.join(', ') }));
    expect(current).toEqual(before);
  });
});
