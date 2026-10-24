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
  const headings = language === 'ja' ? {
    progress: /進捗|取り込み/u, awaiting_merge: /マージを待|マージ待ち/u, completed: /ゴールが完成|ゴールが完了/u,
    blocked: /進められません|進行できません/u, question: /質問があります/u, custom: /お知らせ|通知/u,
  } : {
    progress: /progress update|work integrated/iu, awaiting_merge: /awaiting merge|waiting for.*merge/iu, completed: /goal completed|goal is complete/iu,
    blocked: /cannot proceed|unable to proceed/iu, question: /question|input needed/iu, custom: /notification|update/iu,
  };

  it.each(MANAGER_NOTIFICATION_KINDS)('shows the event and project before a short goal reference for %s', (kind) => {
    const goal = goalRecord();
    const body = language === 'ja' ? '確認した内容をお知らせします' : 'Here is the result of the checks';
    const text = formatGoalNotification(goal, { kind, body, severity: 'warning' }, language, 'customer-export');
    const lines = text.split('\n');

    expect(lines[0]).toMatch(headings[kind]);
    expect(lines[0]).toContain('customer-export');
    expect(lines[1]).toContain(goal.objective);
    expect(lines[1]).toContain(goal.id.slice(0, 8));
    expect(lines[1]).toMatch(language === 'ja' ? /ゴール/u : /goal/iu);
    expect(lines).toContain(body);
    for (const line of lines) {
      expect(line).not.toMatch(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu);
      expect(line.trim()).not.toMatch(/^(progress|awaiting_merge|completed|blocked|question|custom)(?:\s*\([^)]*\))?$/iu);
      expect(line).not.toContain('(warning)');
    }
  });

  it.each(['slack', 'tui'] as const)('shows only explicitly specified severity in %s notifications', (destination) => {
    const labels = language === 'ja'
      ? { info: '情報', warning: '警告', error: 'エラー' }
      : { info: 'Information', warning: 'Warning', error: 'Error' };
    const prefix = language === 'ja' ? '重要度: ' : 'Severity: ';
    for (const kind of ['blocked', 'custom'] as const) {
      const body = 'warning';
      const withoutSeverity = formatGoalNotification(goalRecord(), { kind, body }, language, 'customer-export', destination).split('\n');
      expect(withoutSeverity).toContain(body);
      expect(withoutSeverity.filter((line) => line.startsWith(prefix))).toEqual([]);
      for (const severity of ['info', 'warning', 'error'] as const) {
        const lines = formatGoalNotification(goalRecord(), { kind, body, severity }, language, 'customer-export', destination).split('\n');
        expect(lines[2]).toBe(prefix + labels[severity]);
        expect(lines.slice(0, 2)).toEqual(withoutSeverity.slice(0, 2));
        expect(lines.slice(3)).toEqual(withoutSeverity.slice(2));
      }
    }
  });

  it.each(['progress', 'awaiting_merge', 'completed', 'blocked', 'custom'] as const)('shortens a multiline objective and long %s body', (kind) => {
    const objective = language === 'ja'
      ? `顧客の出力を改善する\n${'長い目的の説明'.repeat(500)}`
      : `Improve customer exports\n${'A detailed goal description '.repeat(500)}`;
    const body = language === 'ja' ? '長い結果の説明'.repeat(1000) : 'A detailed result description '.repeat(1000);
    const goal = { ...goalRecord(), objective };
    const before = structuredClone(goal);
    const text = formatGoalNotification(goal, { kind, body }, language, 'customer-export');
    const goalLine = text.split('\n')[1]!;

    expect(goalLine.includes(objective.split('\n')[0]!)).toBe(true);
    expect(goalLine).toContain(goal.id.slice(0, 8));
    expect(goalLine.length).toBeLessThan(objective.length);
    expect(text).toContain(body.slice(0, 20));
    expect(text.length).toBeLessThan(2000);
    expect(text).not.toContain(goal.id);
    expect(goal).toEqual(before);
  });

  it('preserves manager-provided words in a custom notification', () => {
    const body = 'progress / awaiting_merge / completed / blocked / question / custom';
    const text = formatGoalNotification(goalRecord(), { kind: 'custom', body }, language, 'customer-export');
    expect(text.split('\n')).toContain(body);
  });

  it('keeps combining characters intact when shortening an objective', () => {
    const objective = 'e\u0301'.repeat(100);
    const text = formatGoalNotification({ ...goalRecord(), objective }, { kind: 'custom', body: 'Notice' }, language, 'customer-export');
    const line = text.split('\n')[1]!;
    expect(line).toContain('e\u0301'.repeat(59) + '…');
    expect(line).not.toContain('e…');
  });

  it.each([60, 61])('keeps the objective boundary at %s graphemes for both destinations', (length) => {
    const objective = 'e\u0301'.repeat(length);
    const goal = { ...goalRecord(), objective };
    for (const destination of ['slack', 'tui'] as const) {
      const line = formatGoalNotification(goal, { kind: 'custom', body: 'Notice' }, language, 'customer-export', destination).split('\n')[1]!;
      const expected = length === 60 ? objective : 'e\u0301'.repeat(59) + '…';
      expect(line).toContain(expected);
      expect(line).toContain(goal.id.slice(0, 8));
    }
  });

  it.each([119, 120, 121])('preserves the full integrated purpose at %s graphemes', (length) => {
    const purpose = 'e\u0301'.repeat(length);
    const text = formatIntegratedWorkNotification(purpose, language);
    expect(text).toBe(language === 'ja' ? `「${purpose}」の作業を取り込みました。`
      : `Integrated the work on “${purpose}”.`);
  });

  it.each([600, 601])('shortens a saved %s-grapheme progress body only for Slack display', (length) => {
    const body = 'e\u0301'.repeat(length);
    const goal = appendGoalNotification(goalRecord(), { kind: 'progress', body }, policy);
    const saved = structuredClone(goal);
    const notification = goal.notifications![0]!;
    for (const destination of ['slack', 'tui'] as const) {
      const lines = formatGoalNotification(goal, notification, language, 'customer-export', destination).split('\n');
      expect(lines[2]).toBe(destination === 'tui' || length === 600 ? body : 'e\u0301'.repeat(599) + '…');
    }
    expect(goal).toEqual(saved);
    expect(goal.notifications![0]!.body).toBe(body);
  });

  it('removes trailing whitespace only from a shortened prefix', () => {
    const prefix = 'e\u0301'.repeat(597) + '  ';
    const text = formatGoalNotification(goalRecord(), { kind: 'custom', body: prefix + 'XY' }, language, 'customer-export');
    expect(text.split('\n')[2]).toBe('e\u0301'.repeat(597) + '…');
  });

  it.each([
    { kind: 'blocked' as const, length: 599 }, { kind: 'blocked' as const, length: 600 },
    { kind: 'custom' as const, length: 599 }, { kind: 'custom' as const, length: 600 },
  ])('preserves the complete $length-grapheme $kind body with its reason and unlabeled action', ({ kind, length }) => {
    const reason = language === 'ja' ? '検証環境の認証に失敗しました。' : 'Authentication to the test environment failed.';
    const action = language === 'ja' ? '検証用の認証情報を更新してください。' : 'Update the test credentials.';
    const body = `${reason}\n${'e\u0301'.repeat(length - reason.length - action.length - 4)}\n${action}  `;
    const text = formatGoalNotification(goalRecord(), { kind, body }, language, 'customer-export');

    expect(text.split('\n').slice(2, 5).join('\n')).toBe(body);
    expect(text.split('\n').slice(5).join('\n')).not.toMatch(language === 'ja' ? /全文|出来事/u : /full message|events/iu);
  });

  it.each(['blocked', 'custom'] as const)('shortens only the tail of a long %s body and points to the full TUI event', (kind) => {
    const reason = language === 'ja' ? '認証に失敗しました。' : 'Authentication failed.';
    const action = language === 'ja' ? '検証用の認証情報を更新してください。' : 'Update test credentials.';
    const body = `${reason}\n${'x'.repeat(620)}\n${action}`;
    const notification = { kind, body };
    const goal = goalRecord();
    const before = structuredClone({ goal, notification });
    const text = formatGoalNotification(goal, notification, language, 'customer-export');
    const visibleBody = text.split('\n').slice(2, 4).join('\n');
    const guidance = text.split('\n').slice(4).join('\n');

    expect(visibleBody).toBe(`${reason}\n${'x'.repeat(599 - reason.length - 1)}…`);
    expect(guidance).toMatch(language === 'ja' ? /全文/u : /full message/iu);
    expect(guidance).toMatch(language === 'ja' ? /出来事/u : /events/iu);
    expect(guidance).toContain('TUI');
    expect(guidance).toContain('takt manager');
    expect(guidance).toContain('customer-export');
    const guidanceLines = guidance.split('\n');
    expect(guidanceLines).toHaveLength(kind === 'blocked' ? 2 : 1);
    if (kind === 'blocked') {
      expect(guidanceLines[1]).toBe(getLabel('manager.notificationBlockedAction', language, { project: 'customer-export' }));
    }
    expect({ goal, notification }).toEqual(before);
  });

  it.each(['blocked', 'custom'] as const)('keeps combining characters intact when a %s body exceeds the limit by one grapheme', (kind) => {
    const body = 'e\u0301'.repeat(599) + 'XY';
    const text = formatGoalNotification(goalRecord(), { kind, body }, language, 'customer-export');

    expect(text.split('\n')[2]).toBe('e\u0301'.repeat(599) + '…');
    expect(text.split('\n').slice(3).join('\n')).toMatch(language === 'ja' ? /全文.*出来事/u : /full message.*events/iu);
  });

  it.each([
    { kind: 'blocked' as const, length: 600 }, { kind: 'custom' as const, length: 600 },
    { kind: 'blocked' as const, length: 601 }, { kind: 'custom' as const, length: 601 },
  ])('keeps the $length-grapheme $kind body complete only in TUI when it exceeds the Slack bound', ({ kind, length }) => {
    const body = 'e\u0301'.repeat(599) + (length === 600 ? 'X' : 'XY');
    const goal = goalRecord();
    const slack = formatGoalNotification(goal, { kind, body }, language, 'customer-export', 'slack').split('\n');
    const tui = formatGoalNotification(goal, { kind, body }, language, 'customer-export', 'tui').split('\n');
    expect(slack[2]).toBe(length === 600 ? body : 'e\u0301'.repeat(599) + '…');
    expect(tui[2]).toBe(body);
  });

  it.each(['blocked', 'custom'] as const)('preserves the complete long %s body for TUI events', (kind) => {
    const body = `認証に失敗しました。\n${'e\u0301'.repeat(620)}\nUpdate test credentials.  `;
    const notification = { kind, body };
    const goal = goalRecord();
    const before = structuredClone({ goal, notification });
    const text = formatGoalNotification(goal, notification, language, 'customer-export', 'tui');

    expect(text.split('\n').slice(2, 5).join('\n')).toBe(body);
    expect({ goal, notification }).toEqual(before);
  });

  it.each([{ worktrees: [] }, { worktrees: ["/human's tree"] }])('retains the reviewed merge commands and execution location with worktrees $worktrees', ({ worktrees }) => {
    const goalSha = 'a'.repeat(40);
    const git = worktrees.length === 0 ? 'git' : "git -C '/human'\\''s tree'";
    const commands = [
      `${git} status --short`, ...(worktrees.length === 0 ? ["git switch 'release'"] : []),
      `${git} merge --no-ff --no-edit '${goalSha}'`,
    ];
    const goal: Goal = { ...goalRecord(), status: 'awaiting_merge', completion: {
      goalBranch: goalRecord().branch, goalSha, targetBranch: 'release', summary: 'Ready for integration',
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
      ...(worktrees.length === 0 ? {} : { worktrees }),
      instructions: [...(worktrees.length === 0 ? ['Run in a clean worktree of this repository where switching branches is possible.'] : []), ...commands],
    } };
    const text = formatGoalNotification(goal, { kind: 'awaiting_merge', body: 'Verified result. '.repeat(1000) }, language, 'customer-export');

    expect(text).toContain('release');
    for (const command of commands) expect(text.split('\n').map((line) => line.trim())).toContain(command);
    expect(text).toMatch(language === 'ja' ? /実行|作業ツリー|リポジトリ/u : /run|worktree|repository/iu);
    if (language === 'ja') expect(text).not.toContain('Run in a clean worktree');
    expect(text.length).toBeLessThan(2000);
  });

  it('retains merge commands longer than the body limit in their saved order', () => {
    const directory = `/work/${'customer-project/'.repeat(60)}reviewed tree`;
    const goalSha = 'a'.repeat(40);
    const commands = [
      `git -C '${directory}' status --short`,
      `git -C '${directory}' merge --no-ff --no-edit '${goalSha}'`,
    ];
    const summary = 'Acceptance checks passed. '.repeat(100);
    const goal: Goal = { ...goalRecord(), status: 'awaiting_merge', completion: {
      goalBranch: goalRecord().branch, goalSha, targetBranch: 'release', summary,
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
      worktrees: [directory], instructions: commands,
    } };
    const before = structuredClone(goal);

    const lines = formatGoalNotification(goal, { kind: 'awaiting_merge', body: summary }, language, 'customer-export').split('\n');

    expect(lines[2]).toContain('Acceptance checks passed.');
    expect(lines[2]).toMatch(/…$/u);
    expect(lines[2]!.length).toBeLessThan(summary.length);
    expect(lines.slice(-commands.length)).toEqual(commands);
    expect(goal).toEqual(before);
  });

  it.each([false, true])('renders old and new merge notices from completion without duplicating commands (worktree=%s)', (withWorktree) => {
    const goalSha = 'a'.repeat(40);
    const directory = '/human/review';
    const git = withWorktree ? `git -C '${directory}'` : 'git';
    const commands = [`${git} status --short`, ...(withWorktree ? [] : ["git switch 'release'"]),
      `${git} merge --no-ff --no-edit '${goalSha}'`];
    const summary = 'Acceptance checks passed';
    const instructions = [...(withWorktree ? [] : ['Run in a clean worktree of this repository where switching branches is possible.']), ...commands];
    const completion = { goalBranch: goalRecord().branch, goalSha, targetBranch: 'release', summary,
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
      ...(withWorktree ? { worktrees: [directory] } : {}), instructions };
    const goal: Goal = { ...goalRecord(), status: 'awaiting_merge', completion };
    const oldBody = `${summary}\n${completion.targetBranch}: ${goalSha}\n${instructions.join('\n')}`;
    expect(oldBody.length).toBeLessThan(600);
    const before = structuredClone(goal);
    for (const destination of ['slack', 'tui'] as const) {
      const current = formatGoalNotification(goal, { kind: 'awaiting_merge', body: summary }, language, 'customer-export', destination);
      const old = formatGoalNotification(goal, { kind: 'awaiting_merge', body: oldBody }, language, 'customer-export', destination);
      expect(old).toBe(current);
      const lines = old.split('\n');
      expect(lines[2]).toBe(summary);
      expect(lines.filter((line) => line.startsWith('git'))).toEqual(commands);
      expect(lines.filter((line) => line.includes('release') && !line.startsWith('git'))).toHaveLength(1);
      expect(lines[4]).toContain(withWorktree ? directory : 'customer-export');
      const custom = formatGoalNotification(goal, { kind: 'custom', body: oldBody }, language, 'customer-export', destination);
      if (destination === 'slack') expect(custom.split('\n').slice(2).join('\n')).toBe(oldBody);
      else {
        expect(custom.split('\n').slice(2, 5)).toEqual(oldBody.split('\n').slice(0, 3));
        expect(custom.split('\n')[5]).toMatch(/Ctrl\+N|\^N/u);
      }
      const withoutCompletion = formatGoalNotification(goalRecord(), { kind: 'awaiting_merge', body: oldBody }, language, 'customer-export', destination);
      if (destination === 'slack') expect(withoutCompletion.split('\n').slice(2).join('\n')).toBe(oldBody);
      else {
        expect(withoutCompletion.split('\n').slice(2, 5)).toEqual(oldBody.split('\n').slice(0, 3));
        expect(withoutCompletion.split('\n')[5]).toMatch(/Ctrl\+N|\^N/u);
      }
    }
    expect(goal).toEqual(before);
  });

  const question: GoalQuestion = {
    id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human', status: 'pending',
    body: '出力形式はどれですか', options: ['CSV', 'JSON'], recommendation: 'CSV',
  };

  it.each([false, true])('preserves question boundaries for both destinations (exceeds=%s)', (exceeds) => {
    const extra = exceeds ? 1 : 0;
    const savedQuestion: GoalQuestion = { ...question, body: 'e\u0301'.repeat(300 + extra),
      recommendation: 'e\u0301'.repeat(200 + extra),
      options: ['e\u0301'.repeat(60 + extra), 'JSON', 'TSV', 'XML', 'YAML'],
    };
    const body = formatGoalQuestionNotification(savedQuestion, language);
    const optionPrefix = language === 'ja' ? '選択肢: ' : 'Options: ';
    const recommendationPrefix = language === 'ja' ? '推奨: ' : 'Recommendation: ';
    for (const destination of ['slack', 'tui'] as const) {
      const lines = formatGoalNotification({ ...goalRecord(), questions: [savedQuestion] }, { kind: 'question', body }, language, 'customer-export', destination).split('\n');
      expect(lines[2]).toBe(exceeds ? 'e\u0301'.repeat(299) + '…' : savedQuestion.body);
      expect(lines[4]).toBe(recommendationPrefix + (exceeds ? 'e\u0301'.repeat(199) + '…' : savedQuestion.recommendation));
      const options = destination === 'slack' && exceeds
        ? ['e\u0301'.repeat(59) + '…', ...savedQuestion.options!.slice(1)] : savedQuestion.options!;
      expect(lines[3]).toBe(optionPrefix + options.join(', '));
      expectAnswerSelectionGuidance(lines[5]!, savedQuestion.id);
    }
  });

  it.each(['pending', 'answered', 'withdrawn'] as const)('keeps all TUI options and bounds only Slack options for a %s question', (status) => {
    const options = ['CSV', 'JSON', 'TSV', 'XML', 'YAML', `Parquet ${'e\u0301'.repeat(400)}`];
    const savedQuestion: GoalQuestion = { ...question, status, options,
      body: 'e\u0301'.repeat(301), recommendation: 'e\u0301'.repeat(201),
      ...(status === 'answered' ? { answer: { text: 'CSV', source: 'tui' as const, answeredAt: '2026-10-12T00:00:00Z' } } : {}),
    };
    const goal = { ...goalRecord(), questions: [savedQuestion] };
    const body = formatGoalQuestionNotification(savedQuestion, language);
    const notification = { kind: 'question' as const, body };
    const optionPrefix = language === 'ja' ? '選択肢: ' : 'Options: ';
    const recommendationPrefix = language === 'ja' ? '推奨: ' : 'Recommendation: ';
    expect(body).toContain(options.join(', '));
    expect(body).toContain(savedQuestion.body);
    expect(body).toContain(recommendationPrefix + savedQuestion.recommendation);
    for (const destination of ['slack', 'tui'] as const) {
      const lines = formatGoalNotification(goal, notification, language, 'customer-export', destination).split('\n');
      expect(lines[2]).toBe('e\u0301'.repeat(299) + '…');
      expect(lines).toContain(recommendationPrefix + 'e\u0301'.repeat(199) + '…');
      expect(lines.filter((line) => answerMenuKey.test(line))).toHaveLength(status === 'pending' ? 1 : 0);
      if (status === 'pending') {
        expectAnswerSelectionGuidance(lines.at(-1)!, question.id);
      }
      if (destination === 'tui') {
        expect(lines[3]).toBe(optionPrefix + options.join(', '));
        expect(lines.filter((line) => /ほかに|Additional options/iu.test(line))).toEqual([]);
      } else {
        expect(lines[3]).toBe(optionPrefix + options.slice(0, 5).join(', '));
        expect(lines[4]).toBe(language === 'ja'
          ? 'ほかに1件の選択肢があります。すべての選択肢はTUIで確認できます。'
          : 'Additional options: 1. View all options in the TUI.');
        expect(lines[4]).toContain('TUI');
      }
    }
    const fiveOptions = { ...savedQuestion, options: options.slice(0, 5) };
    const fiveLines = formatGoalNotification({ ...goal, questions: [fiveOptions] }, notification, language, 'customer-export').split('\n');
    expect(fiveLines[3]).toBe(optionPrefix + fiveOptions.options.join(', '));
    expect(fiveLines.filter((line) => /ほかに|Additional options/iu.test(line))).toEqual([]);
    expect(goal.questions).toEqual([savedQuestion]);
  });

  it.each([5, 6, 7])('shows the exact Slack remainder for %s options while keeping all saved and TUI options', (count) => {
    const options = ['CSV', 'JSON', 'TSV', 'XML', 'YAML', 'Parquet', 'Avro'].slice(0, count);
    const savedQuestion: GoalQuestion = { ...question, options };
    const goal = { ...goalRecord(), questions: [savedQuestion] };
    const body = formatGoalQuestionNotification(savedQuestion, language);
    const notification = { kind: 'question' as const, body };
    const optionPrefix = language === 'ja' ? '選択肢: ' : 'Options: ';
    const remainderPattern = /ほかに|Additional options/iu;
    const slackLines = formatGoalNotification(goal, notification, language, 'customer-export', 'slack').split('\n');
    const tuiLines = formatGoalNotification(goal, notification, language, 'customer-export', 'tui').split('\n');

    expect(slackLines[3]).toBe(optionPrefix + options.slice(0, 5).join(', '));
    expect(slackLines.filter((line) => remainderPattern.test(line))).toEqual(count === 5 ? [] : [language === 'ja'
      ? `ほかに${count - 5}件の選択肢があります。すべての選択肢はTUIで確認できます。`
      : `Additional options: ${count - 5}. View all options in the TUI.`]);
    expect(tuiLines[3]).toBe(optionPrefix + options.join(', '));
    expect(tuiLines.filter((line) => remainderPattern.test(line))).toEqual([]);
    expect(body.split('\n')).toContain(optionPrefix + options.join(', '));
    expect(body.split('\n').filter((line) => remainderPattern.test(line))).toEqual([]);
  });

  it('shows saved question details and a usable TUI inquiry menu key', () => {
    const goal = { ...goalRecord(), questions: [question] };
    const body = formatGoalQuestionNotification(question, language);
    const text = formatGoalNotification(goal, { kind: 'question', body }, language, 'customer-export');

    expect(body.startsWith(`${question.id}: `)).toBe(true);
    expect(text).toContain(question.body);
    expect(text).toMatch(language === 'ja' ? /選択肢:\s*CSV.*JSON/u : /Options:\s*CSV.*JSON/u);
    expect(text).toMatch(language === 'ja' ? /推奨:\s*CSV/u : /Recommendation:\s*CSV/u);
    expectAnswerSelectionGuidance(text, question.id);
    expect(text).toContain('takt manager');
    expect(text).toContain('TUI');
    expect(text).toContain('customer-export');
    if (language === 'ja') expect(text).not.toMatch(/TAKT Goal|Options:|Recommendation:/u);
  });

  it.each(['pending', 'answered', 'withdrawn'] as const)('preserves saved question details and shows answer guidance only while pending (status=%s)', (status) => {
    const savedQuestion: GoalQuestion = { ...question, status,
      ...(status === 'answered' ? { answer: { text: 'CSV', source: 'tui' as const, answeredAt: '2026-10-12T00:00:00Z' } } : {}),
    };
    const goal = { ...goalRecord(), questions: [savedQuestion] };
    const notification = { kind: 'question' as const, body: formatGoalQuestionNotification(question, language === 'ja' ? 'en' : 'ja') };
    const text = formatGoalNotification(goal, notification, language, 'customer-export');
    const lines = text.split('\n');

    expect(lines).toContain(question.body);
    expect(lines).toContain(language === 'ja' ? '選択肢: CSV, JSON' : 'Options: CSV, JSON');
    expect(lines).toContain(language === 'ja' ? '推奨: CSV' : 'Recommendation: CSV');
    const guidance = lines.filter((line) => answerMenuKey.test(line));
    if (status === 'pending') {
      expect(guidance).toHaveLength(1);
      expectAnswerSelectionGuidance(text, question.id);
    } else {
      expect(guidance).toEqual([]);
    }
    expect(lines.some((line) => line.startsWith(`${question.id}: `))).toBe(false);
    expect(goal.questions).toEqual([savedQuestion]);
  });

  it.each([
    { kind: 'question' as const, body: `関連質問 ${question.id}: 本文中のID` },
    { kind: 'question' as const, body: `> ${question.id}: 引用` },
    { kind: 'custom' as const, body: `${question.id}: 一般通知` },
  ])('does not infer saved question details from an ID in $kind text', (notification) => {
    const text = formatGoalNotification({ ...goalRecord(), questions: [question] }, notification, language, 'customer-export');
    const lines = text.split('\n');
    expect(lines).toContain(notification.body);
    expect(lines.filter((line) => answerMenuKey.test(line))).toEqual([]);
    expect(lines.filter((line) => /選択肢:|Options:|推奨:|Recommendation:/u.test(line))).toEqual([]);
  });

  it('shortens question details while retaining the complete inquiry menu key', () => {
    const savedQuestion: GoalQuestion = { ...question, body: 'Which output format? '.repeat(1000),
      options: ['CSV '.repeat(1000), 'JSON '.repeat(1000)], recommendation: 'CSV is preferred. '.repeat(1000) };
    const body = formatGoalQuestionNotification(savedQuestion, language);
    const text = formatGoalNotification({ ...goalRecord(), questions: [savedQuestion] }, { kind: 'question', body }, language, 'customer-export');

    expect(text).toContain('Which output format?');
    expect(text).toContain('CSV');
    expect(text).toContain('JSON');
    expect(text).toContain('CSV is preferred.');
    expectAnswerSelectionGuidance(text, savedQuestion.id);
    expect(text.length).toBeLessThan(2000);
    expect(savedQuestion.body).toHaveLength('Which output format? '.length * 1000);
  });

  it('bounds a large options list and directs readers to all options in the TUI', () => {
    const savedQuestion = { ...question, options: Array.from({ length: 100 }, (_, index) => `Format ${index} `.repeat(100)) };
    const body = formatGoalQuestionNotification(savedQuestion, language);
    const text = formatGoalNotification({ ...goalRecord(), questions: [savedQuestion] }, { kind: 'question', body }, language, 'customer-export');
    expect(text).toContain('Format 0');
    expect(text).toContain('Format 4');
    expect(text).toContain('95');
    expect(text).toContain('TUI');
    expectAnswerSelectionGuidance(text, savedQuestion.id);
    expect(text.length).toBeLessThan(2000);
    expect(savedQuestion.options).toHaveLength(100);
    expect(body).toContain('Format 99');
  });
});
