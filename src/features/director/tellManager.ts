import { ConversationIpcClient } from '../manager/conversationIpcClient.js';
import { createDirectorManagerPort } from './managerPort.js';
import { resolveDirectorManager } from './managers.js';

export async function tellDirectorManager(configDirectory: string, managerId: string, text: string, signal: AbortSignal) {
  const assignment = await resolveDirectorManager(configDirectory, managerId);
  const port = createDirectorManagerPort(configDirectory, { deliver: async () => ({ kind: 'unavailable', reason: 'IPC delivery only' }) });
  const identity = assignment.kind === 'workspace' ? { kind: 'workspace' as const, workspaceId: assignment.workspaceId }
    : { kind: 'repository' as const, repositoryDirectory: assignment.repositoryDirectory };
  const client = new ConversationIpcClient(identity, undefined, { port, reconnect: false });
  try {
    signal.throwIfAborted();
    try { await client.connect(); }
    catch (error) { if (error instanceof Error && error.cause === 'busy') return { kind: 'busy' as const }; throw error; }
    signal.throwIfAborted();
    const submission = await client.submit({ kind: 'message', text });
    return submission.kind === 'accepted' ? { ...submission, managerId } : submission;
  } finally {
    client.close();
  }
}
