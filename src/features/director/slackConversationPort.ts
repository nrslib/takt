import { randomUUID } from 'node:crypto';
import { conversationId } from '../../infra/conversations/identity.js';
import type { SlackClient, SlackThread } from '../../infra/slack/client.js';
import type { Language } from '../../core/models/types.js';
import { getLabel } from '../../shared/i18n/index.js';
import { reportDaemonError } from '../../infra/daemon/diagnostics.js';
import { ConversationError } from '../manager/conversationErrors.js';
import type { ConversationDelivery, ConversationInput, ConversationPort } from '../manager/conversationPort.js';
import type { DirectorNotificationDelivery } from './notificationDelivery.js';
import { SlackInquiryBindings, slackInquiryKey } from '../../infra/slack/inquiryBindings.js';
import { createSlackInquiryDelivery } from '../manager/slackInquiryDelivery.js';
import { buildSlackInquiry, SLACK_INQUIRY_ACTION } from '../manager/slackInquiryBlocks.js';
import type { ConversationCommand, QuestionTarget } from '../manager/conversationPort.js';
import { buildSlackGoalProposal, parseSlackGoalProposal, SLACK_GOAL_APPROVE, SLACK_GOAL_DISMISS } from '../manager/slackGoalProposal.js';
import type { ConversationRecord, PendingSummary } from '../../infra/conversations/schema.js';
import type { SlackDeliveryResult } from '../../infra/slack/client.js';

interface DirectorSlackEndpoint extends SlackThread { teamId: string; userId: string }


export function createDirectorSlackConversationPort(options: {
  channelId: string; configDirectory: string; input: ConversationInput; client: SlackClient; language: Language;
}) {
  const assignment = { kind: 'daemon' as const };
  const id = conversationId(assignment);
  const bindings = new SlackInquiryBindings(options.configDirectory, id);
  const inquiryDelivery = createSlackInquiryDelivery({ ...options, bindings });
  const targets = new Map<string, { endpoint: DirectorSlackEndpoint; attachmentId: string }>();
  const attachments = new Set<string>();
  const admissions = new Set<Promise<void>>();
  const postings = new Set<Promise<unknown>>();
  let accepting = true;
  let closed = false;
  const proposalPosts: SlackThread[] = [];
  let proposalState: { revision: number; delivered: boolean } | null = null;
  let proposalDelivery = Promise.resolve<SlackDeliveryResult>({ kind: 'delivered' });
  const updateProposal = (pending: PendingSummary | null, approval: ConversationRecord['approval'], terminal?: string): Promise<SlackDeliveryResult> => {
    const sending = proposalDelivery.then(async (): Promise<SlackDeliveryResult> => {
      if (closed) return { kind: 'unavailable', reason: 'Slack port closed' };
      if (terminal === undefined && pending?.revision === proposalState?.revision && proposalState?.delivered) return { kind: 'delivered' };
      if (pending === null) {
        if (terminal === undefined && proposalState === null) return { kind: 'delivered' };
        const text = terminal ?? (approval?.state === 'registered' && approval.revision === proposalState?.revision
          ? getLabel('director.slackGoalRegistered', options.language, { id: approval.goalId })
          : getLabel('manager.slackGoalDismiss', options.language));
        for (const thread of proposalPosts) {
          const result = await options.client.updateMessage(thread, text, []);
          if (result.kind === 'unavailable') return result;
        }
        proposalState = null;
        return { kind: 'delivered' };
      }
      proposalState = { revision: pending.revision, delivered: false };
      const messages = buildSlackGoalProposal(id, pending, options.language);
      for (let index = 0; index < Math.max(messages.length, proposalPosts.length); index++) {
        const message = messages[index];
        const thread = proposalPosts[index];
        if (thread !== undefined) {
          const result = await options.client.updateMessage(thread, message?.text ?? getLabel('manager.summary.title', options.language), message?.blocks ?? []);
          if (result.kind === 'unavailable') return result;
        } else if (message !== undefined) {
          const result = await options.client.postMessage(options.channelId, message.text, message.blocks);
          if (result.kind === 'unavailable') return result;
          proposalPosts.push({ channelId: options.channelId, parentTs: result.parentTs });
        }
      }
      proposalState = { revision: pending.revision, delivered: true };
      return { kind: 'delivered' };
    });
    proposalDelivery = sending.catch(() => ({ kind: 'unavailable', reason: 'Slack proposal unavailable' }));
    postings.add(sending);
    return sending.finally(() => { postings.delete(sending); });
  };
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
        if (currentId === id && output.kind === 'pending') return updateProposal(output.state.pending, output.state.approval);
        if (currentId === id && output.kind === 'inquiry' && output.target.goalId !== null) {
          if (!accepting) return { kind: 'unavailable', reason: 'Slack port closed' };
          return inquiryDelivery.deliver(output.target, output.question, () => accepting);
        }
        if (currentId !== id || output.kind !== 'result' || version.operationId !== output.operationId
          || output.result.kind !== 'goal_registered') return { kind: 'delivered' };
        const goal = output.result.goal;
        return updateProposal(null, null, getLabel('manager.goalRegistered', options.language,
          { name: goal.objective, id: goal.id, branch: goal.branch }));
      },
    },
  };
  const receiveMessage = async (endpoint: DirectorSlackEndpoint, command: ConversationCommand, requestId: string): Promise<void> => {
    let attachmentId: string | undefined;
    let operationId: string | undefined;
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => { admitted = resolve; });
    const delivery: ConversationDelivery = { async deliver(...args) {
      const [currentId, output, version] = args;
      if (output.kind === 'pending') return { kind: 'delivered' };
      if (output.kind !== 'result') return port.delivery.deliver(...args);
      // submit の完了前に届く結果も、その操作の返信先へ対応付ける。
      await admission;
      if (currentId !== id || version.operationId !== output.operationId || output.operationId !== operationId) return { kind: 'delivered' };
      const target = targets.get(output.operationId);
      if (target === undefined) return { kind: 'delivered' };
      targets.delete(output.operationId);
      try {
        return output.result.kind === 'goal_registered' ? { kind: 'delivered' }
          : await postReply(target.endpoint, output.result.message);
      } finally { detach(target.attachmentId); }
    } };
    try {
      const resolved = await port.resolve(endpoint);
      if (!accepting) return;
      const opened = await options.input.open(resolved, delivery);
      attachmentId = opened.attachmentId;
      attachments.add(attachmentId);
      opened.read.cancel();
      if (!accepting) return;
      const submission = await options.input.submit({ attachmentId, requestId, speaker: resolved.speaker,
        command });
      if (submission.kind === 'accepted') {
        if (targets.has(submission.operationId)) return;
        operationId = submission.operationId;
        targets.set(operationId, { endpoint, attachmentId });
        attachmentId = undefined;
        await postReply(endpoint, options.language === 'ja' ? '受け付けて保存しました。' : 'Accepted and saved.');
      } else {
        const message = submission.message;
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
  const loadInquiry = async (endpoint: DirectorSlackEndpoint, target: QuestionTarget, questionId: string) => {
    if (endpoint.channelId !== options.channelId || target.goalId === null) return undefined;
    const resolved = await port.resolve(endpoint);
    const opened = await options.input.open(resolved, port.delivery);
    try {
      for await (const item of opened.read.items) {
        if (item.kind !== 'inquiry' || slackInquiryKey(item.inquiry.target, item.inquiry.question.id) !== slackInquiryKey(target, questionId)) continue;
        const question = item.inquiry.question;
        if (question.status !== 'pending' || question.recipient !== 'human') return undefined;
        return { ...target, objective: item.inquiry.objective ?? question.body, question };
      }
      return undefined;
    } finally { opened.read.cancel(); options.input.detach(opened.attachmentId); }
  };
  const receive = async (endpoint: DirectorSlackEndpoint, text: string, requestId: string) => {
    const binding = await bindings.find(endpoint.channelId, endpoint.parentTs);
    if (binding === undefined) return receiveMessage(endpoint, { kind: 'message', text }, requestId);
    const current = await loadInquiry(endpoint, binding.target, binding.questionId);
    if (current?.question.kind !== 'question') return;
    return receiveMessage(endpoint, { kind: 'answer_question', target: binding.target, questionId: binding.questionId, answer: { text }, source: 'slack' }, requestId);
  };
  const receiveAction = async (endpoint: DirectorSlackEndpoint, actionId: string, value: string, requestId: string) => {
    if (endpoint.channelId !== options.channelId) return;
    if (actionId === SLACK_GOAL_APPROVE || actionId === SLACK_GOAL_DISMISS) {
      const proposal = parseSlackGoalProposal(value);
      if (proposal?.conversationId !== id) return;
      return receiveMessage(endpoint, actionId === SLACK_GOAL_APPROVE
        ? { kind: 'approve_summary', revision: proposal.revision, requirePending: true }
        : { kind: 'dismiss_summary', revision: proposal.revision }, requestId);
    }
    const binding = await bindings.find(endpoint.channelId, endpoint.parentTs);
    if (binding === undefined || actionId !== `${SLACK_INQUIRY_ACTION}_${value}`) return;
    const current = await loadInquiry(endpoint, binding.target, binding.questionId);
    if (current === undefined) return;
    const action = buildSlackInquiry(current, options.language, slackInquiryKey(binding.target, binding.questionId)).actions.get(value);
    if (action === undefined) return;
    return receiveMessage(endpoint, { kind: 'answer_question', target: binding.target, questionId: binding.questionId, answer: action.answer, source: 'slack' }, requestId);
  };
  const notifications: DirectorNotificationDelivery = {
    async deliver(batch) {
      if (closed || batch.length === 0) return;
      const text = [getLabel('director.slackNotifications', options.language), ...batch.map((notice) => notice.message)].join('\n\n');
      const sending = (async () => {
        const result = await options.client.postMessage(options.channelId, text, []);
        if (result.kind === 'unavailable') reportDaemonError('Cannot post director Slack notifications');
      })();
      postings.add(sending);
      try { await sending; }
      finally { postings.delete(sending); }
    },
  };
  return { ...port, notifications,
    async isInquiryThread(channelId: string, parentTs: string): Promise<boolean> { return await bindings.find(channelId, parentTs) !== undefined; },
    receiveAction(endpoint: DirectorSlackEndpoint, actionId: string, value: string, requestId: string = randomUUID()): Promise<void> {
      if (!accepting) return Promise.resolve();
      const receiving = receiveAction(endpoint, actionId, value, requestId);
      admissions.add(receiving);
      return receiving.finally(() => { admissions.delete(receiving); });
    },
    receive(endpoint: DirectorSlackEndpoint, text: string, requestId: string = randomUUID()): Promise<void> {
      if (!accepting) return Promise.resolve();
      const receiving = receive(endpoint, text, requestId);
      admissions.add(receiving);
      return receiving.finally(() => { admissions.delete(receiving); });
    },
    stopAccepting(): void { accepting = false; },
    async close(): Promise<void> {
      accepting = false;
      await Promise.allSettled([...admissions]);
      await inquiryDelivery.close();
      closed = true;
      await Promise.allSettled([...postings]);
      targets.clear();
      for (const attachmentId of attachments) detach(attachmentId);
    },
  };
}
