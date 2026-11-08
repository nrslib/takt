import { realpath } from 'node:fs/promises';
import { AsyncCommand } from '../../infra/daemon/command.js';
import { buildSafeGitEnvironment } from '../../infra/task/git-environment.js';
import type { GoalQuestion } from '../../infra/goals/schema.js';
import type { ManagerAssignment } from './startupResolution.js';
import { randomUUID } from 'node:crypto';
import { conversationId } from '../../infra/conversations/identity.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import type { SlackClient, SlackThread, SlackDeliveryResult } from '../../infra/slack/client.js';
import { getLabel } from '../../shared/i18n/index.js';
import { ConversationError } from './conversationErrors.js';
import type { ConversationDelivery, ConversationInput, ConversationPort, ConversationCommand, QuestionTarget } from './conversationPort.js';
import { SlackInquiryBindings, slackInquiryKey } from '../../infra/slack/inquiryBindings.js';
import type { PendingQuestion } from './inquiryAnswer.js';
import { buildSlackInquiry, SLACK_INQUIRY_ACTION } from './slackInquiryBlocks.js';
import { formatGoalName } from './goalDisplay.js';
import { formatSummaryList, formatGoalSpecifications } from './summaryDisplay.js';
import type { KnownBlock, MarkdownBlock } from '@slack/types';

export const SLACK_GOAL_APPROVE = 'takt_goal_approve';
export const SLACK_GOAL_DISMISS = 'takt_goal_dismiss';

export interface SlackEndpoint extends SlackThread { teamId: string; userId: string }

const MARKDOWN_MESSAGE_LIMIT = 12_000;

export function createSlackConversationPort(options: {
  repositoryDirectory: string; configDirectory: string; resolveAssignment(): Promise<ManagerAssignment>; channelId: string; input: ConversationInput; client: SlackClient; language: 'ja' | 'en';
}) {
  const targets = new Map<string, { endpoint: SlackEndpoint; attachmentId: string; conversationId: string; makeGoal: boolean }>();
  const attachments = new Set<string>();
  const bindings = new SlackInquiryBindings(options.configDirectory, options.repositoryDirectory);
  const attempted = new Map<string, Promise<SlackDeliveryResult>>();
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
          const key = slackInquiryKey(output.target, output.question.id);
          const attempt = attempted.get(key);
          if (attempt !== undefined) return attempt;
          const send = async (): Promise<SlackDeliveryResult> => {
            const previous = await bindings.question(options.channelId, output.target, output.question.id);
            if (previous !== undefined) return { kind: 'delivered' };
            const current = await options.resolveAssignment();
            if (currentConversationId !== conversationId(current) || output.question.status !== 'pending'
              || output.question.recipient !== 'human' || !accepting) return { kind: 'unavailable', reason: 'Inquiry unavailable' };
            const pending: PendingQuestion = output.target.goalId === null ? { ...output.target, question: output.question }
              : { ...output.target, question: output.question, objective: '' };
            const message = messageFor({ pending });
            const result = await options.client.postMessage(options.channelId, message.text, message.blocks);
            if (result.kind !== 'delivered') return result;
            await bindings.save({ channelId: options.channelId, parentTs: result.parentTs, target: output.target, questionId: output.question.id });
            return { kind: 'delivered' };
          };
          const sending = send();
          attempted.set(key, sending);
          return sending;
        }
        if (output.kind === 'pending' && output.state.pending !== null && version.operationId !== null) {
          const target = targets.get(version.operationId);
          if (target === undefined || !target.makeGoal || target.conversationId !== currentConversationId
            || output.state.conversationId !== currentConversationId) return { kind: 'delivered' };
          const pending = output.state.pending;
          const summary = pending.summary;
          const sections = [
            `${getLabel('manager.summary.repository', options.language)}: ${pending.repositoryDirectory}`,
            `${getLabel('manager.summary.objective', options.language)}:\n${summary.objective}`,
            `${getLabel('manager.summary.outOfScope', options.language)}:\n${formatSummaryList(summary.outOfScope, options.language)}`,
            `${getLabel('manager.summary.acceptanceCriteria', options.language)}:\n${formatSummaryList(summary.acceptanceCriteria, options.language)}`,
            `${getLabel('manager.summary.constraints', options.language)}:\n${formatSummaryList(summary.constraints, options.language)}`,
          ];
          sections.push(...formatGoalSpecifications(summary.specifications));
          if (summary.startBranch !== undefined) sections.push(`${getLabel('manager.summary.startBranch', options.language)}: ${summary.startBranch}`);
          if (summary.integrationBranch !== undefined) sections.push(`${getLabel('manager.summary.integrationBranch', options.language)}: ${summary.integrationBranch}`);
          let fragments: string[] = [];
          for (const section of sections) {
            for (let offset = 0; offset < section.length;) {
              let end = Math.min(offset + 2900, section.length);
              const last = section.charCodeAt(end - 1);
              if (end < section.length && last >= 0xd800 && last <= 0xdbff) end--;
              fragments.push(section.slice(offset, end));
              if (fragments.length === 10) {
                const blocks: KnownBlock[] = fragments.map((text) => ({ type: 'section', text: { type: 'plain_text', text } }));
                const result = await options.client.postThreadMessage(target.endpoint, fragments.join('\n'), blocks);
                if (result.kind !== 'delivered') {
                  targets.delete(version.operationId);
                  detach(target.attachmentId);
                  return result;
                }
                fragments = [];
              }
              offset = end;
            }
          }
          const value = JSON.stringify({ conversationId: currentConversationId, revision: pending.revision });
          const text = fragments.length > 0 ? fragments.join('\n') : getLabel('manager.makeGoalDescription', options.language);
          const blocks: KnownBlock[] = [...fragments.map((part): KnownBlock => ({ type: 'section', text: { type: 'plain_text', text: part } })), { type: 'actions', elements: [
            { type: 'button', action_id: SLACK_GOAL_APPROVE, text: { type: 'plain_text', text: getLabel('manager.slackGoalApprove', options.language) }, value },
            { type: 'button', action_id: SLACK_GOAL_DISMISS, text: { type: 'plain_text', text: getLabel('manager.slackGoalDismiss', options.language) }, value },
          ] }];
          const result = await options.client.postThreadMessage(target.endpoint, text, blocks);
          if (result.kind !== 'delivered') {
            targets.delete(version.operationId);
            detach(target.attachmentId);
          }
          return result;
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
          const text = output.result.message;
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
        const message = submission.message;
        await options.client.postThreadMessage(endpoint, message);
      }
    } catch (error) {
      const key = error instanceof ConversationError ? error.code : 'operation_failed';
      await options.client.postThreadMessage(endpoint, getLabel(`manager.conversation.${key}`, options.language));
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
          ...(makeGoal ? { display: false } : {}) }, makeGoal, undefined, requestId);
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
        let decoded: unknown;
        try { decoded = JSON.parse(value) as unknown; } catch { return; }
        if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return;
        const fields = decoded as Record<string, unknown>;
        if (Object.keys(fields).length !== 2 || typeof fields.conversationId !== 'string' || !Number.isSafeInteger(fields.revision)
          || (fields.revision as number) < 0) return;
        const revision = fields.revision as number;
        const command: ConversationCommand = actionId === SLACK_GOAL_APPROVE
          ? { kind: 'approve_summary', revision, requirePending: true }
          : { kind: 'dismiss_summary', revision };
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
      await Promise.allSettled([...active, ...attempted.values()]);
      receiver.close();
    },
  };
}
