import { createConnection } from 'node:net';
import type { DaemonOwner } from '../../infra/daemon/owner.js';
import {
  conversationIpcEndpoint,
  ipcStateMatchesOwner,
  readDaemonIpcState,
  type DaemonIpcState,
} from '../../infra/daemon/ipcEndpoint.js';
import { ConversationFrameDecoder, encodeConversationFrame } from './conversationFrames.js';
import { z } from 'zod/v4';

const helloResponse = z.object({ protocolVersion: z.literal(1), type: z.literal('response'), requestId: z.literal('readiness'),
  result: z.object({ owner: z.object({ pid: z.number(), identity: z.object({ startTime: z.string() }), version: z.string(), cliPath: z.string() }) }) });

export async function isConversationIpcReady(configDirectory: string, owner: DaemonOwner): Promise<boolean> {
  let state: DaemonIpcState | undefined;
  try { state = readDaemonIpcState(configDirectory); }
  catch { return false; }
  if (state === undefined || !ipcStateMatchesOwner(state, owner)
    || state.endpoint !== conversationIpcEndpoint(configDirectory, process.platform, process.getuid?.() ?? 0)) return false;
  return new Promise((resolve) => {
    const socket = createConnection(state.endpoint);
    const finish = (ready: boolean): void => { clearTimeout(timer); socket.destroy(); resolve(ready); };
    const timer = setTimeout(() => finish(false), 500);
    const decoder = new ConversationFrameDecoder();
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
    socket.once('connect', () => socket.write(encodeConversationFrame({ protocolVersion: 1, type: 'request', requestId: 'readiness',
      method: 'hello', params: { capability: state.capability } })));
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const value of decoder.decode(chunk)) {
          const response = helloResponse.parse(value);
          finish(ipcStateMatchesOwner({ ...state, owner: response.result.owner }, owner));
        }
      } catch { finish(false); }
    });
  });
}
