import { beforeEach, expect, it, vi } from 'vitest';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { GoalQuestion } from '../infra/goals/schema.js';
import { formatGoalQuestionNotification } from '../infra/goals/notifications.js';
const doubles = vi.hoisted(() => ({ config: vi.fn(), language: vi.fn(), webhook: vi.fn(), send: vi.fn() }));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: doubles.config }));
vi.mock('../infra/config/resolveConfigValue.js', async (original) => ({
  ...await original<typeof import('../infra/config/resolveConfigValue.js')>(), resolveConfigValue: doubles.language,
}));
vi.mock('../shared/utils/slackWebhook.js', () => ({ getSlackWebhookUrl: doubles.webhook, sendSlackNotification: doubles.send }));
import { resolveManagerNotificationOptions, sendSavedGoalNotifications } from '../features/manager/notifications.js';
const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
beforeEach(() => {
  vi.resetAllMocks();
  doubles.config.mockReturnValue({ notifications: policy, mainMerge: 'approve' });
  doubles.webhook.mockReturnValue('https://example.test/secret');
  doubles.language.mockReturnValue('ja');
});
const notice = { id: '650e8400-e29b-41d4-a716-446655440001', kind: 'custom' as const, body: 'saved notice', recordedAt: '2026-10-08T00:00:00Z' };

it('resolves notification switches and webhook once at the operation boundary', () => {
  expect(resolveManagerNotificationOptions('/project')).toEqual({ policy, mainMerge: 'approve', webhookUrl: 'https://example.test/secret' });
  expect(doubles.config).toHaveBeenCalledExactlyOnceWith('/project');
  expect(doubles.webhook).toHaveBeenCalledOnce();
});
it('awaits delivery of newly saved notifications without resending existing ones', async () => {
  const previous = { ...goalRecord(), notifications: [notice] };
  const current = { ...previous, notifications: [notice, { ...notice, id: '650e8400-e29b-41d4-a716-446655440002' }] };
  await sendSavedGoalNotifications('/project', previous, current, 'https://example.test/secret');
  expect(doubles.send).toHaveBeenCalledExactlyOnceWith('https://example.test/secret', expect.stringContaining('saved notice'));
  expect(doubles.config).not.toHaveBeenCalled();
  expect(doubles.webhook).not.toHaveBeenCalled();
});
it('skips Slack delivery with no webhook while retaining saved notifications', async () => {
  await sendSavedGoalNotifications('/project', goalRecord(), { ...goalRecord(), notifications: [notice] }, undefined);
  expect(doubles.send).not.toHaveBeenCalled();
});

it.each(['ja', 'en'] as const)('delivers %s text with the repository or workspace name resolved from cwd', async (language) => {
  doubles.language.mockReturnValue(language);
  const current = { ...goalRecord(), notifications: [notice] };
  const before = structuredClone(current);
  await sendSavedGoalNotifications('/work/customer-workspace', goalRecord(), current, 'https://example.test/secret');
  expect(doubles.send).toHaveBeenCalledOnce();
  const [url, text] = doubles.send.mock.calls[0]! as [string, string];
  expect(url).toBe('https://example.test/secret');
  const lines = text.split('\n');
  expect(lines[0]).toContain('customer-workspace');
  expect(lines[0]).toMatch(language === 'ja' ? /お知らせ|通知/u : /notification|update/iu);
  expect(lines[1]).toContain(current.id.slice(0, 8));
  expect(lines[1]).not.toContain(current.id);
  expect(lines).toContain(notice.body);
  expect(current).toEqual(before);
});

it('delivers the saved human question with localized details and its ID-free answer guidance', async () => {
  const question = { id: '650e8400-e29b-41d4-a716-446655440003', body: '出力形式はどれですか',
    options: ['CSV', 'JSON'], recommendation: 'CSV', recipient: 'human' as const, status: 'pending' as const };
  const current = { ...goalRecord(), questions: [question], notifications: [{ ...notice,
    kind: 'question' as const, body: `${question.id}: ${question.body}\nOptions: CSV, JSON\nRecommendation: CSV` }] };
  await sendSavedGoalNotifications('/work/customer-export', goalRecord(), current, 'https://example.test/secret');
  expect(doubles.send).toHaveBeenCalledOnce();
  const text = doubles.send.mock.calls[0]![1] as string;
  expect(text.split('\n')[0]).toContain('customer-export');
  expect(text).toContain(question.body);
  expect(text).toMatch(/選択肢:\s*CSV.*JSON/u);
  expect(text).toMatch(/推奨:\s*CSV/u);
  const guidance = text.split('\n').filter((line) => /Ctrl\+R|\^R/u.test(line));
  expect(guidance).toHaveLength(1);
  expect(guidance[0]).toMatch(/Ctrl\+R|\^R/u);
  expect(guidance[0]).not.toContain(question.id);
  expect(guidance[0]).toMatch(/一覧|選択/u);
  expect(text).toContain('takt manager');
  expect(text).toContain('TUI');
  expect(text).not.toMatch(/Options:|Recommendation:/u);
});

it.each([
  { language: 'ja' as const, status: 'pending' as const }, { language: 'en' as const, status: 'pending' as const },
  { language: 'ja' as const, status: 'answered' as const }, { language: 'en' as const, status: 'answered' as const },
  { language: 'ja' as const, status: 'withdrawn' as const }, { language: 'en' as const, status: 'withdrawn' as const },
])('delivers only five options for a $status question in $language and guides only pending answers', async ({ language, status }) => {
  doubles.language.mockReturnValue(language);
  const question: GoalQuestion = { id: '650e8400-e29b-41d4-a716-446655440003', body: 'Which output format?',
    options: ['CSV', 'JSON', 'TSV', 'XML', 'YAML', 'Parquet'], recipient: 'human', status,
    ...(status === 'answered' ? { answer: { text: 'CSV', source: 'tui' as const, answeredAt: '2026-10-08T00:00:00Z' } } : {}),
  };
  const current = { ...goalRecord(), questions: [question], notifications: [{ ...notice,
    kind: 'question' as const, body: formatGoalQuestionNotification(question, language) }] };
  const before = structuredClone(current);
  await sendSavedGoalNotifications('/work/customer-export', goalRecord(), current, 'https://example.test/secret');
  expect(doubles.send).toHaveBeenCalledOnce();
  const lines = (doubles.send.mock.calls[0]![1] as string).split('\n');
  expect(lines[3]).toBe((language === 'ja' ? '選択肢: ' : 'Options: ') + question.options!.slice(0, 5).join(', '));
  expect(lines[4]).toBe(language === 'ja'
    ? 'ほかに1件の選択肢があります。すべての選択肢はTUIで確認できます。'
    : 'Additional options: 1. View all options in the TUI.');
  expect(lines[4]).toContain('TUI');
  const guidance = lines.filter((line) => /Ctrl\+R|\^R/u.test(line));
  expect(guidance).toHaveLength(status === 'pending' ? 1 : 0);
  if (status === 'pending') {
    expect(guidance[0]).toMatch(/Ctrl\+R|\^R/u);
    expect(guidance[0]).not.toContain(question.id);
    expect(guidance[0]).toMatch(language === 'ja' ? /一覧|選択/u : /list|select|choose/iu);
  }
  expect(current).toEqual(before);
});

it.each([
  { language: 'ja' as const, kind: 'blocked' as const }, { language: 'en' as const, kind: 'blocked' as const },
  { language: 'ja' as const, kind: 'custom' as const }, { language: 'en' as const, kind: 'custom' as const },
])('delivers a shortened $kind body with $language guidance while keeping the saved body complete', async ({ language, kind }) => {
  doubles.language.mockReturnValue(language);
  const reason = language === 'ja' ? '認証に失敗しました。' : 'Authentication failed.';
  const action = language === 'ja' ? '検証用の認証情報を更新してください。' : 'Update test credentials.';
  const body = `${reason}\n${'x'.repeat(620)}\n${action}`;
  const current = { ...goalRecord(), notifications: [{ ...notice, kind, body }] };
  const before = structuredClone(current);

  await sendSavedGoalNotifications('/work/customer-export', goalRecord(), current, 'https://example.test/secret');

  expect(doubles.send).toHaveBeenCalledOnce();
  const [url, text] = doubles.send.mock.calls[0]! as [string, string];
  expect(url).toBe('https://example.test/secret');
  expect(current).toEqual(before);
  const lines = text.split('\n');
  expect(lines[0]).toContain('customer-export');
  expect(lines.slice(2, 4).join('\n')).toBe(`${reason}\n${'x'.repeat(599 - reason.length - 1)}…`);
  const guidance = lines.slice(4).join('\n');
  expect(guidance).toMatch(language === 'ja' ? /全文/u : /full message/iu);
  expect(guidance).toMatch(language === 'ja' ? /出来事/u : /events/iu);
  expect(guidance).toContain('TUI');
  expect(guidance).toContain('takt manager');
  expect(guidance).toContain('customer-export');
});
