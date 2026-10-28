import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, vi, type Mock } from 'vitest';
import { ManagerView } from '../../features/manager/ManagerView.js';
import type { ConversationClientSnapshot } from '../../features/manager/conversationIpcClient.js';
import type { ConversationCommand, PortOutput, Submission } from '../../features/manager/conversationPort.js';
import type { ManagerGoalSummary } from '../../infra/goals/schema.js';
import { conversationRecord } from './conversation-fixtures.js';

export const cwd = '/test/manager-repository';
export const summaryA: ManagerGoalSummary = { objective: 'CSVを出力する', outOfScope: ['JSON出力'],
  acceptanceCriteria: ['CSVを取得できる'], constraints: ['mock provider のみ'] };
export const summaryB: ManagerGoalSummary = { objective: 'JSONを出力する', outOfScope: ['CSV出力', '通知'],
  acceptanceCriteria: ['JSONを取得できる', '列名を含む'], constraints: [], startBranch: 'release', integrationBranch: 'main' };
export const ENTER = '\r';
export const UP = '\x1b[A';
export const DOWN = '\x1b[B';
export const ESC = '\x1b[27u';
export const QUESTION_MENU = '\x12';
export const GOAL_MENU = '\x07';
type Output = Exclude<PortOutput, { kind: 'snapshot' }>;

/** The UI boundary is authoritative snapshots plus commands and output events. */
export class ManagerClientDouble {
  private view: ConversationClientSnapshot;
  private listeners = new Set<() => void>();
  private outputs = new Set<(output: Output) => void>();
  constructor(change: Partial<ConversationClientSnapshot> = {}) {
    const record = conversationRecord(cwd);
    this.view = { connection: 'connected', readStatus: 'complete', error: null,
      state: { conversationId: record.id, assignment: record.assignment, revision: 4,
        pending: null, approval: null, running: null, interrupted: false },
      items: [{ kind: 'assignment', assignment: { kind: 'repository', repositoryDirectory: cwd, repositoryDirectories: [cwd] } }],
      ...change };
  }
  getSnapshot = (): ConversationClientSnapshot => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  onOutput = (listener: (output: Output) => void): (() => void) => { this.outputs.add(listener); return () => { this.outputs.delete(listener); }; };
  submit = vi.fn(async (_command: ConversationCommand, onAccepted?: (id: string) => void): Promise<Submission> => {
    const operationId = randomUUID();
    onAccepted?.(operationId);
    return { kind: 'accepted', operationId };
  });
  refresh = vi.fn(async (): Promise<void> => {});
  close = vi.fn();
  change(change: Partial<ConversationClientSnapshot>): void {
    this.view = { ...this.view, ...change };
    for (const listener of this.listeners) listener();
  }
  output(output: Output): void {
    if (output.kind === 'pending' || output.kind === 'running') this.change({ state: output.state });
    for (const listener of this.outputs) listener(output);
  }
  proposal(summary: ManagerGoalSummary, revision = 4): void {
    this.change({ state: { ...this.view.state!, revision, running: null,
      pending: { revision, repositoryDirectory: cwd, summary } } });
  }
  commands(): ConversationCommand[] { return this.submit.mock.calls.map(([command]) => command); }
  async operation(): Promise<string> {
    const result = await this.submit.mock.results.at(-1)!.value;
    if (result.kind !== 'accepted') throw new Error('Expected an accepted operation');
    return result.operationId;
  }
}
export function mount(lang: 'ja' | 'en' = 'en', client = new ManagerClientDouble()): {
  app: ReturnType<typeof render>; client: ManagerClientDouble; onExit: Mock<() => void>;
} {
  const onExit = vi.fn();
  const app = render(createElement(ManagerView, { cwd, lang, client,
    assignment: { kind: 'repository', repositoryDirectory: cwd, repositoryDirectories: [cwd] },
    initialDiagnostics: [], onExit }));
  return { app, client, onExit };
}
export type Tui = ReturnType<typeof mount>;
export const waitFor = (assertion: () => void | Promise<void>): Promise<void> => vi.waitFor(assertion, { timeout: 2000 });
export const promptFrame = ({ app }: Tui): string => {
  const frame = app.lastFrame()!;
  return frame.slice(frame.lastIndexOf('╭'));
};
export async function typeAndSubmit(context: Tui, text: string): Promise<void> {
  context.app.stdin.write('\x1b[200~' + text + '\x1b[201~');
  await waitFor(() => expect(promptFrame(context)).toContain(text.split('\n')[0]!.replace(/\t/gu, ' ')));
  context.app.stdin.write(ENTER);
}
export function approveSummary(context: Tui): void {
  context.app.stdin.write(UP);
  context.app.stdin.write(ENTER);
}
export async function showProposal(context: Tui, summary = summaryA, revision = 4): Promise<void> {
  context.client.proposal(summary, revision);
  await waitFor(() => expect(context.app.lastFrame()).toContain(summary.objective));
}
export async function finish(context: Tui, message = 'Completed'): Promise<void> {
  const operationId = await context.client.operation();
  context.client.change({ state: { ...context.client.getSnapshot().state!, running: null } });
  context.client.output({ kind: 'result', operationId, result: { kind: 'reply', message } });
  await waitFor(() => expect(context.app.lastFrame()).toContain(message));
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
