import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({
  update: vi.fn(), options: vi.fn(), language: vi.fn(), label: vi.fn(), send: vi.fn(), slack: vi.fn(), log: vi.fn(),
}));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { update = doubles.update; } }));
vi.mock('../infra/config/resolveConfigValue.js', () => ({ resolveConfigValue: doubles.language }));
vi.mock('../shared/i18n/index.js', () => ({ getLabel: doubles.label }));
vi.mock('../shared/utils/debug.js', () => ({ createLogger: () => ({ error: doubles.log }) }));
vi.mock('../shared/utils/slackWebhook.js', () => ({ sendSlackNotification: doubles.slack }));
vi.mock('../features/manager/notifications.js', () => ({
  resolveManagerNotificationOptions: doubles.options, sendSavedGoalNotifications: doubles.send,
}));
import { notifyManagerTurnFailure } from '../features/manager/turnFailureNotification.js';

let goal: Goal;
const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
beforeEach(() => {
  vi.resetAllMocks();
  goal = goalRecord();
  doubles.options.mockReturnValue({ policy, webhookUrl: 'https://example.test/notify', mainMerge: 'approve' });
  doubles.language.mockReturnValue('en');
  doubles.label.mockImplementation((_key: string, _language: string, vars: { goalId: string; reason: string }) =>
    `Goal ${vars.goalId}: ${vars.reason}`);
  doubles.update.mockImplementation(async (_id: string, transform: (current: Goal) => Goal) => {
    goal = transform(goal);
    return goal;
  });
});

describe('notifyManagerTurnFailure', () => {
  it.each(['ja', 'en'] as const)('saves the real %s recovery guidance for the goal menu', async (language) => {
    const { getLabel } = await vi.importActual<typeof import('../shared/i18n/index.js')>('../shared/i18n/index.js');
    doubles.label.mockImplementation(getLabel);
    doubles.language.mockReturnValue(language);

    await notifyManagerTurnFailure('/project', goal.id, new Error('capacity exhausted'));

    const lines = goal.notifications![0]!.body.split('\n');
    const guidance = lines.filter((line) => /Ctrl\+G|\^G/u.test(line));
    expect(guidance).toHaveLength(1);
    expect(guidance[0]).toMatch(language === 'ja' ? /再開/u : /resume/iu);
    expect(guidance[0]).toContain('TUI');
    for (const line of lines) expect(line).not.toMatch(/\/(?:resume|pause|abort)\b/u);
    expect(lines.join('\n')).toContain('capacity exhausted');
    expect(doubles.send).toHaveBeenCalledOnce();
  });

  it('saves a sanitized blocked notification before awaiting delivery', async () => {
    const previous = goal;
    let finishDelivery!: () => void;
    doubles.send.mockImplementation(() => new Promise<void>((resolve) => { finishDelivery = resolve; }));
    const notification = notifyManagerTurnFailure('/project', goal.id, new Error('capacity exhausted api_key=fixture-secret'));
    await vi.waitFor(() => expect(doubles.send).toHaveBeenCalledOnce());
    expect(goal.notifications).toEqual([expect.objectContaining({
      kind: 'blocked', severity: 'error', body: `Goal ${goal.id}: capacity exhausted api_key=[REDACTED]`,
    })]);
    expect(doubles.send).toHaveBeenCalledWith('/project', previous, goal, 'https://example.test/notify');
    expect(doubles.language).toHaveBeenCalledExactlyOnceWith('/project', 'language');
    expect(doubles.label).toHaveBeenCalledWith('manager.turnFailureNotification', 'en', {
      goalId: goal.id, reason: 'capacity exhausted api_key=[REDACTED]',
    });
    let settled = false;
    void notification.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishDelivery();
    await notification;
  });

  it('notifies each failed attempt even when its sanitized reason is repeated', async () => {
    await notifyManagerTurnFailure('/project', goal.id, new Error('capacity exhausted api_key=fixture-secret-a'));
    await notifyManagerTurnFailure('/project', goal.id, new Error('capacity exhausted api_key=fixture-secret-b'));
    expect(goal.notifications).toHaveLength(2);
    expect(doubles.send).toHaveBeenCalledTimes(2);
    expect(goal.notifications![0]!.body).toBe(goal.notifications![1]!.body);
  });

  it('does not save or send when blocked notifications are disabled', async () => {
    doubles.options.mockReturnValue({ policy: { ...policy, blocked: false } });
    await notifyManagerTurnFailure('/project', goal.id, new Error('capacity exhausted'));
    expect(doubles.update).not.toHaveBeenCalled();
    expect(doubles.send).not.toHaveBeenCalled();
    expect(goal.notifications).toBeUndefined();
  });

  it('reports a failed notification save and notifies the next failure', async () => {
    doubles.update.mockRejectedValueOnce(new Error('save failed token=fixture-secret'));
    await expect(notifyManagerTurnFailure('/project', goal.id, new Error('capacity exhausted'))).resolves.toBeUndefined();
    expect(goal.notifications).toBeUndefined();
    expect(doubles.send).not.toHaveBeenCalled();
    expect(doubles.log).toHaveBeenCalledWith(expect.any(String), { goalId: goal.id, error: 'save failed token=[REDACTED]' });
    await notifyManagerTurnFailure('/project', goal.id, new Error('capacity exhausted'));
    expect(goal.notifications).toHaveLength(1);
  });

});

it('delivers a conversation failure without creating goal state, including repeated attempts', async () => {
  doubles.label.mockImplementation((key: string, _language: string, vars: { reason?: string }) =>
    key === 'manager.notificationHeadings.blocked' ? 'blocked' : `Failure: ${vars.reason}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const message = await notifyManagerTurnFailure('/project', undefined, new Error('provider failed token=fixture-secret'));
    expect(message).toBe('blocked\nFailure: provider failed token=[REDACTED]');
  }
  expect(doubles.update).not.toHaveBeenCalled();
  expect(doubles.send).not.toHaveBeenCalled();
  expect(doubles.slack).toHaveBeenCalledTimes(2);
  expect(doubles.slack).toHaveBeenLastCalledWith('https://example.test/notify', 'blocked\nFailure: provider failed token=[REDACTED]');
});

it('does not display or send a conversation notification when blocked is disabled', async () => {
  doubles.options.mockReturnValue({ policy: { ...policy, blocked: false } });
  expect(await notifyManagerTurnFailure('/project', undefined, new Error('provider failed'))).toBeUndefined();
  expect(doubles.update).not.toHaveBeenCalled();
  expect(doubles.slack).not.toHaveBeenCalled();
});

it.each([undefined, ''])('returns the conversation notice when Slack is not configured (%s)', async (webhookUrl) => {
  doubles.options.mockReturnValue({ policy, webhookUrl });
  doubles.label.mockImplementation((key: string) => key);
  expect(await notifyManagerTurnFailure('/project', undefined, new Error('provider failed'))).toContain('manager.conversationFailureNotification');
  expect(doubles.update).not.toHaveBeenCalled();
  expect(doubles.slack).not.toHaveBeenCalled();
});
