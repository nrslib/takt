import { describe, expect, it, vi } from 'vitest';
import { ToolActivityDisplayStore } from '../features/manager/toolActivityDisplayStore.js';
import type { ConversationClientSnapshot } from '../features/manager/conversationIpcClient.js';
import type { ConversationState, PortOutput } from '../features/manager/conversationPort.js';
import type { ToolActivityEntry, ToolActivityTurnState, ToolActivityTurnUpdate } from '../shared/tool-activity/types.js';

type Output = Exclude<PortOutput, { kind: 'snapshot' }>;

/** 会話クライアントと同じく、差分の配送を先に通知し、その後で確定した状態を通知する。 */
function fakeClient(initial: ConversationClientSnapshot) {
  let view = initial;
  const listeners = new Set<() => void>();
  const outputs = new Set<(output: Output) => void>();
  return {
    getSnapshot: () => view,
    subscribe: vi.fn((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    onOutput: vi.fn((listener: (output: Output) => void) => { outputs.add(listener); return () => { outputs.delete(listener); }; }),
    publish(change: Partial<ConversationClientSnapshot>, output?: Output) {
      if (output !== undefined) for (const listener of outputs) listener(output);
      view = { ...view, ...change };
      for (const listener of listeners) listener();
    },
    get listenerCount() { return listeners.size + outputs.size; },
  };
}

function state(running: { operationId: string; generation: number } | null): ConversationState {
  return { conversationId: 'conversation', assignment: { kind: 'repository', repositoryDirectory: '/repo' }, revision: 0,
    pending: null, approval: null, running: running === null ? null : { ...running, kind: 'turn' }, interrupted: false };
}

function entry(key: string, toolId: string, status: ToolActivityEntry['status'], output = ''): ToolActivityEntry {
  return { key, toolId, tool: 'Bash', input: { command: toolId }, output, status, association: 'matched', startedAt: 1000, startSequence: Number(key),
    ...(status === 'running' ? {} : { result: `${toolId}-result`, completedAt: 2000, completionSequence: Number(key) + 1 }) };
}

function history(turn: { operationId: string; generation: number }, sequence: number, entries: ToolActivityEntry[], finished = false): ToolActivityTurnState {
  return { ...turn, finished, history: { sequence, entries } };
}

function snapshot(running: { operationId: string; generation: number } | null, tools?: ToolActivityTurnState): ConversationClientSnapshot {
  return { connection: 'connected', readStatus: 'complete', state: state(running), error: null,
    items: tools === undefined ? [] : [{ kind: 'tool_history', history: tools }] };
}

const first = { operationId: 'first', generation: 1 };
const second = { operationId: 'second', generation: 2 };
const shownKeys = (store: ToolActivityDisplayStore) => store.getSnapshot().display.groups().flatMap((group) => group.entries.map((value) => value.key));

describe('ToolActivityDisplayStore', () => {
  it('keeps one display for the running turn, applies each update to it, and publishes a new value per change', () => {
    const base = history(first, 1, [entry('1', 'build', 'running')]);
    const client = fakeClient(snapshot(first, base));
    const store = new ToolActivityDisplayStore(client);
    // React は通知を受けたその場で getSnapshot を呼び、値が変わったかを確かめる。
    const listener = vi.fn(() => { store.getSnapshot(); });
    const unsubscribe = store.subscribe(listener);
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);

    const update: ToolActivityTurnUpdate = { ...first, previousSequence: 1, sequence: 2, entries: [], output: { key: '1', text: 'compiling\n' } };
    const applied = history(first, 2, [entry('1', 'build', 'running', 'compiling\n')]);
    const restore = vi.spyOn(before.display, 'restore');
    client.publish({ items: [{ kind: 'tool_history', history: applied }] }, { kind: 'tool_history_update', update });

    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.display).toBe(before.display);
    expect(restore).not.toHaveBeenCalled();
    expect(after.display.detail('1', 0).result.text).toBe('compiling');
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    expect(client.listenerCount).toBe(0);
  });

  it('rebuilds the display from the committed history when an update could not be applied', () => {
    const client = fakeClient(snapshot(first, history(first, 1, [entry('1', 'build', 'running')])));
    const store = new ToolActivityDisplayStore(client);
    const unsubscribe = store.subscribe(() => {});
    const before = store.getSnapshot();
    const skipped: ToolActivityTurnUpdate = { ...first, previousSequence: 5, sequence: 6, entries: [entry('1', 'build', 'success')] };
    client.publish({ items: [{ kind: 'tool_history', history: history(first, 6, [entry('1', 'build', 'success')]) }] },
      { kind: 'tool_history_update', update: skipped });
    const after = store.getSnapshot();
    expect(after.display).not.toBe(before.display);
    expect(after.display.groups()[0]!.entries[0]).toMatchObject({ key: '1', status: 'success' });
    unsubscribe();
  });

  it('does not keep the previous turn, a finished turn running entry, or a disconnected history on screen', () => {
    const client = fakeClient(snapshot(first, history(first, 2, [entry('1', 'read', 'success'), entry('2', 'build', 'running', 'partial')])));
    const store = new ToolActivityDisplayStore(client);
    const unsubscribe = store.subscribe(() => {});
    expect(shownKeys(store)).toEqual(['1', '2']);

    client.publish({ state: state(null), items: [{ kind: 'tool_history', history: history(first, 2, [entry('1', 'read', 'success')], true) }] });
    expect(shownKeys(store)).toEqual(['1']);

    client.publish({ state: state(second) });
    expect(shownKeys(store)).toEqual([]);
    const ignored: ToolActivityTurnUpdate = { ...first, previousSequence: 2, sequence: 3, entries: [entry('3', 'stale', 'running')] };
    client.publish({}, { kind: 'tool_history_update', update: ignored });
    expect(shownKeys(store)).toEqual([]);

    const started: ToolActivityTurnUpdate = { ...second, previousSequence: 0, sequence: 1, entries: [entry('1', 'next', 'running')] };
    client.publish({ items: [{ kind: 'tool_history', history: history(second, 1, started.entries) }] }, { kind: 'tool_history_update', update: started });
    expect(store.getSnapshot().display.groups()[0]!.entries[0]).toMatchObject({ key: '1', input: 'next' });

    client.publish({ connection: 'disconnected', state: null, items: [] });
    expect(shownKeys(store)).toEqual([]);
    unsubscribe();
  });
});
