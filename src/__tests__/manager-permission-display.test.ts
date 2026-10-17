import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ManagerView } from '../features/manager/ManagerView.js';
import type { ManagerConversationSession } from '../features/manager/conversationSession.js';
import * as savedEvents from '../features/manager/savedEvents.js';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ list: vi.fn(), failure: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { list = doubles.list; } }));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: () => ({
  notifications: { custom: true },
}) }));
vi.mock('../features/manager/turnFailureNotification.js', () => ({ notifyManagerTurnFailure: doubles.failure }));

beforeEach(() => {
  vi.resetAllMocks();
  doubles.list.mockResolvedValue({ goals: [], errors: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows a saved custom permission notice for its goal through the existing display events', async () => {
  const body = '人の確認待ち: 送信先を選択してください';
  const goal: Goal = { ...goalRecord(), notifications: [{
    id: '650e8400-e29b-41d4-a716-446655440003', kind: 'custom', body, recordedAt: '2026-10-17T00:00:00Z',
  }] };
  doubles.list.mockResolvedValueOnce({ goals: [goal], errors: [] });

  const result = await savedEvents.readManagerDisplayEvents('/fixture/manager', 'ja');

  expect(result.events).toEqual([expect.objectContaining({ message: expect.stringContaining(body) })]);
  expect(result.events[0]!.message).toContain(goal.id.slice(0, 8));
});

it('displays a goal-less permission notice during a successful conversation and accepts the next message', async () => {
  vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue({ events: [], diagnostics: [], questions: [], goals: [] });
  const notice = '人の確認待ち: 外部送信先の選択が必要です';
  const unusedOperation = async (): Promise<never> => { throw new Error('unused manager operation'); };
  type Turn = Parameters<ManagerConversationSession['handleUserMessage']>[0] & { onNotification?: (message: string) => void };
  const handleUserMessage = vi.fn(async (options: Turn) => {
    options.onNotification?.(notice);
    return { kind: 'reply' as const, message: '会話を続けます' };
  });
  const session: ManagerConversationSession = {
    getAssignment: async () => undefined, resetConversation: () => {}, getPendingSummary: () => null,
    dismissSummary: () => {}, handleUserMessage, approveSummary: unusedOperation,
    answerQuestion: unusedOperation, pauseGoal: unusedOperation, resumeGoal: unusedOperation,
    abortGoal: unusedOperation, close: async () => {},
  };
  const app = render(createElement(ManagerView, {
    cwd: '/fixture/manager', lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn(),
  }));
  try {
    for (const text of ['最初の相談', '確認後の相談']) {
      app.stdin.write(text);
      await vi.waitFor(() => expect(app.lastFrame()).toContain(text));
      app.stdin.write('\r');
      await vi.waitFor(() => expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({ text })));
      await vi.waitFor(() => expect(app.lastFrame()).toContain('会話を続けます'));
    }
    expect(handleUserMessage).toHaveBeenCalledTimes(2);
    expect(app.lastFrame()).toContain(notice);
    expect(doubles.failure).not.toHaveBeenCalled();
  } finally { app.unmount(); await session.close(); }
});
