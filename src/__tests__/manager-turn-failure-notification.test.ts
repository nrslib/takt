import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({
  update: vi.fn(), options: vi.fn(), language: vi.fn(), label: vi.fn(), send: vi.fn(), failure: vi.fn(),
}));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { update = doubles.update; } }));
vi.mock('../infra/config/resolveConfigValue.js', () => ({ resolveConfigValue: doubles.language }));
vi.mock('../shared/i18n/index.js', () => ({ getLabel: doubles.label }));
vi.mock('../infra/task/manager-run-state.js', () => ({ recordManagerRunFailure: doubles.failure }));
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
    expect(doubles.failure.mock.calls[0]![1]).toMatchObject({ message: 'save failed token=[REDACTED]' });
    await notifyManagerTurnFailure('/project', goal.id, new Error('capacity exhausted'));
    expect(goal.notifications).toHaveLength(1);
  });

});
