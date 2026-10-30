import { ConversationIpcClient } from '../manager/conversationIpcClient.js';
import type { OperationResult, Submission } from '../manager/conversationPort.js';
import { createDirectorManagerPort } from './managerPort.js';
import { resolveDirectorManager } from './managers.js';

export async function tellDirectorManager(configDirectory: string, managerId: string, text: string, signal: AbortSignal): Promise<Submission | OperationResult | { kind: 'busy' }> {
  const assignment = await resolveDirectorManager(configDirectory, managerId);
  const port = createDirectorManagerPort(configDirectory, { deliver: async () => ({ kind: 'unavailable', reason: 'IPC delivery only' }) });
  const identity = assignment.kind === 'workspace' ? { kind: 'workspace' as const, workspaceId: assignment.workspaceId }
    : { kind: 'repository' as const, repositoryDirectory: assignment.repositoryDirectory };
  const client = new ConversationIpcClient(identity, undefined, { port, reconnect: false });
  let unsubscribe = () => {};
  let unwatch = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    signal.throwIfAborted();
    try { await client.connect(); }
    catch (error) { if (error instanceof Error && error.cause === 'busy') return { kind: 'busy' }; throw error; }
    signal.throwIfAborted();
    let operationId: string | undefined;
    let finish!: (result: OperationResult) => void;
    let fail!: (error: Error) => void;
    const reply = new Promise<OperationResult>((resolve, reject) => { finish = resolve; fail = reject; });
    void reply.catch(() => {});
    // Attach both observers before submit: accepted and result can share a socket chunk.
    unsubscribe = client.onOutput((output) => {
      if (output.kind === 'result' && output.operationId === operationId) finish(output.result);
    });
    unwatch = client.subscribe(() => {
      if (client.getSnapshot().connection === 'disconnected') fail(new Error('Manager connection lost; the accepted message is not resent'));
    });
    const abort = (): void => fail(new Error('Director request cancelled; the accepted manager turn continues'));
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => fail(new Error('Manager reply timed out; the accepted message is not resent')), 30 * 60 * 1000);
    try {
      const submission = await client.submit({ kind: 'message', text }, (id) => { operationId = id; });
      if (submission.kind !== 'accepted') return submission;
      return await reply;
    } finally { signal.removeEventListener('abort', abort); }
  } finally {
    clearTimeout(timer);
    unsubscribe(); unwatch(); client.close();
  }
}
