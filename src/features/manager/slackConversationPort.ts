import { realpath } from 'node:fs/promises';
import { AsyncCommand } from '../../infra/daemon/command.js';
import { buildSafeGitEnvironment } from '../../infra/task/git-environment.js';
import type { GoalQuestion } from '../../infra/goals/schema.js';
import type { ManagerAssignment } from './startupResolution.js';
import { randomUUID } from 'node:crypto';
import { conversationId } from '../../infra/conversations/identity.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import type { SlackClient, SlackThread } from '../../infra/slack/client.js';
import { getLabel } from '../../shared/i18n/index.js';
import { escapeSlackMentions } from '../../shared/utils/slackText.js';
import { conversationErrorResult } from './conversationErrors.js';
import type { ConversationDelivery, ConversationInput, ConversationPort, ConversationCommand, QuestionTarget } from './conversationPort.js';
import { SlackInquiryBindings, slackInquiryKey } from '../../infra/slack/inquiryBindings.js';
import type { PendingQuestion } from './inquiryAnswer.js';
import { buildSlackInquiry, SLACK_INQUIRY_ACTION } from './slackInquiryBlocks.js';
import { createSlackInquiryDelivery } from './slackInquiryDelivery.js';
import { formatGoalName } from './goalDisplay.js';
import { buildSlackGoalProposal, parseSlackGoalProposal, SLACK_GOAL_APPROVE, SLACK_GOAL_DISMISS } from './slackGoalProposal.js';
import type { MarkdownBlock } from '@slack/types';

export { SLACK_GOAL_APPROVE, SLACK_GOAL_DISMISS } from './slackGoalProposal.js';

export interface SlackEndpoint extends SlackThread { teamId: string; userId: string }

const MARKDOWN_MESSAGE_LIMIT = 12_000;

export function createSlackConversationPort(options: {
  repositoryDirectory: string; configDirectory: string; resolveAssignment(): Promise<ManagerAssignment>; channelId: string; input: ConversationInput; client: SlackClient; language: 'ja' | 'en';
}) {
  const targets = new Map<string, { endpoint: SlackEndpoint; attachmentId: string; conversationId: string; makeGoal: boolean }>();
  const attachments = new Set<string>();
  const bindings = new SlackInquiryBindings(options.configDirectory, options.repositoryDirectory);
  const inquiryDelivery = createSlackInquiryDelivery({ ...options, bindings });
  const messageFor = (current: { pending: PendingQuestion }) => {
    return buildSlackInquiry(current.pending, options.language, randomUUID());
  };
  let accepting = true;
  const detach = (id: string): void => { attachments.delete(id); options.input.detach(id); };
  const ownsInquiry = (target: QuestionTarget, assignment: ConversationAssignment): boolean => target.goalId === null
    ? conversationId(target.owner) === conversationId(assignment)
    : target.repositoryDirectory === options.repositoryDirectory;
  const matchesInquiryRepository = async (target: QuestionTarget, question: GoalQuestion, assignment: ConversationAssignment): Promise<boolean> => {
    if (!ownsInquiry(target, assignment)) return false;
    if (target.goalId !== null || question.operation === undefined) return true;
    const cwd = question.operation.cwd;
    const result = await new AsyncCommand().run({ executable: 'git', args: ['rev-parse', '--show-toplevel'], cwd,
      env: await buildSafeGitEnvironment(cwd, { allowGitHooks: false, allowGitFilters: false }), maxOutputBytes: 16 * 1024 },
    { signal: new AbortController().signal, timeoutMs: 5000 });
    if (result.code !== 0 || result.truncated) throw new Error('Cannot resolve inquiry repository');
    return await realpath(Buffer.from(result.stdout).toString('utf8').replace(/\r?\n$/u, '')) === options.repositoryDirectory;
  };
  const findInquiryBinding = (channelId: string, parentTs: string) => bindings.find(channelId, parentTs);
  const resolveEndpoint = (endpoint: SlackEndpoint, assignment: ConversationAssignment) => {
    const key = JSON.stringify([endpoint.teamId, endpoint.channelId, endpoint.parentTs]);
    return { conversationId: conversationId(assignment), assignment,
      binding: { port: 'slack', key, counterpart: { namespace: 'slack-thread', id: key } },
      speaker: { namespace: 'slack-user', id: JSON.stringify([endpoint.teamId, endpoint.userId]) } };
  };
  const resolveInquiryEndpoint = async (endpoint: SlackEndpoint, target: QuestionTarget) =>
    target.goalId === null && target.owner.kind === 'workspace'
      ? resolveEndpoint(endpoint, target.owner) : port.resolve(endpoint);
  const loadInquiry = async (endpoint: SlackEndpoint, target: QuestionTarget, questionId: string) => {
    if (endpoint.channelId !== options.channelId) return undefined;
    const resolved = await resolveInquiryEndpoint(endpoint, target);
    const { assignment } = resolved;
    if (!ownsInquiry(target, assignment)) return undefined;
    const opened = await options.input.open(resolved, port.delivery);
    try {
      for await (const item of opened.read.items) {
        if (item.kind === 'inquiry' && item.inquiry.question.id === questionId
          && slackInquiryKey(item.inquiry.target, questionId) === slackInquiryKey(target, questionId)) {
          const question = item.inquiry.question;
          if (question.status !== 'pending' || question.recipient !== 'human' || !await matchesInquiryRepository(target, question, assignment)) return undefined;
          const pending: PendingQuestion = target.goalId === null ? { ...target, question }
            : { ...target, question, objective: item.inquiry.objective ?? question.body };
          return { pending };
        }
      }
      return undefined;
    } finally { opened.read.cancel(); options.input.detach(opened.attachmentId); }
  };
  const port: ConversationPort<SlackEndpoint> = {
    async resolve(endpoint) {
      const current = await options.resolveAssignment();
      const assignment: ConversationAssignment = current.kind === 'workspace'
        ? { kind: 'workspace', workspaceId: current.workspaceId }
        : { kind: 'repository', repositoryDirectory: current.repositoryDirectory };
      return resolveEndpoint(endpoint, assignment);
    },
    delivery: {
      async deliver(currentConversationId, output, version) {
        if (output.kind === 'snapshot') {
          output.read.cancel();
        }
        if (output.kind === 'inquiry') {
          if (!accepting) return { kind: 'unavailable', reason: 'Slack port closed' };
          const assignment = await options.resolveAssignment();
          if (currentConversationId !== conversationId(assignment) || !await matchesInquiryRepository(output.target, output.question, assignment)) return { kind: 'delivered' };
          return inquiryDelivery.deliver(output.target, output.question, async () => {
            const current = await options.resolveAssignment();
            return accepting && currentConversationId === conversationId(current);
          });
        }
        if (output.kind === 'pending' && output.state.pending !== null && version.operationId !== null) {
          const target = targets.get(version.operationId);
          if (target === undefined || !target.makeGoal || target.conversationId !== currentConversationId
            || output.state.conversationId !== currentConversationId) return { kind: 'delivered' };
          for (const message of buildSlackGoalProposal(currentConversationId, output.state.pending, options.language)) {
            const result = await options.client.postThreadMessage(target.endpoint, message.text, message.blocks);
            if (result.kind !== 'delivered') {
              targets.delete(version.operationId);
              detach(target.attachmentId);
              return result;
            }
          }
          return { kind: 'delivered' };
        }
        if (output.kind !== 'result' || version.operationId !== output.operationId) return { kind: 'delivered' };
        const target = targets.get(output.operationId);
        if (target === undefined || target.conversationId !== currentConversationId) return { kind: 'delivered' };
        targets.delete(output.operationId);
        try {
          if (output.result.kind === 'goal_registered') {
            const goal = output.result.goal;
            return await options.client.postThreadMessage(target.endpoint, getLabel('manager.goalRegistered', options.language,
              { name: formatGoalName(goal.objective), id: goal.id, branch: goal.branch }));
          }
          if (output.result.kind !== 'reply' && output.result.kind !== 'notice' && output.result.kind !== 'error') return { kind: 'delivered' };
          const text = output.result.kind === 'error' ? escapeSlackMentions(output.result.message) : output.result.message;
          const blocks: MarkdownBlock[] | undefined = text.length <= MARKDOWN_MESSAGE_LIMIT ? [{ type: 'markdown', text }] : undefined;
          return await options.client.postThreadMessage(target.endpoint, text, blocks);
        } finally { detach(target.attachmentId); }
      },
    },
  };
  const submitCommand = async (endpoint: SlackEndpoint, command: ConversationCommand, makeGoal = false, expectedConversationId?: string, requestId: string = randomUUID()): Promise<void> => {
    if (!accepting || endpoint.channelId !== options.channelId) return;
    let attachmentId: string | undefined;
    let ownedOperationId: string | undefined;
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => { admitted = resolve; });
    // A fast executor may publish its result before submit returns its operation ID.
    const delivery: ConversationDelivery = { deliver: async (...args) => {
      await admission;
      const [, output, outputVersion] = args;
      if ((output.kind === 'pending' || output.kind === 'result') && outputVersion.operationId !== ownedOperationId) {
        return { kind: 'delivered' };
      }
      return port.delivery.deliver(...args);
    } };
    try {
      const resolved = command.kind === 'answer_question'
        ? await resolveInquiryEndpoint(endpoint, command.target) : await port.resolve(endpoint);
      if (command.kind === 'answer_question' && !ownsInquiry(command.target, resolved.assignment)) return;
      if (expectedConversationId !== undefined && resolved.conversationId !== expectedConversationId) return;
      if (command.kind === 'answer_question') {
        const key = JSON.stringify([endpoint.teamId, endpoint.channelId]);
        resolved.binding = { port: 'slack-inquiry', key, counterpart: { namespace: 'slack-channel', id: key } };
      }
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
        ownedOperationId = submission.operationId;
        targets.set(submission.operationId, { endpoint, attachmentId, conversationId: resolved.conversationId, makeGoal });
        attachmentId = undefined;
        await options.client.postThreadMessage(endpoint, options.language === 'ja' ? '受け付けて保存しました。' : 'Accepted and saved.');
      } else {
        const message = escapeSlackMentions(submission.message);
        await options.client.postThreadMessage(endpoint, message);
      }
    } catch (error) {
      await options.client.postThreadMessage(endpoint, escapeSlackMentions(conversationErrorResult(error, options.language).message));
    } finally {
      admitted();
      if (attachmentId !== undefined) detach(attachmentId);
    }
  };
  const receiver = {
    ...port,
    async isInquiryThread(channelId: string, parentTs: string): Promise<boolean> {
      return await findInquiryBinding(channelId, parentTs) !== undefined;
    },
    async receive(endpoint: SlackEndpoint, text: string, requestId?: string): Promise<void> {
      if (!accepting) return;
      const binding = await findInquiryBinding(endpoint.channelId, endpoint.parentTs);
      if (binding === undefined) {
        const makeGoal = text.trim() === '/make-goal';
        await submitCommand(endpoint, { kind: 'message', text: makeGoal ? getLabel('manager.goSummaryRequest', options.language) : text,
          ...(makeGoal ? { display: false, requestProposal: true } : {}) }, makeGoal, undefined, requestId);
        return;
      }
      const current = await loadInquiry(endpoint, binding.target, binding.questionId);
      if (current === undefined || current.pending.question.kind !== 'question') return;
      await submitCommand(endpoint, { kind: 'answer_question', target: binding.target, questionId: binding.questionId,
        answer: { text }, source: 'slack' }, false, undefined, requestId);
    },
    async receiveAction(endpoint: SlackEndpoint, actionId: string, value: string, requestId?: string): Promise<void> {
      if (!accepting) return;
      if (actionId === SLACK_GOAL_APPROVE || actionId === SLACK_GOAL_DISMISS) {
        const fields = parseSlackGoalProposal(value);
        if (fields === undefined) return;
        const revision = fields.revision;
        const command: ConversationCommand = actionId === SLACK_GOAL_APPROVE
          ? { kind: 'approve_summary', revision, conversationId: fields.conversationId, requirePending: true }
          : { kind: 'dismiss_summary', revision, conversationId: fields.conversationId };
        await submitCommand(endpoint, command, false, fields.conversationId, requestId);
        return;
      }
      const binding = await bindings.find(endpoint.channelId, endpoint.parentTs);
      if (binding === undefined) return;
      const current = await loadInquiry(endpoint, binding.target, binding.questionId);
      if (current === undefined || !accepting || actionId !== `${SLACK_INQUIRY_ACTION}_${value}`) return;
      const message = messageFor(current);
      const action = message.actions.get(value);
      if (action === undefined) return;
      await submitCommand(endpoint, { kind: 'answer_question', target: binding.target, questionId: binding.questionId,
        answer: action.answer, source: 'slack' }, false, undefined, requestId);
    },
    stopAccepting() { accepting = false; },
    close() {
      accepting = false;
      targets.clear();
      for (const id of attachments) detach(id);
    },
  };
  const active = new Set<Promise<unknown>>();
  const track = <T>(action: () => Promise<T>): Promise<T> => {
    const pending = action();
    active.add(pending);
    return pending.finally(() => { active.delete(pending); });
  };
  const deliver = port.delivery.deliver;
  port.delivery.deliver = (...args) => track(() => deliver(...args));
  return { ...receiver,
    receive: (...args: Parameters<typeof receiver.receive>) => track(() => receiver.receive(...args)),
    receiveAction: (...args: Parameters<typeof receiver.receiveAction>) => track(() => receiver.receiveAction(...args)),
    async close(): Promise<void> {
      accepting = false;
      await Promise.allSettled([...active]);
      await inquiryDelivery.close();
      receiver.close();
    },
  };
}
