import { randomUUID } from 'node:crypto';
import { conversationId } from '../../infra/conversations/identity.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';
import type { SlackClient, SlackThread } from '../../infra/slack/client.js';
import { getLabel } from '../../shared/i18n/index.js';
import { resolveCurrentManagerAssignment } from './assignment.js';
import { ConversationError } from './conversationErrors.js';
import type { ConversationDelivery, ConversationInput, ConversationPort } from './conversationPort.js';

export interface SlackEndpoint extends SlackThread { teamId: string; userId: string }

export function createSlackConversationPort(options: {
  repositoryDirectory: string; configDirectory: string; input: ConversationInput; client: SlackClient; language: 'ja' | 'en';
}) {
  const targets = new Map<string, { endpoint: SlackEndpoint; attachmentId: string }>();
  const attachments = new Set<string>();
  let accepting = true;
  const detach = (id: string): void => { attachments.delete(id); options.input.detach(id); };
  const port: ConversationPort<SlackEndpoint> = {
    async resolve(endpoint) {
      const repositoryDirectory = await resolveGitRepositoryDirectory(options.repositoryDirectory);
      const current = await resolveCurrentManagerAssignment({ kind: 'repository', repositoryDirectory }, options.configDirectory);
      const assignment: ConversationAssignment = current.kind === 'workspace'
        ? { kind: 'workspace', workspaceId: current.workspaceId }
        : { kind: 'repository', repositoryDirectory: current.repositoryDirectory };
      const key = JSON.stringify([endpoint.teamId, endpoint.channelId, endpoint.parentTs]);
      return { conversationId: conversationId(assignment), assignment,
        binding: { port: 'slack', key, counterpart: { namespace: 'slack-thread', id: key } },
        speaker: { namespace: 'slack-user', id: JSON.stringify([endpoint.teamId, endpoint.userId]) } };
    },
    delivery: {
      async deliver(_conversationId, output) {
        if (output.kind === 'snapshot') {
          await output.read.items[Symbol.asyncIterator]().return?.();
        }
        if (output.kind !== 'result') return { kind: 'delivered' };
        const target = targets.get(output.operationId);
        if (target === undefined) return { kind: 'delivered' };
        targets.delete(output.operationId);
        try {
          if (output.result.kind !== 'reply' && output.result.kind !== 'error') return { kind: 'delivered' };
          return await options.client.postThreadMessage(target.endpoint, output.result.message);
        } finally { detach(target.attachmentId); }
      },
    },
  };
  return {
    ...port,
    async receive(endpoint: SlackEndpoint, text: string): Promise<void> {
      if (!accepting) return;
      let attachmentId: string | undefined;
      let admitted!: () => void;
      const admission = new Promise<void>((resolve) => { admitted = resolve; });
      // A fast executor may publish its result before submit returns its operation ID.
      const delivery: ConversationDelivery = { deliver: async (...args) => {
        await admission;
        return port.delivery.deliver(...args);
      } };
      try {
        const resolved = await port.resolve(endpoint);
        const opened = await options.input.open(resolved, delivery);
        attachmentId = opened.attachmentId;
        attachments.add(attachmentId);
        const iterator = opened.read.items[Symbol.asyncIterator]();
        try { await iterator.next(); }
        finally { await iterator.return?.(); }
        const submission = await options.input.submit({ attachmentId, requestId: randomUUID(), speaker: resolved.speaker,
          command: { kind: 'message', text } });
        if (submission.kind === 'accepted') {
          targets.set(submission.operationId, { endpoint, attachmentId });
          attachmentId = undefined;
        } else {
          const message = submission.kind === 'error' ? submission.message : getLabel('manager.conversation.busy', options.language);
          await options.client.postThreadMessage(endpoint, message);
        }
      } catch (error) {
        const key = error instanceof ConversationError ? error.code : 'operation_failed';
        await options.client.postThreadMessage(endpoint, getLabel(`manager.conversation.${key}`, options.language));
      } finally {
        admitted();
        if (attachmentId !== undefined) detach(attachmentId);
      }
    },
    stopAccepting() { accepting = false; },
    close() {
      accepting = false;
      targets.clear();
      for (const id of attachments) detach(id);
    },
  };
}
