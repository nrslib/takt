import { expect, it } from 'vitest';
import { ToolActivityDisplayStore } from '../features/manager/toolActivityDisplayStore.js';
import type { ConversationClientSnapshot } from '../features/manager/conversationIpcClient.js';
import type { PortOutput } from '../features/manager/conversationPort.js';
import type { ToolActivityEntry } from '../shared/tool-activity/types.js';
import { ToolActivityDisplay } from '../shared/ui/ToolActivityDisplay.js';

it('appends committed text and replaces the provisional tail until completion', () => {
  const state = new Set<() => void>();
  const outputs = new Set<(event: Exclude<PortOutput, { kind: 'snapshot' }>) => void>();
  const snapshot: ConversationClientSnapshot = { connection: 'connected', readStatus: 'complete', state: null, items: [], error: null };
  const store = new ToolActivityDisplayStore({ getSnapshot: () => snapshot,
    subscribe(listener) { state.add(listener); return () => { state.delete(listener); }; },
    onOutput(listener) { outputs.add(listener); return () => { outputs.delete(listener); }; } });
  const detach = store.subscribe(() => {});
  const emit = (event: Exclude<PortOutput, { kind: 'snapshot' }>) => { for (const listener of outputs) listener(event); };
  const entry: ToolActivityEntry = { key: '1', toolId: 'tool', tool: 'Bash', input: {}, output: '', status: 'running', association: 'matched' };
  emit({ kind: 'tool_started', entry });
  emit({ kind: 'tool_output', key: '1', text: 'first\n', tail: 'draft' });
  emit({ kind: 'tool_output', key: '1', text: '', tail: 'replacement' });
  expect(store.getSnapshot().display.detail('1', 0).result.text).toBe('first\nreplacement');
  emit({ kind: 'tool_output', key: '1', text: 'second\n', tail: '' });
  emit({ kind: 'tool_completed', entry: { ...entry, output: 'first\nsecond\n', status: 'success' } });
  expect(store.getSnapshot().display.detail('1', 0).result.text).toBe('first\nsecond');
  expect(store.getSnapshot().display.history.entries()).toHaveLength(1);
  detach();
  expect(outputs.size).toBe(0);
});

it('restores only running snapshot entries for the current operation and generation', () => {
  const listeners = new Set<() => void>();
  const snapshot: ConversationClientSnapshot = { connection: 'connected', readStatus: 'complete', error: null,
    state: { conversationId: 'conversation', assignment: { kind: 'repository', repositoryDirectory: '/repo' }, revision: 0,
      pending: null, approval: null, interrupted: false, running: { operationId: 'current', generation: 2, kind: 'turn' } }, items: [] };
  snapshot.items = ([['current', 1, 'old-generation'], ['previous', 2, 'old-operation'], ['current', 2, 'active']] as const).map(([operationId, generation, key]) => ({
    kind: 'tool_history' as const, history: { operationId, generation, finished: false,
      history: { entries: [{ key, toolId: key, tool: 'Read', input: { file_path: `${key}.ts` }, output: '', status: 'running' as const,
        association: 'matched' as const, context: { callId: 'call', operationId, generation } }] } },
  }));
  const store = new ToolActivityDisplayStore({ getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }, onOutput: () => () => {} });
  const detach = store.subscribe(() => {});
  expect(store.getSnapshot().display.history.entries().map((entry) => entry.key)).toEqual(['active']);
  snapshot.state = { ...snapshot.state!, running: { operationId: 'current', generation: 3, kind: 'turn' } };
  for (const listener of listeners) listener();
  expect(store.getSnapshot().display.history.entries()).toEqual([]);
  detach();
});

it('keeps tools from earlier turns out of the detail display and keeps the latest turn after it becomes idle', () => {
  const listeners = new Set<() => void>();
  const outputs = new Set<(event: Exclude<PortOutput, { kind: 'snapshot' }>) => void>();
  const state = { conversationId: 'conversation', assignment: { kind: 'repository' as const, repositoryDirectory: '/repo' }, revision: 0,
    pending: null, approval: null, interrupted: false, running: null };
  const completed = (operationId: string, key: string): ToolActivityEntry => ({ key, toolId: key, tool: 'Read', input: { file_path: `${key}.ts` },
    output: '', status: 'success', association: 'matched', context: { callId: 'call', operationId, generation: 1 } });
  const snapshot: ConversationClientSnapshot = { connection: 'connected', readStatus: 'complete', error: null, state,
    items: (['first', 'second'] as const).map((operationId) => ({ kind: 'tool_history' as const,
      history: { operationId, generation: 1, finished: true, history: { entries: [completed(operationId, `${operationId}-tool`)] } } })) };
  const store = new ToolActivityDisplayStore({ getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onOutput(listener) { outputs.add(listener); return () => { outputs.delete(listener); }; } });
  const changed = () => { for (const listener of listeners) listener(); };
  const keys = () => store.getSnapshot().display.history.entries().map((entry) => entry.key);
  const detach = store.subscribe(() => {});
  expect(keys()).toEqual(['second-tool']);

  snapshot.state = { ...state, running: { operationId: 'third', generation: 1, kind: 'turn' } };
  changed();
  expect(keys()).toEqual([]);
  for (const listener of outputs) listener({ kind: 'tool_completed', entry: completed('third', 'third-tool') });
  snapshot.state = state;
  changed();
  expect(keys()).toEqual(['third-tool']);
  detach();
});

it('hides JSON output while running and classifies the completed entry', () => {
  const display = new ToolActivityDisplay('silent', false, () => {}, false, true);
  const entry: ToolActivityEntry = { key: 'json', toolId: 'tool', tool: 'Bash', input: {}, output: '', status: 'running', association: 'matched' };
  display.upsert(entry);
  const text = JSON.stringify(Array.from({ length: 512 }, (_, index) => index));
  for (let offset = 0; offset < text.length; offset += 7) {
    display.appendOutput(entry.key, text.slice(offset, offset + 7), '');
    expect(display.detail(entry.key, 0).result.text).toBe('');
  }
  display.upsert({ ...entry, output: text, status: 'success' });
  expect(display.detail(entry.key, 0).result.text).toBe('[structured output omitted]');
});

it('removes terminal control characters from a completed JSON result', () => {
  const display = new ToolActivityDisplay('silent', false, () => {}, false, true);
  display.upsert({ key: 'json', toolId: 'tool', tool: 'Bash', input: {}, status: 'success', association: 'matched',
    output: '{"stdout":"step1\\r\\u001b[2Kstep2\\u001b[2J"}' });
  expect(display.detail('json', 0).result.text).toBe('step1step2');
  const texts = [display.detail('json', 0).result.text,
    ...display.groups().flatMap((group) => [group.summary, ...group.entries.map((item) => item.result.text)])];
  for (const text of texts) {
    expect(text).not.toContain('\x1b');
    expect(text).not.toContain('\r');
  }
});
