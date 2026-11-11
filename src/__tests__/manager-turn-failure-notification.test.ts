import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import stringWidth from 'string-width';
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
import { conversationErrorResult } from '../features/manager/conversationErrors.js';

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
  describe.each(['conversation', 'goal'] as const)('%s failure reason normalization', (destination) => {
    it.each([
      { name: 'ANSI-obfuscated sensitive key', raw: 'failed api_\u001b[31mtoken\u001b[0m=fixture-secret', expected: 'failed api_token=[REDACTED]' },
      { name: 'secret longer than the display limit', raw: `token=${'s'.repeat(600)} readable`, expected: 'token=[REDACTED] readable' },
      { name: 'terminal controls', raw: '\u001b[?25lfailed\u001b[?25h\u0007\u009b31m\u001b]52;c;payload\u0007', expected: 'failed' },
      ...['Cookie', 'Set-Cookie'].flatMap((header) => [
        { name: `folded ${header} followed by a reason`,
          raw: `${header}: a=1;\n sid=fixture-secret\nprovider.transport: ECONNRESET`,
          expected: `${header}: [REDACTED] provider.transport: ECONNRESET` },
        { name: `multiple ${header} continuations with tabs and CRLF`,
          raw: `${header}: a=1;\r\n\tsid=fixture-secret;\r\n  other=fixture-extra\r\nprovider.transport: ECONNRESET`,
          expected: `${header}: [REDACTED] provider.transport: ECONNRESET` },
        { name: `quoted ${header} value followed by a continuation and a reason`,
          raw: `${header}: sid="fixture-secret";\n other="fixture-extra"\nprovider.transport: ECONNRESET`,
          expected: `${header}: [REDACTED] provider.transport: ECONNRESET` },
        { name: `quoted ${header} continuations with tabs and CRLF`,
          raw: `${header}: a=1;\r\n\tsid="fixture-secret";\r\n  other='fixture-extra'\r\nprovider.transport: ECONNRESET`,
          expected: `${header}: [REDACTED] provider.transport: ECONNRESET` },
        { name: `unfolded ${header} followed by an independent reason`,
          raw: `${header}: sid=fixture-secret\nprovider.transport: ECONNRESET`,
          expected: `${header}: [REDACTED] provider.transport: ECONNRESET` },
      ]),
      { name: 'authorization with a credential continuation followed by a reason',
        raw: 'Authorization: Bearer abc\n fixture-secret\nprovider.transport: ECONNRESET',
        expected: 'Authorization: Bearer [REDACTED] provider.transport: ECONNRESET' },
      ...['\n', '\r\n', '\r', '\v', '\f', '\u0085', '\u2028', '\u2029'].flatMap((separator) => [
        { name: `authorization followed by a reason (${JSON.stringify(separator)})`,
          raw: `Authorization: Bearer abc${separator}provider.transport: ECONNRESET`,
          expected: 'Authorization: Bearer [REDACTED] provider.transport: ECONNRESET' },
        { name: `folded authorization followed by a reason (${JSON.stringify(separator)})`,
          raw: `Authorization: Bearer${separator}abc${separator}provider.transport: ECONNRESET`,
          expected: 'Authorization: Bearer [REDACTED] provider.transport: ECONNRESET' },
      ]),
      ...[
        ['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r'], ['VT', '\v'], ['FF', '\f'],
        ['NEL', '\u0085'], ['LS', '\u2028'], ['PS', '\u2029'], ['TAB', '\t'],
      ].map(([name, separator]) => ({ name, raw: `before${separator}after`, expected: 'before after' })),
      { name: 'long ASCII', raw: 'x'.repeat(2_000), expected: `${'x'.repeat(499)}…` },
      { name: 'long CJK', raw: '界'.repeat(600), expected: `${'界'.repeat(249)}…` },
      { name: 'long combining graphemes', raw: 'e\u0301'.repeat(600), expected: `${'e\u0301'.repeat(499)}…` },
      { name: 'long emoji graphemes', raw: '👨‍👩‍👧‍👦'.repeat(600), expected: `${'👨‍👩‍👧‍👦'.repeat(249)}…` },
    ])('uses the conversation rule for $name', async ({ raw, expected }) => {
      doubles.label.mockImplementation((key: string, _language: string, vars: { reason?: string }) =>
        key === 'manager.notificationHumanHeadings.blocked' ? 'blocked' : vars.reason);
      const error = new Error(raw);
      const result = conversationErrorResult(error, 'en');

      const message = await notifyManagerTurnFailure('/project', destination === 'goal' ? goal.id : undefined, error);

      expect(result).toEqual({ kind: 'error', code: 'operation_failed', message: expected });
      expect(stringWidth(expected)).toBeLessThanOrEqual(500);
      if (destination === 'goal') {
        expect(message).toBeUndefined();
        expect(goal.notifications).toEqual([expect.objectContaining({ kind: 'blocked', severity: 'error', body: expected })]);
        expect(doubles.send).toHaveBeenCalledExactlyOnceWith('/project', expect.any(Object), goal, 'https://example.test/notify');
        expect(doubles.slack).not.toHaveBeenCalled();
      } else {
        expect(message).toBe(`blocked\n${expected}`);
        expect(doubles.slack).toHaveBeenCalledExactlyOnceWith('https://example.test/notify', message);
        expect(doubles.update).not.toHaveBeenCalled();
        expect(doubles.send).not.toHaveBeenCalled();
      }
    });
  });

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
    await notifyManagerTurnFailure('/project', goal.id, new Error('capacity exhausted api_key=fixture-secret-a'), randomUUID());
    await notifyManagerTurnFailure('/project', goal.id, new Error('capacity exhausted api_key=fixture-secret-b'), randomUUID());
    expect(goal.notifications).toHaveLength(2);
    expect(doubles.send).toHaveBeenCalledTimes(2);
    expect(goal.notifications![0]!.body).toBe(goal.notifications![1]!.body);
  });

  it('saves and delivers only one notification for the same operation', async () => {
    const operationId = randomUUID();
    await notifyManagerTurnFailure('/project', goal.id, new Error('provider failed'), operationId);
    const notification = goal.notifications![0];
    await notifyManagerTurnFailure('/project', goal.id, new Error('process exited'), operationId);
    expect(goal.notifications).toEqual([notification]);
    expect(notification).toMatchObject({ id: operationId, kind: 'blocked', severity: 'error' });
    expect(doubles.send).toHaveBeenCalledOnce();
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
    key === 'manager.notificationHumanHeadings.blocked' ? 'blocked' : `Failure: ${vars.reason}`);
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
