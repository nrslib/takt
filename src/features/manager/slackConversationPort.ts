import { randomUUID } from 'node:crypto';
import { conversationId } from '../../infra/conversations/identity.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';
import type { SlackClient, SlackThread, SlackDeliveryResult } from '../../infra/slack/client.js';
import { getLabel } from '../../shared/i18n/index.js';
import { resolveCurrentManagerAssignment } from './assignment.js';
import { ConversationError } from './conversationErrors.js';
import type { ConversationDelivery, ConversationInput, ConversationPort, ConversationCommand, QuestionTarget } from './conversationPort.js';
import { GoalStore } from '../../infra/goals/store.js';
import { StandaloneInquiryStore } from '../../infra/goals/standalone-inquiries.js';
import { SlackInquiryBindings, slackInquiryKey, type SlackInquiryBinding } from '../../infra/slack/inquiryBindings.js';
import { createPermissionProposal, type PendingQuestion } from './inquiryAnswer.js';
import { buildSlackInquiry, buildSlackPermissionModal, SLACK_INQUIRY_ACTION } from './slackInquiryBlocks.js';
import type { WritablePermissionScope } from './scopedPermissionStorage.js';

export interface SlackEndpoint extends SlackThread { teamId: string; userId: string }

export function createSlackConversationPort(options: {
  repositoryDirectory: string; configDirectory: string; channelId: string; input: ConversationInput; client: SlackClient; language: 'ja' | 'en';
}) {
  const targets = new Map<string, { endpoint: SlackEndpoint; attachmentId: string }>();
  const attachments = new Set<string>();
  const bindings = new SlackInquiryBindings(options.configDirectory, options.repositoryDirectory);
  const attempted = new Map<string, Promise<SlackDeliveryResult>>();
  const messageFor = (current: { pending: PendingQuestion; assignment: Parameters<typeof buildSlackInquiry>[1] }) => {
    return buildSlackInquiry(current.pending, current.assignment, options.language, randomUUID());
  };
  const modals = new Map<string, { endpoint: SlackEndpoint; binding: SlackInquiryBinding; scope: WritablePermissionScope }>();
  let accepting = true;
  const detach = (id: string): void => { attachments.delete(id); options.input.detach(id); };
  const loadInquiry = async (target: QuestionTarget, questionId: string) => {
    const repositoryDirectory = await resolveGitRepositoryDirectory(options.repositoryDirectory);
    const assignment = await resolveCurrentManagerAssignment({ kind: 'repository', repositoryDirectory }, options.configDirectory);
    let pending: PendingQuestion;
    if (target.goalId === null) {
      if (conversationId(target.owner) !== conversationId(assignment)) return undefined;
      const question = await new StandaloneInquiryStore(options.configDirectory, target.owner).get(questionId);
      const operationRoot = question.operation === undefined ? repositoryDirectory : await resolveGitRepositoryDirectory(question.operation.cwd);
      if (operationRoot !== repositoryDirectory) return undefined;
      pending = { goalId: null, owner: target.owner, question };
    } else {
      if (target.repositoryDirectory !== repositoryDirectory || !assignment.repositoryDirectories.includes(repositoryDirectory)) return undefined;
      const goal = await new GoalStore(repositoryDirectory).get(target.goalId);
      const question = goal.questions?.find(({ id }) => id === questionId);
      if (question === undefined) return undefined;
      pending = { ...target, question, objective: goal.objective };
    }
    if (pending.question.status !== 'pending' || pending.question.recipient !== 'human') return undefined;
    return { pending, assignment };
  };
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
        if (output.kind === 'inquiry') {
          if (!accepting) return { kind: 'unavailable', reason: 'Slack port closed' };
          const key = slackInquiryKey(output.target, output.question.id);
          const attempt = attempted.get(key);
          if (attempt !== undefined) return attempt;
          let previous: SlackInquiryBinding | undefined;
          try {
            previous = bindings.question(options.channelId, output.target, output.question.id);
          } catch {
            // An unreadable binding must not prevent a new inquiry from being posted.
          }
          if (previous !== undefined) return { kind: 'delivered' };
          const send = async (): Promise<SlackDeliveryResult> => {
            const current = await loadInquiry(output.target, output.question.id);
            if (current === undefined || !accepting) return { kind: 'unavailable', reason: 'Inquiry unavailable' };
            const message = messageFor(current);
            const result = await options.client.postMessage(options.channelId, message.text, message.blocks);
            if (result.kind !== 'delivered') return result;
            bindings.save({ channelId: options.channelId, parentTs: result.parentTs, target: output.target, questionId: output.question.id });
            return { kind: 'delivered' };
          };
          const sending = send();
          attempted.set(key, sending);
          return sending;
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
  const submitCommand = async (endpoint: SlackEndpoint, command: ConversationCommand): Promise<void> => {
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
      if (command.kind === 'answer_question') {
        const key = JSON.stringify([endpoint.teamId, endpoint.channelId]);
        resolved.binding = { port: 'slack-inquiry', key, counterpart: { namespace: 'slack-channel', id: key } };
      }
      if (!accepting) return;
      const opened = await options.input.open(resolved, delivery);
      attachmentId = opened.attachmentId;
      attachments.add(attachmentId);
      const iterator = opened.read.items[Symbol.asyncIterator]();
      try { await iterator.next(); }
      finally { await iterator.return?.(); }
      if (!accepting) return;
      const submission = await options.input.submit({ attachmentId, requestId: randomUUID(), speaker: resolved.speaker,
        command });
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
  };
  return {
    ...port,
    async receive(endpoint: SlackEndpoint, text: string): Promise<void> {
      if (!accepting) return;
      let binding: SlackInquiryBinding | undefined;
      try {
        binding = bindings.find(endpoint.channelId, endpoint.parentTs);
      } catch {
        // An unreadable binding is treated as an ordinary conversation thread.
      }
      if (binding === undefined) { await submitCommand(endpoint, { kind: 'message', text }); return; }
      const current = await loadInquiry(binding.target, binding.questionId);
      if (current === undefined || current.pending.question.kind !== 'question') return;
      await submitCommand(endpoint, { kind: 'answer_question', target: binding.target, questionId: binding.questionId,
        answer: { text }, source: 'slack' });
    },
    async receiveAction(endpoint: SlackEndpoint, actionId: string, value: string, triggerId: string | undefined): Promise<void> {
      if (!accepting) return;
      const binding = bindings.find(endpoint.channelId, endpoint.parentTs);
      if (binding === undefined) return;
      const current = await loadInquiry(binding.target, binding.questionId);
      if (current === undefined || !accepting || actionId !== `${SLACK_INQUIRY_ACTION}_${value}`) return;
      const message = messageFor(current);
      const action = message.actions.get(value);
      if (action === undefined) return;
      if (action.kind === 'answer') {
        await submitCommand(endpoint, { kind: 'answer_question', target: binding.target, questionId: binding.questionId,
          answer: action.answer, source: 'slack' });
        return;
      }
      if (triggerId === undefined || action.choice.permission === undefined) return;
      const metadata = randomUUID();
      modals.set(metadata, { endpoint, binding, scope: action.choice.permission });
      const proposal = createPermissionProposal(current.pending.question.operation!);
      const result = await options.client.openModal(triggerId, buildSlackPermissionModal(proposal, metadata, options.language));
      if (result.kind !== 'delivered') modals.delete(metadata);
    },
    modalEndpoint(metadata: string): SlackEndpoint | undefined {
      const endpoint = modals.get(metadata)?.endpoint;
      return endpoint === undefined ? undefined : { ...endpoint };
    },
    async receiveModal(endpoint: SlackEndpoint, metadata: string, sentence: string | undefined): Promise<void> {
      if (!accepting) return;
      const modal = modals.get(metadata);
      if (modal === undefined || modal.endpoint.teamId !== endpoint.teamId || modal.endpoint.userId !== endpoint.userId
        || modal.endpoint.channelId !== endpoint.channelId) return;
      modals.delete(metadata);
      if (sentence === undefined || sentence.trim().length === 0) return;
      await submitCommand(endpoint, { kind: 'answer_question', target: modal.binding.target, questionId: modal.binding.questionId,
        answer: { decision: 'allow', scope: modal.scope.kind }, source: 'slack', permission: { scope: modal.scope, sentence } });
    },
    stopAccepting() { accepting = false; },
    close() {
      accepting = false;
      targets.clear();
      modals.clear();
      for (const id of attachments) detach(id);
    },
  };
}
