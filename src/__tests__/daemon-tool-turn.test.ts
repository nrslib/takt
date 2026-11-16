import { expect, it } from 'vitest';
import { ToolTurn } from '../features/daemon/toolTurn.js';
import type { ToolActivityEvent } from '../shared/tool-activity/types.js';
import { LIVE_TOOL_OUTPUT_LIMIT, RETAINED_TOOL_OUTPUT_BYTES } from '../shared/tool-activity/outputLimit.js';

const turn = { conversationId: 'conversation', operationId: 'operation', generation: 1 };
function fixture() {
  const tools = new ToolTurn(turn);
  const apply = (event: ToolActivityEvent & { data: { id: string } }) => tools.apply({ kind: 'tool_event', eventId: 'event',
    event: { ...event, toolActivity: { callId: 'call', operationId: turn.operationId, generation: turn.generation } } });
  return { tools, apply };
}

it('uses earlier input discoveries to mask later inputs and outputs of another tool', () => {
  const f = fixture();
  f.apply({ type: 'tool_use', data: { id: 'first', tool: 'Bash', input: { token: 'known-secret' } } });
  const started = f.apply({ type: 'tool_use', data: { id: 'second', tool: 'Bash', input: { command: 'echo known-secret' } } });
  expect(started).toMatchObject([{ kind: 'tool_started', entry: { input: { command: 'echo [REDACTED]' } } }]);
  expect(f.apply({ type: 'tool_output', data: { id: 'second', tool: 'Bash', output: 'known-secret\n' } }))
    .toMatchObject([{ kind: 'tool_output', text: '[REDACTED]\n', tail: '' }]);
  const completed = f.apply({ type: 'tool_result', data: { id: 'second', content: 'known-secret', isError: false } });
  expect(completed).toMatchObject([{ kind: 'tool_completed', entry: { result: '[REDACTED]' } }]);
});

it('rejects a tool event from another operation or generation without recording it', () => {
  const tools = new ToolTurn(turn);
  for (const other of [{ operationId: 'other-operation', generation: turn.generation }, { operationId: turn.operationId, generation: turn.generation + 1 }]) {
    expect(() => tools.apply({ kind: 'tool_event', eventId: 'event', event: { type: 'tool_use',
      data: { id: 'tool', tool: 'Bash', input: {} }, toolActivity: { callId: 'call', ...other } } })).toThrow();
  }
  expect(tools.snapshot().history.entries).toEqual([]);
});

it('updates a running entry when its input arrives after output or changes later', () => {
  const f = fixture();
  const [first] = f.apply({ type: 'tool_output', data: { id: 'tool', tool: 'Tool', output: 'ready\n' } });
  if (first?.kind !== 'tool_started') throw new Error('Expected tool start');
  for (const command of ['first command', 'updated command']) {
    expect(f.apply({ type: 'tool_use', data: { id: 'tool', tool: 'Bash', input: { token: 'known-secret', command } } }))
      .toMatchObject([{ kind: 'tool_started', entry: { key: first.entry.key, tool: 'Bash', input: { token: '[REDACTED]', command }, output: 'ready\n' } }]);
  }
  expect(f.apply({ type: 'tool_result', data: { id: 'tool', content: '', isError: false } }))
    .toMatchObject([{ kind: 'tool_completed', entry: { key: first.entry.key, input: { command: 'updated command' }, output: 'ready\n' } }]);
});

it('replaces masked tails and snapshots running tool identity and input without unfinished output', () => {
  const f = fixture();
  f.apply({ type: 'tool_use', data: { id: 'tool', tool: 'Bash', input: { token: 'secret-value' } } });
  expect(f.apply({ type: 'tool_output', data: { id: 'tool', tool: 'Bash', output: 'ready secr' } }))
    .toMatchObject([{ kind: 'tool_output', text: '', tail: 'ready [REDACTED]' }]);
  expect(f.tools.snapshot().history.entries).toMatchObject([{ toolId: 'tool', tool: 'Bash', input: { token: '[REDACTED]' }, output: '', status: 'running' }]);
  expect(f.apply({ type: 'tool_output', data: { id: 'tool', tool: 'Bash', output: 'et-value\nnext' } }))
    .toMatchObject([{ kind: 'tool_output', text: 'ready [REDACTED]\n', tail: 'next' }]);
  expect(f.apply({ type: 'tool_result', data: { id: 'tool', content: '', isError: false } }))
    .toMatchObject([{ kind: 'tool_completed', entry: { output: 'ready [REDACTED]\nnext' } }]);
});

it('limits live output per key while continuing aggregation and other tools', () => {
  const f = fixture();
  f.apply({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: {} } });
  let delivered = 0;
  for (let index = 0; index < LIVE_TOOL_OUTPUT_LIMIT + 2; index++) delivered += f.apply({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: 'x\n' } }).length;
  expect(delivered).toBe(LIVE_TOOL_OUTPUT_LIMIT);
  f.apply({ type: 'tool_use', data: { id: 'b', tool: 'Bash', input: {} } });
  expect(f.apply({ type: 'tool_output', data: { id: 'b', tool: 'Bash', output: 'still live\n' } })).toHaveLength(1);
  expect(f.apply({ type: 'tool_result', data: { id: 'a', content: '', isError: false } }))
    .toMatchObject([{ kind: 'tool_completed', entry: { output: 'x\n'.repeat(LIVE_TOOL_OUTPUT_LIMIT + 2) } }]);
});

it('clears the provisional tail in the final live notification and keeps it absent until completion', () => {
  const f = fixture();
  const [started] = f.apply({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: {} } });
  if (started?.kind !== 'tool_started') throw new Error('Expected tool start');
  for (let index = 0; index < LIVE_TOOL_OUTPUT_LIMIT - 2; index++) {
    f.apply({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: 'x\n' } });
  }
  expect(f.apply({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: 'using later-secret' } }))
    .toEqual([{ kind: 'tool_output', key: started.entry.key, text: '', tail: 'using later-secret' }]);
  expect(f.apply({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: ' still-working' } }))
    .toEqual([{ kind: 'tool_output', key: started.entry.key, text: '', tail: '' }]);
  expect(f.apply({ type: 'tool_use', data: { id: 'c', tool: 'Read', input: { token: 'later-secret' } } }))
    .toMatchObject([{ kind: 'tool_started', entry: { toolId: 'c' } }]);
  expect(f.apply({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: ' remains' } })).toEqual([]);
  expect(f.apply({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: ' until completion' } })).toEqual([]);
  expect(f.apply({ type: 'tool_result', data: { id: 'a', content: '', isError: false } }))
    .toMatchObject([{ kind: 'tool_completed', entry: { key: started.entry.key, status: 'success',
      output: 'x\n'.repeat(LIVE_TOOL_OUTPUT_LIMIT - 2) + 'using [REDACTED] still-working remains until completion' } }]);
});

it('retains the head and tail at one MiB without failing the tool', () => {
  const f = fixture();
  f.apply({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: {} } });
  f.apply({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: 'HEAD\n' + 'あ'.repeat(RETAINED_TOOL_OUTPUT_BYTES) + '\nTAIL\n' } });
  const [event] = f.apply({ type: 'tool_result', data: { id: 'a', content: '', isError: false } });
  if (event?.kind !== 'tool_completed') throw new Error('Expected completed tool');
  expect(event.entry.status).toBe('success');
  expect(Buffer.byteLength(event.entry.output)).toBeLessThanOrEqual(RETAINED_TOOL_OUTPUT_BYTES);
  expect(event.entry.output.startsWith('HEAD\n')).toBe(true);
  expect(event.entry.output.endsWith('\nTAIL\n')).toBe(true);
  expect(event.entry.output).not.toContain('\uFFFD');
});

it('keeps a large unfinished PEM private through its closing marker and preserves the safe suffix', () => {
  const f = fixture();
  f.apply({ type: 'tool_use', data: { id: 'pem', tool: 'Bash', input: {} } });
  f.apply({ type: 'tool_output', data: { id: 'pem', tool: 'Bash', output: '-----BEGIN PRIVATE KEY-----\n' + 'Q'.repeat(RETAINED_TOOL_OUTPUT_BYTES + 1) } });
  f.apply({ type: 'tool_output', data: { id: 'pem', tool: 'Bash', output: 'R'.repeat(1000) + '\n-----END PRIVATE KEY-----\nsafe\n' } });
  const [event] = f.apply({ type: 'tool_result', data: { id: 'pem', content: '', isError: false } });
  if (event?.kind !== 'tool_completed') throw new Error('Expected completed tool');
  expect(event.entry.output).not.toMatch(/QQQQ|RRRR/);
  expect(event.entry.output).toContain('safe');
  expect(Buffer.byteLength(event.entry.output)).toBeLessThanOrEqual(RETAINED_TOOL_OUTPUT_BYTES);
});

it('masks tool descriptions with the same turn-wide discoveries as entries and output', () => {
  const f = fixture();
  f.apply({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { token: 'known-secret' } } });
  expect(f.tools.maskActivity({ kind: 'tool', tool: 'Bash', description: 'echo known-secret' }))
    .toEqual({ kind: 'tool', tool: 'Bash', description: 'echo [REDACTED]' });
  expect(f.tools.maskActivity({ kind: 'tool', tool: 'Bash', description: 'token=other-secret' }))
    .toEqual({ kind: 'tool', tool: 'Bash', description: 'token=[REDACTED]' });
});
