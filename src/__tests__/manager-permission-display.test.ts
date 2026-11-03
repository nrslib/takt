import { collectItems, iterateTestDisplayEvents } from './helpers/manager-display-items.js';
import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ManagerView } from '../features/manager/ManagerView.js';
import { randomUUID } from 'node:crypto';
import type { ConversationClientSnapshot } from '../features/manager/conversationIpcClient.js';
import type { ConversationCommand, PortOutput } from '../features/manager/conversationPort.js';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ goals: [] as Goal[], failure: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { async *iterate() { yield* doubles.goals; } } }));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: () => ({
  notifications: { custom: true },
}) }));
vi.mock('../features/manager/turnFailureNotification.js', () => ({ notifyManagerTurnFailure: doubles.failure }));

beforeEach(() => {
  vi.resetAllMocks();
  doubles.goals = [];
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(['ja', 'en'] as const)('shows a saved custom permission notice in %s for its goal through the existing display events', async (language) => {
  const body = language === 'ja' ? '人の確認待ち (Bash): 送信先を選択してください'
    : 'Waiting for human confirmation (Bash): Choose a destination';
  const goal: Goal = { ...goalRecord(), notifications: [{
    id: '650e8400-e29b-41d4-a716-446655440003', kind: 'custom', body, recordedAt: '2026-10-17T00:00:00Z',
  }] };
  doubles.goals = [goal];

  const events = await collectItems(iterateTestDisplayEvents({ kind: 'repository', repositoryDirectory: '/fixture/manager', repositoryDirectories: ['/fixture/manager'] }, language, new Map(), -Infinity));

  expect(events).toEqual([expect.objectContaining({ message: expect.stringContaining(body) })]);
  expect(events[0]!.message).toContain(goal.id.slice(0, 8));
});

it.each(['ja', 'en'] as const)('displays a goal-less permission notice in %s during a successful conversation and accepts the next message', async (language) => {
  const notice = language === 'ja' ? '人の確認待ち (Bash): 外部送信先の選択が必要です'
    : 'Waiting for human confirmation (Bash): Choose an external destination';
  const snapshot: ConversationClientSnapshot = { connection: 'connected', readStatus: 'complete', state: null, items: [], error: null };
  const listeners = new Set<(output: Exclude<PortOutput, { kind: 'snapshot' }>) => void>();
  const submit = vi.fn(async (command: ConversationCommand, onAccepted?: (id: string) => void) => {
    expect(command.kind).toBe('message');
    const operationId = randomUUID();
    onAccepted?.(operationId);
    for (const listener of listeners) {
      listener({ kind: 'progress', operationId, message: notice });
      listener({ kind: 'result', operationId, result: { kind: 'reply', message: '会話を続けます' } });
    }
    return { kind: 'accepted' as const, operationId };
  });
  const client = { getSnapshot: () => snapshot, subscribe: () => () => {},
    onOutput: (listener: (output: Exclude<PortOutput, { kind: 'snapshot' }>) => void) => {
      listeners.add(listener); return () => { listeners.delete(listener); };
    }, submit, refresh: async () => {}, close: () => {},
  };
  const app = render(createElement(ManagerView, {
    cwd: '/fixture/manager', lang: language, client, assignment: { kind: 'repository', repositoryDirectory: '/fixture/manager', repositoryDirectories: ['/fixture/manager'] }, initialDiagnostics: [], onExit: vi.fn(),
  }));
  try {
    for (const text of ['最初の相談', '確認後の相談']) {
      app.stdin.write(text);
      await vi.waitFor(() => expect(app.lastFrame()).toContain(text));
      app.stdin.write('\r');
      await vi.waitFor(() => expect(submit).toHaveBeenCalledWith({ kind: 'message', text }, expect.any(Function)));
      await vi.waitFor(() => expect(app.lastFrame()).toContain('会話を続けます'));
    }
    expect(submit).toHaveBeenCalledTimes(2);
    expect(app.lastFrame()).toContain(notice);
    expect(doubles.failure).not.toHaveBeenCalled();
  } finally { app.unmount(); client.close(); }
});
