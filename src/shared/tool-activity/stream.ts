import { randomUUID } from 'node:crypto';
import type { StreamCallback } from '../types/provider.js';

export function withToolActivityCall(callback: StreamCallback | undefined): StreamCallback | undefined {
  if (callback === undefined) return undefined;
  const callId = randomUUID();
  return (event) => callback({ ...event, toolActivity: { ...event.toolActivity, callId } });
}
