import { beforeEach, expect, it, vi } from 'vitest';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ config: vi.fn(), webhook: vi.fn(), send: vi.fn(), failure: vi.fn() }));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: doubles.config }));
vi.mock('../shared/utils/slackWebhook.js', () => ({ getSlackWebhookUrl: doubles.webhook, sendSlackNotification: doubles.send }));
vi.mock('../infra/task/manager-run-state.js', () => ({ recordManagerRunFailure: doubles.failure }));
import { resolveManagerNotificationOptions, sendSavedGoalNotifications } from '../features/manager/notifications.js';
const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
beforeEach(() => {
  vi.resetAllMocks();
  doubles.config.mockReturnValue({ notifications: policy, mainMerge: 'approve' });
  doubles.webhook.mockReturnValue('https://example.test/secret');
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
  expect(doubles.send).toHaveBeenCalledExactlyOnceWith('https://example.test/secret', expect.stringContaining('saved notice'), expect.any(Function));
  expect(doubles.config).not.toHaveBeenCalled();
  expect(doubles.webhook).not.toHaveBeenCalled();
});
it('keeps the saved state and records a delivery diagnostic without including the webhook', async () => {
  doubles.send.mockImplementation(async (_url: string, _text: string, failed: (message: string) => void) => failed('Slack webhook failed: HTTP 503'));
  const current = { ...goalRecord(), notifications: [notice] };
  await expect(sendSavedGoalNotifications('/project', goalRecord(), current, 'https://example.test/secret')).resolves.toBeUndefined();
  expect(doubles.failure).toHaveBeenCalledExactlyOnceWith('/project', expect.any(Error));
  expect((doubles.failure.mock.calls[0]![1] as Error).message).toContain('503');
  expect((doubles.failure.mock.calls[0]![1] as Error).message).not.toContain('https://example.test/secret');
  expect(current.notifications).toEqual([notice]);
});
it('skips Slack delivery with no webhook while retaining saved notifications', async () => {
  await sendSavedGoalNotifications('/project', goalRecord(), { ...goalRecord(), notifications: [notice] }, undefined);
  expect(doubles.send).not.toHaveBeenCalled();
});
