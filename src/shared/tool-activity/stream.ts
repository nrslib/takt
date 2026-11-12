import { randomUUID } from 'node:crypto';
import type { StreamCallback } from '../types/provider.js';

export function withToolActivityCall(callback: StreamCallback | undefined): StreamCallback | undefined {
  if (callback === undefined) return undefined;
  const callId = randomUUID();
  return (event) => {
    if (event.type !== 'tool_use' && event.type !== 'tool_output' && event.type !== 'tool_result') {
      callback(event);
      return;
    }
    callback({ ...event, toolActivity: { ...event.toolActivity, callId: event.toolActivity?.callId ?? callId } });
  };
}
