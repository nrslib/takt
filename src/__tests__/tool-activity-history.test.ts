import { describe, expect, it } from 'vitest';
import { ToolActivityHistory } from '../shared/tool-activity/index.js';
import type { StreamEvent } from '../shared/types/provider.js';

const use = (id: string, callId = 'a'): Extract<StreamEvent, { type: 'tool_use' }> => ({
  type: 'tool_use', data: { id, tool: 'Read', input: { file_path: `${callId}.ts` } }, toolActivity: { callId },
});
const result = (id: string, isError = false, callId = 'a'): Extract<StreamEvent, { type: 'tool_result' }> => ({
  type: 'tool_result', data: { id, content: `${callId}-result`, isError }, toolActivity: { callId },
});

describe('tool activity history', () => {
  it('should roundtrip provider identities without imposing daemon operation ID limits', () => {
    const history = new ToolActivityHistory(() => 1000.5);
    const toolId = 'provider-tool-'.repeat(30);
    const callId = 'call-context-'.repeat(30);
    history.apply(use(toolId, callId)); history.apply(result(toolId, false, callId));
    const restored = new ToolActivityHistory();
    restored.restore(history.snapshot());
    expect(restored.entries()).toEqual(history.entries());
    expect(restored.entries()[0]).toMatchObject({ toolId, context: { callId }, startedAt: 1000.5, completedAt: 1000.5 });
  });
  it('should restore identity, observed timestamps and reception order without replaying events', () => {
    let now = 1000;
    const original = new ToolActivityHistory(() => now);
    original.apply(use('first')); original.apply(use('second'));
    now = 1250; original.apply(result('second', true));
    const saved = original.snapshot();
    const restored = new ToolActivityHistory(() => 9000);
    restored.restore(saved);
    expect(restored.entries()).toEqual(original.entries());
    expect(restored.apply(result('second', true))).toEqual([]);
    const [finished] = restored.apply(result('first'));
    expect(finished).toMatchObject({ startedAt: 1000, completedAt: 9000, status: 'success' });
    expect(finished!.completionSequence).toBeGreaterThan(saved.sequence);
    restored.restore(saved);
    expect(restored.snapshot()).toEqual(saved);
    saved.entries[0]!.input.file_path = 'mutated';
    expect(restored.entries()[0]!.input.file_path).toBe('a.ts');
  });

  it('should not reuse retained entry keys after unfinished entries were removed', () => {
    const original = new ToolActivityHistory();
    original.apply(use('unfinished')); original.apply(use('finished')); original.apply(result('finished'));
    const saved = original.snapshot();
    const restored = new ToolActivityHistory();
    restored.restore({ ...saved, entries: saved.entries.filter((entry) => entry.status !== 'running') });
    restored.apply(use('new'));
    expect(new Set(restored.entries().map((entry) => entry.key)).size).toBe(2);
    expect(restored.entries().map((entry) => entry.toolId)).toEqual(['finished', 'new']);
  });

  it('should reject duplicate keys in a saved history', () => {
    const history = new ToolActivityHistory();
    history.apply(use('first'));
    const saved = history.snapshot();
    expect(() => history.restore({ ...saved, entries: [...saved.entries, ...saved.entries] })).toThrow();
  });

  it('should select by entry key and isolate the returned input, context and status', () => {
    const history = new ToolActivityHistory();
    const [started] = history.apply(use('provider-id'));
    history.apply(use('other-id'));
    const selected = history.get(started!.key)!;
    expect(selected).toMatchObject({ toolId: 'provider-id', input: { file_path: 'a.ts' }, status: 'running' });
    selected.input.file_path = 'changed.ts';
    selected.status = 'failure';
    selected.context!.callId = 'changed';
    expect(history.get(started!.key)).toMatchObject({ input: { file_path: 'a.ts' }, context: { callId: 'a' }, status: 'running' });
    expect(history.get('provider-id')).toBeUndefined();
    expect(history.get('missing')).toBeUndefined();
  });

  it('should update the original entry with success and observed timestamps', () => {
    let now = 1000;
    const history = new ToolActivityHistory(() => now);
    const [started] = history.apply(use('item_0'));
    expect(started).toMatchObject({ toolId: 'item_0', status: 'running', startedAt: 1000 });
    now = 1250;
    history.apply({ ...result('item_0'), data: { id: 'item_0', content: 'done', isError: false } });
    expect(history.entries()).toEqual([expect.objectContaining({
      key: started!.key, status: 'success', startedAt: 1000, completedAt: 1250, result: 'done',
    })]);
  });

  it('should separate the same provider ID across concurrent calls', () => {
    const history = new ToolActivityHistory();
    history.apply(use('item_0', 'a'));
    history.apply(use('item_0', 'b'));
    history.apply(result('item_0', false, 'b'));
    history.apply(result('item_0', true, 'a'));
    expect(history.entries().map((entry) => [entry.context?.callId, entry.status, entry.result])).toEqual([
      ['a', 'failure', 'a-result'], ['b', 'success', 'b-result'],
    ]);
  });

  it('should preserve supplied operation and generation without conflating contexts', () => {
    const history = new ToolActivityHistory();
    for (const generation of [1, 2]) history.apply({ ...use('same'), toolActivity: { callId: 'a', operationId: 'op', generation } });
    history.apply({ ...result('same'), toolActivity: { callId: 'a', operationId: 'op', generation: 2 } });
    expect(history.entries().map((entry) => [entry.context?.generation, entry.status])).toEqual([[1, 'running'], [2, 'success']]);
  });

  it('should retain start order while recording delayed completion reception order', () => {
    const history = new ToolActivityHistory();
    history.apply(use('first'));
    history.apply(use('second'));
    history.apply(result('second'));
    history.apply(result('first', true));
    const [first, second] = history.entries();
    expect([first!.toolId, second!.toolId]).toEqual(['first', 'second']);
    expect(first!.completionSequence).toBeGreaterThan(second!.completionSequence!);
    expect(first!.status).toBe('failure');
    history.apply(result('first'));
    expect(history.entries()[0]!.status).toBe('failure');
    expect(history.entries()[1]!.status).toBe('success');
  });

  it('should complete every distinct ID exactly once in a batched event', () => {
    const history = new ToolActivityHistory();
    history.apply(use('a')); history.apply(use('b'));
    const changed = history.apply({ type: 'tool_result', toolActivity: { callId: 'a' },
      data: { id: 'a', completedToolIds: ['b', 'a'], content: 'shared', isError: true } });
    expect(changed).toHaveLength(2);
    expect(history.entries().map((entry) => [entry.toolId, entry.status, entry.result])).toEqual([
      ['a', 'failure', 'shared'], ['b', 'failure', 'shared'],
    ]);
    expect(history.apply({ type: 'tool_result', toolActivity: { callId: 'a' },
      data: { id: 'a', completedToolIds: ['b'], content: 'shared', isError: true } })).toEqual([]);
  });

  it('should associate an ID-less result only when there is one running candidate', () => {
    const history = new ToolActivityHistory();
    history.apply(use('only'));
    history.apply({ type: 'tool_result', toolActivity: { callId: 'a' }, data: { content: 'done', isError: false } });
    expect(history.entries()).toEqual([expect.objectContaining({ toolId: 'only', status: 'success', result: 'done' })]);
  });

  it('should retain ambiguous results without assigning them to the latest running tool', () => {
    const history = new ToolActivityHistory();
    history.apply(use('a')); history.apply(use('b'));
    history.apply({ type: 'tool_result', toolActivity: { callId: 'a' }, data: { content: 'unassigned', isError: true } });
    expect(history.entries().map((entry) => entry.status)).toEqual(['running', 'running', 'failure']);
    expect(history.entries()[2]).toMatchObject({ association: 'unmatched', result: 'unassigned' });
  });

  it('should not assign an unknown explicit ID to another running tool', () => {
    const history = new ToolActivityHistory();
    history.apply(use('known'));
    history.apply(result('unknown', true));
    expect(history.entries()).toEqual([
      expect.objectContaining({ toolId: 'known', status: 'running' }),
      expect.objectContaining({ toolId: 'unknown', association: 'unmatched', status: 'failure' }),
    ]);
  });

  it('should accumulate output by ID without using final model success to complete tools', () => {
    const history = new ToolActivityHistory();
    history.apply(use('a')); history.apply(use('b'));
    for (const output of ['first', 'second']) history.apply({ type: 'tool_output', toolActivity: { callId: 'a' }, data: { id: 'a', tool: 'Read', output } });
    history.apply({ type: 'result', data: { result: 'model done', sessionId: 'session', success: true } });
    history.apply({ type: 'thinking', data: { thinking: 'hidden' } });
    expect(history.entries().map((entry) => [entry.output, entry.status])).toEqual([['firstsecond', 'running'], ['', 'running']]);
  });

  it('should protect stored input and entries from caller mutations', () => {
    const history = new ToolActivityHistory();
    const event = use('a');
    history.apply(event);
    if (event.type === 'tool_use') event.data.input.file_path = 'changed.ts';
    const entries = history.entries();
    entries[0]!.input.file_path = 'changed-again.ts';
    entries[0]!.status = 'failure';
    expect(history.entries()[0]).toMatchObject({ input: { file_path: 'a.ts' }, status: 'running' });
  });
});
