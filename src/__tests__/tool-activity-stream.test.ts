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

  it('should use different identities for separate provider attempts and retain supplied turn context', () => {
    const callback = vi.fn();
    const first = withToolActivityCall(callback)!;
    const second = withToolActivityCall(callback)!;
    const event: StreamEvent = { type: 'text', data: { text: 'response' }, toolActivity: { callId: 'upstream', operationId: 'op', generation: 2 } };
    first(event); second(event);
    const a = callback.mock.calls[0]![0] as StreamEvent;
    const b = callback.mock.calls[1]![0] as StreamEvent;
    expect(a.toolActivity).toMatchObject({ operationId: 'op', generation: 2 });
    expect(a.toolActivity!.callId).not.toBe(b.toolActivity!.callId);
    expect(event.toolActivity!.callId).toBe('upstream');
  });

  it('should leave absent callbacks absent', () => {
    expect(withToolActivityCall(undefined)).toBeUndefined();
  });
});
