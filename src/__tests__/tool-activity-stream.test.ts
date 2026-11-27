import { describe, expect, it, vi } from 'vitest';
import { withToolActivityCall } from '../shared/tool-activity/stream.js';
import type { StreamEvent } from '../shared/types/provider.js';

describe('tool activity call context', () => {
  it('should keep one call identity and preserve every original event payload', () => {
    const received: StreamEvent[] = [];
    const callback = withToolActivityCall((event) => received.push(event))!;
    const events: StreamEvent[] = [
      { type: 'tool_use', data: { id: 'item_0', tool: 'Read', input: { file_path: 'a.ts' } } },
      { type: 'tool_result', data: { id: 'item_0', completedToolIds: ['item_0'], content: 'done', isError: false } },
    ];
    const original = structuredClone(events);
    events.forEach(callback);
    expect(received[0]!.toolActivity?.callId).toBeTruthy();
    expect(received[0]!.toolActivity?.callId).toBe(received[1]!.toolActivity?.callId);
    expect(received.map(({ type, data }) => ({ type, data }))).toEqual(events);
    expect(events).toEqual(original);
  });

  it('should preserve an inner provider-attempt identity through the outer call wrapper', () => {
    const callback = vi.fn();
    const outer = withToolActivityCall(callback)!;
    const first = withToolActivityCall(outer)!;
    const second = withToolActivityCall(outer)!;
    const event: StreamEvent = { type: 'tool_use', data: { id: 'item_0', tool: 'Read', input: {} } };
    first(event); second(event);
    const a = callback.mock.calls[0]![0] as StreamEvent;
    const b = callback.mock.calls[1]![0] as StreamEvent;
    expect(a.toolActivity?.callId).toBeTruthy();
    expect(a.toolActivity!.callId).not.toBe(b.toolActivity!.callId);
    const upstream: StreamEvent = { ...event, toolActivity: { callId: 'upstream', operationId: 'op', generation: 2 } };
    outer(upstream);
    expect(callback.mock.calls[2]![0]).toMatchObject({ toolActivity: { callId: 'upstream', operationId: 'op', generation: 2 } });
    expect(upstream.toolActivity!.callId).toBe('upstream');
  });

  it('should preserve non-tool stream events without adding tool activity context', () => {
    const received: StreamEvent[] = [];
    const callback = withToolActivityCall((event) => received.push(event))!;
    const events: StreamEvent[] = [
      { type: 'text', data: { text: 'response' } },
      { type: 'thinking', data: { thinking: 'private thought' } },
      { type: 'result', data: { result: 'done', sessionId: 'session', success: true } },
    ];

    events.forEach(callback);

    expect(received).toEqual(events);
  });

  it('should leave absent callbacks absent', () => {
    expect(withToolActivityCall(undefined)).toBeUndefined();
  });
});
