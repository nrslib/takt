import { realpath, stat } from 'node:fs/promises';
import { WaitCommandInputSchema } from '../../core/daemon/waitCommand.js';
import { isAbsolute, relative, sep } from 'node:path';
import type { DaemonWaitCommands } from './waitCommands.js';
import type { DaemonIngress, DaemonStateOwner } from '../../core/daemon/ports.js';
import type { DaemonStateReply } from '../../core/daemon/processProtocol.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { DaemonPersistedFiles } from '../../infra/daemon/persistedFiles.js';
import { DaemonConversations } from './conversationState.js';
import { inquiryAnswerEvent } from './inquiryAnswerEvent.js';
import { hasCode } from '../../infra/daemon/privateFile.js';

export function createDaemonStateRequests(options: {
  conversations: DaemonConversations;
  waitCommands?: DaemonWaitCommands;
  ingress: Pick<DaemonIngress, 'accept'>;
  connectedPorts(id: string): readonly string[];
}): DaemonStateOwner {
  const { conversations } = options;
  const forbidden = (): DaemonStateReply => ({ kind: 'error', code: 'forbidden', message: 'Conversation is outside the current assignment' });
  return { async handle(turn, request, signal) {
    signal.throwIfAborted();
    if (request.kind === 'save_conversation') return conversations.store.save(turn, request.change, signal);
    const source = await conversations.store.read(turn.conversationId);
    if (request.kind === 'wait_command') {
      const owner = source?.state.assignment;
      if (owner === undefined || owner.kind === 'daemon' || turn.conversationId !== conversationId(owner)
        || !await conversations.routing.permits(owner, turn.conversationId)) return forbidden();
      if (options.waitCommands === undefined) throw new Error('Wait commands are unavailable');
      const input = WaitCommandInputSchema.parse({ command: request.command, description: request.description, cwd: request.cwd,
        timeoutSeconds: request.timeoutSeconds, ...(request.goalId === undefined ? {} : { goalId: request.goalId }) });
      const assignment = await conversations.routing.display(owner);
      if (assignment.kind === 'daemon') return forbidden();
      const cwd = await realpath(input.cwd);
      let repositoryDirectory: string | undefined;
      for (const directory of assignment.repositoryDirectories) {
        let root: string;
        try { root = await realpath(directory); }
        catch (error) { if (hasCode(error, 'ENOENT')) continue; throw error; }
        const path = relative(root, cwd);
        if (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)) {
          repositoryDirectory = directory;
          break;
        }
      }
      if (repositoryDirectory === undefined) return forbidden();
      if (!(await stat(cwd)).isDirectory()) throw new Error('cwd must be a directory');
      const id = await options.waitCommands.register(turn.conversationId, repositoryDirectory, { ...input, cwd }, signal);
      return { kind: 'wait_command_registered', id };
    }
    if (request.kind === 'publish_workspace_inquiry_answer') {
      const owner = source?.state.assignment;
      if (owner?.kind !== 'workspace' || turn.conversationId !== conversationId(owner)
        || !await conversations.routing.permits(owner, turn.conversationId)) return forbidden();
      const question = await new DaemonPersistedFiles(conversations.routing.directory).readWorkspaceInquiry(owner.workspaceId, request.questionId);
      if (question.status !== 'answered' || question.answer === undefined) return forbidden();
      signal.throwIfAborted();
      const id = `workspace-answer-${owner.workspaceId}-${question.id}`;
      const admission = await options.ingress.accept({ eventId: id, requestId: id, conversationId: turn.conversationId,
        occurredAt: question.answer.answeredAt, source: 'director',
        event: inquiryAnswerEvent(question.id, question.answer, question.body) });
      return { kind: 'event_accepted', admission };
    }
    if (source?.state.assignment.kind !== 'daemon' || turn.conversationId !== conversationId({ kind: 'daemon' })) return forbidden();
    if (request.kind === 'notify_director') {
      const saved = await conversations.notifications.save({ id: request.notificationId, message: request.message, subject: request.subject, turnOperationId: turn.operationId }, signal);
      if (saved) conversations.send(turn.conversationId, { kind: 'notice', id: request.notificationId, message: request.message },
        { revision: source.state.revision, stateSequence: source.state.version, operationId: turn.operationId });
      return { kind: 'notification_saved', notificationId: request.notificationId };
    }
    const target = await conversations.store.read(request.conversationId);
    if (target === undefined || target.state.assignment.kind === 'daemon'
      || !await conversations.routing.permits(target.state.assignment, request.conversationId)) return forbidden();
    signal.throwIfAborted();
    if (request.kind === 'get_delivery') return { kind: 'delivery', conversationId: request.conversationId,
      assignment: target.state.assignment, connectedPorts: [...options.connectedPorts(request.conversationId)] };
    const admission = await options.ingress.accept({ eventId: request.eventId, requestId: request.requestId, conversationId: request.conversationId,
      occurredAt: request.occurredAt, source: 'director', event: { kind: 'director_message', directorConversationId: turn.conversationId, text: request.text, origin: request.origin } });
    return { kind: 'event_accepted', admission };
  } };
}
