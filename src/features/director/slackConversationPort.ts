import { randomUUID } from 'node:crypto';
import { conversationId } from '../../infra/conversations/identity.js';
import type { SlackClient, SlackThread } from '../../infra/slack/client.js';
import type { Language } from '../../core/models/types.js';
import { getLabel } from '../../shared/i18n/index.js';
import { createLogger } from '../../shared/utils/debug.js';
import { ConversationError } from '../manager/conversationErrors.js';
import type { ConversationDelivery, ConversationInput, ConversationPort } from '../manager/conversationPort.js';
import type { DirectorNotificationDelivery } from './notificationDelivery.js';

interface DirectorSlackEndpoint extends SlackThread { teamId: string; userId: string }
const log = createLogger('director-slack');

export function createDirectorSlackConversationPort(options: {
  channelId: string; input: ConversationInput; client: SlackClient; language: Language;
}) {
  const assignment = { kind: 'daemon' as const };
  const id = conversationId(assignment);
  const targets = new Map<string, { endpoint: DirectorSlackEndpoint; attachmentId: string }>();
  const attachments = new Set<string>();
  const admissions = new Set<Promise<void>>();
  const postings = new Set<Promise<unknown>>();
  let accepting = true;
  let closed = false;
  const detach = (attachmentId: string): void => {
    if (attachments.delete(attachmentId)) options.input.detach(attachmentId);
  };
  const postReply = async ({ channelId, parentTs }: SlackThread, text: string) => {
    const sending = options.client.postThreadMessage({ channelId, parentTs }, text);
    postings.add(sending);
    try { return await sending; }
    finally { postings.delete(sending); }
  };
  const port: ConversationPort<DirectorSlackEndpoint> = {
    async resolve(endpoint) {
      const key = JSON.stringify([endpoint.teamId, endpoint.channelId, endpoint.parentTs]);
      return { conversationId: id, assignment,
        binding: { port: 'slack', key, counterpart: { namespace: 'slack-thread', id: key } },
        speaker: { namespace: 'slack-user', id: JSON.stringify([endpoint.teamId, endpoint.userId]) },
      };
    },
    delivery: {
      async deliver(currentId, output, version) {
        if (output.kind === 'snapshot') output.read.cancel();
        if (currentId !== id || output.kind !== 'result' || version.operationId !== output.operationId) return { kind: 'delivered' };
        const target = targets.get(output.operationId);
        if (target === undefined) return { kind: 'delivered' };
        targets.delete(output.operationId);
        try {
          if (output.result.kind !== 'reply' && output.result.kind !== 'error') return { kind: 'delivered' };
          return await postReply(target.endpoint, output.result.message);
        } finally { detach(target.attachmentId); }
      },
    },
  };
  const receiveMessage = async (endpoint: DirectorSlackEndpoint, text: string): Promise<void> => {
    let attachmentId: string | undefined;
    let operationId: string | undefined;
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => { admitted = resolve; });
    const delivery: ConversationDelivery = { async deliver(...args) {
      const [, output] = args;
      if (output.kind === 'result') {
        // submit の完了前に届く結果も、その操作の返信先へ対応付ける。
        await admission;
        if (output.operationId !== operationId) return { kind: 'delivered' };
      }
      return port.delivery.deliver(...args);
    } };
    try {
      const resolved = await port.resolve(endpoint);
      if (!accepting) return;
      const opened = await options.input.open(resolved, delivery);
      attachmentId = opened.attachmentId;
      attachments.add(attachmentId);
      opened.read.cancel();
      if (!accepting) return;
      const submission = await options.input.submit({ attachmentId, requestId: randomUUID(), speaker: resolved.speaker,
        command: { kind: 'message', text } });
      if (submission.kind === 'accepted') {
        operationId = submission.operationId;
        targets.set(operationId, { endpoint, attachmentId });
        attachmentId = undefined;
      } else {
        const message = submission.kind === 'error' ? submission.message : getLabel('manager.conversation.busy', options.language);
        await postReply(endpoint, message);
      }
    } catch (error) {
      const code = error instanceof ConversationError ? error.code : 'operation_failed';
      await postReply(endpoint, getLabel(`manager.conversation.${code}`, options.language));
    } finally {
      admitted();
      if (attachmentId !== undefined) detach(attachmentId);
    }
  };
  const notifications: DirectorNotificationDelivery = {
    async deliver(batch) {
      if (closed || batch.length === 0) return;
      const text = [getLabel('director.slackNotifications', options.language), ...batch.map((notice) => notice.message)].join('\n\n');
      const sending = (async () => {
        const result = await options.client.postMessage(options.channelId, text, []);
        if (result.kind === 'unavailable') log.error('Cannot post director Slack notifications');
      })();
      postings.add(sending);
      try { await sending; }
      finally { postings.delete(sending); }
    },
  };
  return { ...port, notifications,
    receive(endpoint: DirectorSlackEndpoint, text: string): Promise<void> {
      if (!accepting) return Promise.resolve();
      const receiving = receiveMessage(endpoint, text);
      admissions.add(receiving);
      return receiving.finally(() => { admissions.delete(receiving); });
    },
    stopAccepting(): void { accepting = false; },
    async close(): Promise<void> {
      accepting = false;
      await Promise.allSettled([...admissions]);
      closed = true;
      await Promise.allSettled([...postings]);
      targets.clear();
      for (const attachmentId of attachments) detach(attachmentId);
    },
  };
}
