import { createConnection, type Socket } from 'node:net';
import type { DaemonOwner } from '../../infra/daemon/owner.js';
import {
  conversationIpcEndpoint,
  DaemonIpcStateSchema,
  ipcStateMatchesOwner,
  readDaemonIpcState,
  type DaemonIpcState,
} from '../../infra/daemon/ipcEndpoint.js';
import { ConversationFrameDecoder, encodeConversationFrame } from './conversationFrames.js';
import { z } from 'zod/v4';

const helloResponse = z.object({ protocolVersion: z.literal(1), type: z.literal('response'), requestId: z.literal('readiness'),
  result: z.object({ owner: DaemonIpcStateSchema.shape.owner }).strict() }).strict();

export async function isConversationIpcReady(configDirectory: string, owner: DaemonOwner): Promise<boolean> {
  const socket = await connectConversationIpc(configDirectory, owner);
  if (socket === undefined) return false;
  socket.destroy();
  return true;
}

/** 認証済みの接続を一時停止して返す。呼出し元が受信処理の登録と解放を所有する。 */
export async function connectConversationIpc(configDirectory: string, owner: DaemonOwner): Promise<Socket | undefined> {
  let state: DaemonIpcState | undefined;
  try { state = await readDaemonIpcState(configDirectory); }
  catch { return undefined; }
  if (state === undefined || !ipcStateMatchesOwner(state, owner)
    || state.endpoint !== conversationIpcEndpoint(configDirectory, process.platform, process.getuid?.() ?? 0)) return undefined;
  return new Promise((resolve) => {
    const socket = createConnection(state.endpoint);
    // 引き継ぎ待ちに error が発生しても未処理例外にせず、接続を閉じる。
    socket.on('error', () => socket.destroy());
    let finished = false;
    const finish = (ready: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (ready) socket.pause();
      else socket.destroy();
      resolve(ready ? socket : undefined);
    };
    const timer = setTimeout(() => finish(false), 500);
    const decoder = new ConversationFrameDecoder();
    const onError = (): void => finish(false);
    const onClose = (): void => finish(false);
    const onConnect = (): void => {
      socket.write(encodeConversationFrame({ protocolVersion: 1, type: 'request', requestId: 'readiness',
        method: 'hello', params: { capability: state.capability } }));
    };
    const onData = (chunk: Buffer): void => {
      try {
        for (const value of decoder.decode(chunk)) {
          const response = helloResponse.parse(value);
          finish(ipcStateMatchesOwner({ ...state, owner: response.result.owner }, owner));
        }
      } catch { finish(false); }
    };
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('connect', onConnect);
    socket.on('data', onData);
  });
}
