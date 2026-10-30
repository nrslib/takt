import { randomUUID } from 'node:crypto';
import { DirectorNotificationStore } from '../../infra/conversations/directorNotifications.js';
import { ConversationSpeakerStore } from '../../infra/conversations/speakerStore.js';
import { createDirectorConversationPlan } from '../director/conversationPlan.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { ConversationActorSchema, ConversationAssignmentSchema, PortBindingSchema,
  type ConversationRecord, type PendingSummary, type ConversationAssignment } from '../../infra/conversations/schema.js';
import { ConversationStore } from '../../infra/conversations/store.js';
import type { DaemonOwner } from '../../infra/daemon/owner.js';
import { GoalStore, type GoalProjectionCacheEntry } from '../../infra/goals/store.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import { registerReservedGoal } from '../../infra/goals/service.js';
import { compareInquiries, iterateStandalonePendingInquiries, projectPendingGoalInquiries, type PendingInquiry } from '../../infra/goals/pending-inquiries.js';
import { TaskRunner } from '../../infra/task/runner.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';
import { resolveCurrentManagerAssignment, resolveAssignedProjectRoot } from './assignment.js';
import { createWorkspaceManagerContext, type ManagerAssignment } from './startupResolution.js';
import { buildGoalMemory, buildManagerGoalSummary } from './turnContext.js';
import { projectManagerDisplayEvents, type ManagerDisplayEvent } from './savedEvents.js';
import { SnapshotChanges } from './snapshotChanges.js';
import type { ConversationRuntime } from './conversationRuntime.js';
import type { ConversationCommand, ConversationDelivery, ConversationInput, ConversationOpen, ConversationState,
  OperationResult, OutputVersion, PortOutput, SnapshotValue, SnapshotRead, Submission } from './conversationPort.js';
import type { ConversationDisplayAssignment } from './conversationPort.js';
import { ConversationError, conversationErrorResult } from './conversationErrors.js';
import { answerConversationInquiry } from './conversationAnswers.js';
import { setGoalExecutionStatus } from '../../infra/goals/execution.js';
import { ensureManagerRun } from './autoRun.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { getLabel } from '../../shared/i18n/index.js';
import { resolveConfigValue } from '../../infra/config/resolveConfigValue.js';
import { createManagerConversationPlan } from './conversationPlan.js';
import { validateManagerSummary } from './turnResponse.js';
import { ConversationCommandSchema } from './conversationCommands.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { notifyManagerTurnFailure } from './turnFailureNotification.js';

interface Operation { id: string; controller: AbortController; cleanupComplete: boolean; completion?: Promise<void> }
interface LoadedConversation {
  record: ConversationRecord;
  sequence: number;
  interrupted: boolean;
  language: 'ja' | 'en';
  active?: Operation;
  contextKey?: string;
  storageFailed: boolean;
  recoveryRecord?: ConversationRecord;
  denials?: string[];
}
interface GoalProjection { goal: Extract<SnapshotValue, { kind: 'goal' }>; inquiries: PendingInquiry[]; events: ManagerDisplayEvent[] }
interface Attachment { conversation: LoadedConversation; delivery: ConversationDelivery; speaker: ConversationOpen['speaker'];
  agentOverrides: ConversationOpen['agentOverrides']; startedAt: number; startupBoundaries: ReadonlyMap<string, number>;
  changes: SnapshotChanges; currentRead?: SnapshotRead;
  projections: Map<string, { context: string; cache: Map<string, GoalProjectionCacheEntry<GoalProjection>> }> }

function identityOf(assignment: ManagerAssignment): Exclude<ConversationAssignment, { kind: 'daemon' }>;
function identityOf(assignment: ConversationDisplayAssignment): ConversationAssignment;
function identityOf(assignment: ConversationDisplayAssignment): ConversationAssignment {
  if (assignment.kind === 'daemon') return { kind: 'daemon' };
  return assignment.kind === 'workspace' ? { kind: 'workspace', workspaceId: assignment.workspaceId }
    : { kind: 'repository', repositoryDirectory: assignment.repositoryDirectory };
}

export function createConversationService(input: {
  configDirectory: string; owner: DaemonOwner; runtime: ConversationRuntime; onDomainChange(): void;
}) {
  const store = new ConversationStore(input.configDirectory);
  const speakers = new ConversationSpeakerStore(input.configDirectory);
  const notifications = new DirectorNotificationStore(input.configDirectory);
  const conversations = new Map<string, LoadedConversation>();
  const initializing = new Set<string>();
  const admissions = new Set<Promise<void>>();
  const attachments = new Map<string, Attachment>();
  let closed = false;
  let shutdownDelivery: Promise<void> | undefined;
  const detach = (id: string): void => { attachments.get(id)?.currentRead?.cancel(); attachments.delete(id); };
  const beginAdmission = (): (() => void) => {
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    admissions.add(completion);
    return () => { admissions.delete(completion); finish(); };
  };
  const checkAdmission = (): void => { if (closed) throw new ConversationError('shutting_down'); };
  const nextRevision = (revision: number): number => {
    if (revision >= Number.MAX_SAFE_INTEGER) throw new ConversationError('operation_failed');
    return revision + 1;
  };
  const save = (conversation: LoadedConversation, record: ConversationRecord): void => {
    if (conversation.sequence >= Number.MAX_SAFE_INTEGER) throw new ConversationError('operation_failed');
    try { store.write(record); }
    catch { conversation.storageFailed = true; throw new ConversationError('storage_error'); }
    conversation.record = record;
    conversation.sequence++;
    conversation.storageFailed = false;
    conversation.recoveryRecord = undefined;
  };
  const capture = (conversation: LoadedConversation): ConversationState => {
    const record = conversation.record;
    return structuredClone({ conversationId: record.id, assignment: record.assignment, revision: record.revision,
      pending: record.pending, approval: record.approval, running: record.running === null ? null
        : { operationId: record.running.operationId, kind: record.running.kind }, interrupted: conversation.interrupted });
  };
  const version = (conversation: LoadedConversation, operationId: string | null): OutputVersion => ({
    revision: conversation.record.revision, stateSequence: conversation.sequence, operationId,
  });
  const publish = async (conversation: LoadedConversation, output: PortOutput, outputVersion: OutputVersion): Promise<void> => {
    const deliveries: Promise<void>[] = [];
    for (const [id, attachment] of attachments) {
      if (attachment.conversation !== conversation) continue;
      deliveries.push(attachment.delivery.deliver(conversation.record.id, output, outputVersion).then((result) => {
        if (result.kind === 'unavailable') detach(id);
      }, () => { detach(id); }));
    }
    await Promise.all(deliveries);
  };
  const resolveAssignment = async (identity: ConversationAssignment): Promise<ConversationDisplayAssignment> => {
    if (identity.kind === 'daemon') return { kind: 'daemon', repositoryDirectories: [] };
    const normalized = identity.kind === 'repository'
      ? { kind: 'repository' as const, repositoryDirectory: await resolveGitRepositoryDirectory(identity.repositoryDirectory) } : identity;
    return resolveCurrentManagerAssignment(normalized, input.configDirectory);
  };
  const currentAssignment = async (conversation: LoadedConversation): Promise<ConversationDisplayAssignment> => {
    const assignment = await resolveAssignment(conversation.record.assignment);
    if (conversationId(identityOf(assignment)) !== conversation.record.id) {
      const original = conversation.record.assignment;
      if (conversation.record.approval?.state === 'reserved' && original.kind === 'repository'
        && assignment.repositoryDirectories.includes(original.repositoryDirectory)) {
        return { ...original, repositoryDirectories: [original.repositoryDirectory] };
      }
      void publish(conversation, { kind: 'notice', id: randomUUID(),
        message: getLabel('manager.conversation.assignment_changed', conversation.language) }, version(conversation, null));
      throw new ConversationError('invalid_assignment');
    }
    return assignment;
  };
  const getAttachment = (id: string): Attachment => {
    const attachment = attachments.get(id);
    if (attachment === undefined) throw new ConversationError('unavailable_attachment');
    return attachment;
  };
  const readSnapshot = (conversation: LoadedConversation, assignment: ConversationDisplayAssignment, attachment: Attachment): SnapshotRead => {
    const state = capture(conversation);
    const capturedVersion = version(conversation, state.running?.operationId ?? null);
    const language = conversation.language;
    attachment.currentRead?.cancel();
    const items = async function* (): AsyncGenerator<SnapshotValue> {
      yield { kind: 'state', state };
      yield { kind: 'assignment', assignment };
      try {
        if (assignment.kind === 'daemon') {
          for await (const notification of notifications.iterate()) yield { kind: 'display_event', event: notification };
          return;
        }
        const inquiries: PendingInquiry[] = [];
        const events: ManagerDisplayEvent[] = [];
        for (const directory of attachment.projections.keys()) {
          if (!assignment.repositoryDirectories.includes(directory)) attachment.projections.delete(directory);
        }
        for (const repositoryDirectory of assignment.repositoryDirectories) {
          const { notifications: policy } = resolveManagerConfig(repositoryDirectory);
          const context = JSON.stringify([language, policy]);
          let projection = attachment.projections.get(repositoryDirectory);
          if (projection?.context !== context) {
            projection = { context, cache: new Map() };
            attachment.projections.set(repositoryDirectory, projection);
          }
          for await (const projected of new GoalStore(repositoryDirectory).iterateProjected(projection.cache, (goal): GoalProjection => ({
            goal: { kind: 'goal', goal: { id: goal.id, objective: goal.objective, status: goal.status,
              executionStatus: goal.executionStatus, repositoryDirectory } },
            inquiries: [...projectPendingGoalInquiries(goal, repositoryDirectory)],
            events: [...projectManagerDisplayEvents(goal, repositoryDirectory, language,
              attachment.startupBoundaries.get(repositoryDirectory), attachment.startedAt, policy)],
          }))) {
            yield projected.goal;
            inquiries.push(...projected.inquiries);
            events.push(...projected.events);
          }
        }
        for await (const inquiry of iterateStandalonePendingInquiries(input.configDirectory, assignment)) inquiries.push(inquiry);
        for (const inquiry of inquiries.sort(compareInquiries)) {
          yield { kind: 'inquiry', inquiry: { target: inquiry.goalId === null
            ? { goalId: null, owner: identityOf(assignment) }
            : { goalId: inquiry.goalId, repositoryDirectory: inquiry.repositoryDirectory }, question: inquiry.question,
            ...(inquiry.goalId === null ? {} : { objective: inquiry.objective }) } };
        }
        for (const event of events) yield { kind: 'display_event', event };
      } catch (error) {
        const message = sanitizeSensitiveText(getErrorMessage(error));
        yield { kind: 'display_event', event: { id: JSON.stringify(['diagnostic', message]), message } };
        throw error;
      }
    };
    const read = attachment.changes.read({ ...capturedVersion, transferId: randomUUID(), conversationId: state.conversationId }, items());
    attachment.currentRead = read;
    return read;
  };
  const approve = async (conversation: LoadedConversation, revision: number, assignment: ManagerAssignment, signal: AbortSignal): Promise<OperationResult> => {
    const { approval, pending } = conversation.record;
    if (approval?.revision === revision && approval.state === 'registered') {
      if (!assignment.repositoryDirectories.includes(approval.repositoryDirectory)) throw new ConversationError('invalid_assignment');
      const goal = new GoalStore(approval.repositoryDirectory).find(approval.goalId);
      if (goal === undefined) throw new ConversationError('registration_recovery');
      return { kind: 'goal_registered', goal };
    }
    if (pending === null || pending.revision !== revision || conversation.record.revision !== revision) throw new ConversationError('stale_summary');
    if (!assignment.repositoryDirectories.includes(pending.repositoryDirectory)) throw new ConversationError('invalid_assignment');
    const reservation = approval;
    if (reservation === null || reservation.state !== 'reserved' || reservation.revision !== revision) throw new ConversationError('registration_recovery');
    const goal = await registerReservedGoal({ ...pending.summary, cwd: reservation.repositoryDirectory, id: reservation.goalId }, signal);
    save(conversation, { ...conversation.record, approval: { ...reservation, state: 'registered' }, pending: null,
      revision: nextRevision(conversation.record.revision) });
    input.onDomainChange();
    return { kind: 'goal_registered', goal };
  };
  const execute = async (conversation: LoadedConversation, operation: Operation, command: Exclude<ConversationCommand, { kind: 'abort_turn' }>,
    assignment: ConversationDisplayAssignment, priorPending: PendingSummary | null, agentOverrides: ConversationOpen['agentOverrides']): Promise<void> => {
    let result: OperationResult;
    let clearSessionOnFailure = false;
    const denials: string[] = [];
    try {
      const signal = operation.controller.signal;
      signal.throwIfAborted();
      if (assignment.kind === 'daemon') {
        if (command.kind !== 'message') throw new ConversationError('invalid_input');
        const runtime = await input.runtime.resolve(assignment, signal, agentOverrides);
        let outcome: { result: OperationResult } | { error: unknown };
        let cleanupFailure: { error: unknown } | undefined;
        try {
          const changed = conversation.record.provider !== runtime.provider || conversation.record.model !== runtime.model
            || conversation.contextKey !== undefined && conversation.contextKey !== runtime.contextKey;
          if (changed) save(conversation, { ...conversation.record, provider: runtime.provider, model: runtime.model, sessionId: null });
          conversation.contextKey = runtime.contextKey;
          conversation.language = runtime.language;
          const output = await runtime.executor.execute({
            prompt: command.text, instruction: command.text, sessionId: conversation.record.sessionId ?? undefined,
            assignment: undefined, abortSignal: signal, configDirectory: input.configDirectory,
            recovery: { context: '', invalidateSession: async () => { save(conversation, { ...conversation.record, sessionId: null }); } },
          });
          signal.throwIfAborted();
          save(conversation, { ...conversation.record, sessionId: output.sessionId ?? null });
          outcome = { result: { kind: 'reply', message: output.message } };
        } catch (error) {
          outcome = { error };
        } finally {
          try { await runtime.release?.(); }
          catch (error) { cleanupFailure = { error }; }
        }
        if (cleanupFailure !== undefined) {
          if ('error' in outcome && outcome.error instanceof ConversationError) outcome.error.cause = cleanupFailure.error;
          else throw cleanupFailure.error;
        }
        if ('error' in outcome) throw outcome.error;
        result = outcome.result;
      } else switch (command.kind) {
        case 'message': {
          const previousDenials = conversation.denials;
          conversation.denials = undefined;
          const runtime = await input.runtime.resolve(assignment, signal, agentOverrides);
          const changed = conversation.record.provider !== runtime.provider || conversation.record.model !== runtime.model
            || (conversation.contextKey !== undefined && conversation.contextKey !== runtime.contextKey);
          if (changed) save(conversation, { ...conversation.record, provider: runtime.provider, model: runtime.model, sessionId: null });
          conversation.contextKey = runtime.contextKey;
          conversation.language = runtime.language;
          const memories = [];
          let remainingMemoryBytes = 64 * 1024;
          for (const repositoryDirectory of assignment.repositoryDirectories) {
            try {
              const tasks = new TaskRunner(repositoryDirectory).listTaskStateItems();
              const goals = [];
              let goalCount = 0;
              for await (const goal of new GoalStore(repositoryDirectory).iterate()) {
                goalCount++;
                const summary = buildManagerGoalSummary(repositoryDirectory, goal, tasks);
                const bytes = Buffer.byteLength(JSON.stringify(summary));
                if (bytes <= remainingMemoryBytes) { goals.push(summary); remainingMemoryBytes -= bytes; }
              }
              memories.push({ repositoryDirectory, goals, goalCount, diagnostics: [] });
            } catch (error) { memories.push({ repositoryDirectory, goals: undefined, diagnostics: [{ message: getErrorMessage(error) }] }); }
          }
          const businessContext = JSON.stringify({ assignment, pending: priorPending, goals: JSON.parse(buildGoalMemory(memories)) as unknown });
          const output = await runtime.executor.execute({
            prompt: [
              command.text,
              ...(conversation.record.lastSpeaker?.namespace === 'agent'
                ? [`Speaker: ${JSON.stringify(conversation.record.lastSpeaker)}`] : []),
              ...(previousDenials === undefined || previousDenials.length === 0 ? []
                : [`Previous tool permission denials: ${JSON.stringify(previousDenials)}`]),
            ].join('\n\n'),
            instruction: command.text, sessionId: conversation.record.sessionId ?? undefined,
            assignment: identityOf(assignment), abortSignal: signal, configDirectory: input.configDirectory,
            conversationOperationId: operation.id,
            recovery: { context: businessContext, invalidateSession: async () => {
              clearSessionOnFailure = true;
              save(conversation, { ...conversation.record, sessionId: null });
            } },
            onNotification: (message) => { void publish(conversation, { kind: 'progress', operationId: operation.id, message }, version(conversation, operation.id)); },
            onDenial: (reason) => { if (!signal.aborted) denials.push(reason); },
          });
          signal.throwIfAborted();
          const latest = await resolveAssignment(conversation.record.assignment);
          if (latest.kind === 'daemon') throw new ConversationError('invalid_assignment');
          let pending: PendingSummary | null = null;
          if (output.summary !== null) {
            const { repositoryDirectory: requested, ...summary } = output.summary;
            const targetRepository = requested ?? (assignment.kind === 'repository' ? assignment.repositoryDirectory : undefined);
            if (targetRepository === undefined) throw new ConversationError('invalid_assignment');
            const repositoryDirectory = await resolveAssignedProjectRoot(targetRepository, assignment);
            if (!latest.repositoryDirectories.includes(repositoryDirectory)) throw new ConversationError('invalid_assignment');
            pending = { revision: conversation.record.revision, repositoryDirectory, summary };
          }
          save(conversation, { ...conversation.record, sessionId: output.sessionId ?? null, pending });
          clearSessionOnFailure = false;
          if (conversationId(identityOf(latest)) !== conversation.record.id) {
            await publish(conversation, { kind: 'notice', id: randomUUID(),
              message: getLabel('manager.conversation.assignment_changed', conversation.language) }, version(conversation, operation.id));
          }
          result = { kind: 'reply', message: output.message };
          break;
        }
        case 'approve_summary': result = await approve(conversation, command.revision, assignment, signal); break;
        case 'dismiss_summary': result = { kind: 'reply', message: getLabel('manager.conversation.dismissed', conversation.language) }; break;
        case 'answer_question':
          result = await answerConversationInquiry(command, assignment, input.configDirectory, signal, conversation.language);
          input.onDomainChange();
          break;
        default: {
          let repository: string | undefined;
          for (const directory of assignment.repositoryDirectories) {
            if (new GoalStore(directory).find(command.goalId) !== undefined) {
              if (repository !== undefined) throw new ConversationError('invalid_assignment');
              repository = directory;
            }
          }
          if (repository === undefined) throw new ConversationError('invalid_assignment');
          const status = command.kind === 'pause_goal' ? 'paused' : command.kind === 'resume_goal' ? 'active' : 'aborted';
          await setGoalExecutionStatus(repository, command.goalId, status, signal);
          if (status === 'aborted') new TaskRunner(repository).invalidatePendingGoalTasks(command.goalId);
          if (status === 'active') await ensureManagerRun(repository);
          input.onDomainChange();
          result = { kind: 'reply', message: getLabel(status === 'paused' ? 'manager.goalPaused'
            : status === 'active' ? 'manager.goalResumed' : 'manager.goalAborted', conversation.language, { goalId: command.goalId }) };
        }
      }
    } catch (error) {
      result = conversationErrorResult(error, conversation.language);
      if (command.kind === 'message' && assignment.kind !== 'daemon' && !operation.controller.signal.aborted) {
        const cwd = assignment.kind === 'repository' ? assignment.repositoryDirectory
          : createWorkspaceManagerContext({ id: assignment.workspaceId, name: assignment.name,
            repositoryDirectories: assignment.repositoryDirectories }, input.configDirectory).cwd;
        const message = await notifyManagerTurnFailure(cwd, undefined, error);
        if (message !== undefined) await publish(conversation, { kind: 'notice', id: randomUUID(), message }, version(conversation, operation.id));
      }
      if (command.kind === 'message' && conversation.record.approval?.state !== 'reserved') {
        conversation.record = { ...conversation.record, pending: null,
          ...(clearSessionOnFailure || operation.controller.signal.aborted ? { sessionId: null } : {}) };
      }
    }
    if (command.kind === 'message') conversation.denials = operation.controller.signal.aborted ? undefined : denials;
    operation.cleanupComplete = true;
    try {
      save(conversation, { ...conversation.record, running: null });
      conversation.active = undefined;
      conversation.interrupted = false;
      const outputVersion = version(conversation, operation.id);
      await publish(conversation, { kind: 'pending', state: capture(conversation) }, outputVersion);
      await publish(conversation, { kind: 'result', operationId: operation.id, result }, outputVersion);
    } catch {
      await publish(conversation, { kind: 'result', operationId: operation.id,
        result: conversationErrorResult(new ConversationError('storage_error'), conversation.language) }, version(conversation, operation.id));
    }
  };
  const service: ConversationInput = {
    async open(open, delivery) {
      checkAdmission();
      const requested = ConversationAssignmentSchema.parse(open.assignment);
      const binding = PortBindingSchema.parse(open.binding);
      const speaker = ConversationActorSchema.parse(open.speaker);
      if (typeof open.conversationId !== 'string') throw new ConversationError('invalid_input');
      if (initializing.has(open.conversationId)) throw new ConversationError('busy');
      const existing = conversations.get(open.conversationId);
      if (existing === undefined) initializing.add(open.conversationId);
      const finishAdmission = beginAdmission();
      try {
        const assignment = await resolveAssignment(requested);
        const identity = identityOf(assignment);
        if (conversationId(identity) !== open.conversationId) throw new ConversationError('invalid_assignment');
        const directorPlan = assignment.kind === 'daemon'
          ? createDirectorConversationPlan(input.configDirectory, open.agentOverrides ?? {}) : undefined;
        checkAdmission();
        let conversation = existing;
        if (conversation === undefined) {
          const restored = store.read(open.conversationId, identity);
          const cwd = assignment.kind === 'daemon' ? input.configDirectory : assignment.kind === 'repository' ? assignment.repositoryDirectory
            : createWorkspaceManagerContext({ id: assignment.workspaceId, name: assignment.name, repositoryDirectories: assignment.repositoryDirectories }, input.configDirectory).cwd;
          const plan = directorPlan ?? createManagerConversationPlan(cwd, open.agentOverrides ?? {});
          const record = restored ?? { schemaVersion: 1 as const, id: open.conversationId, agent: assignment.kind === 'daemon' ? 'director' : 'manager', assignment: identity,
            counterpart: binding.counterpart, lastSpeaker: null, provider: plan.ctx.providerType, model: plan.ctx.model ?? null, sessionId: null, bindings: [],
            revision: 0, pending: null, approval: null, running: null };
          conversation = { record, sequence: 0, interrupted: record.running !== null,
            language: resolveConfigValue(cwd, 'language'), storageFailed: false };
          if (record.running !== null) save(conversation, { ...record, running: null, sessionId: null });
          conversations.set(record.id, conversation);
        }
        if (conversation.storageFailed) throw new ConversationError('storage_error');
        const savedBinding = conversation.record.bindings.some((value) => JSON.stringify(value) === JSON.stringify(binding));
        if (!savedBinding) {
          if (conversation.active !== undefined) throw new ConversationError('busy');
          save(conversation, { ...conversation.record, bindings: [...conversation.record.bindings, binding] });
        }
        const attachmentId = randomUUID();
        const startedAt = Date.now();
        const attachment: Attachment = { conversation, delivery, speaker, agentOverrides: open.agentOverrides, startedAt,
          changes: new SnapshotChanges(), projections: new Map(),
          startupBoundaries: new Map(assignment.repositoryDirectories.map((directory) => [directory, startedAt])) };
        attachments.set(attachmentId, attachment);
        return { attachmentId, read: readSnapshot(conversation, assignment, attachment) };
      } finally { finishAdmission(); if (existing === undefined) initializing.delete(open.conversationId); }
    },
    async submit(request): Promise<Submission> {
      let conversation: LoadedConversation | undefined;
      let operation: Operation | undefined;
      const finishAdmission = beginAdmission();
      try {
        checkAdmission();
        const attachment = getAttachment(request.attachmentId);
        conversation = attachment.conversation;
        const speaker = ConversationActorSchema.safeParse(request.speaker);
        if (!speaker.success || speaker.data.namespace !== attachment.speaker.namespace || speaker.data.id !== attachment.speaker.id) {
          throw new ConversationError('invalid_input');
        }
        if (conversation.storageFailed) throw new ConversationError('storage_error');
        const parsedCommand = ConversationCommandSchema.safeParse(request.command);
        if (!parsedCommand.success) throw new ConversationError('invalid_input');
        const command = parsedCommand.data;
        if ((conversation.record.assignment.kind === 'daemon' || attachment.speaker.namespace === 'agent' && attachment.speaker.id === 'director')
          && command.kind !== 'message') throw new ConversationError('invalid_input');
        if (command.kind === 'abort_turn') {
          const active = conversation.active;
          if (active === undefined || active.id !== command.operationId) throw new ConversationError('invalid_input');
          active.controller.abort();
          if (conversation.record.approval?.state !== 'reserved') save(conversation, { ...conversation.record,
            pending: null, sessionId: null, revision: nextRevision(conversation.record.revision) });
          return { kind: 'accepted', operationId: active.id };
        }
        if (conversation.active !== undefined) return { kind: 'busy', operationId: conversation.active.id };
        if (command.kind === 'approve_summary' && command.requirePending === true
          && (conversation.record.pending?.revision !== command.revision || conversation.record.revision !== command.revision)) {
          throw new ConversationError('stale_summary');
        }
        operation = { id: randomUUID(), controller: new AbortController(), cleanupComplete: false };
        conversation.active = operation;
        const assignment = await currentAssignment(conversation);
        checkAdmission();
        operation.controller.signal.throwIfAborted();
        if (conversation.record.approval?.state === 'reserved'
          && (command.kind !== 'approve_summary' || command.revision !== conversation.record.approval.revision)) {
          throw new ConversationError('registration_recovery');
        }
        const priorPending = conversation.record.pending;
        if (command.kind === 'dismiss_summary' && (priorPending === null || command.revision !== priorPending.revision)) throw new ConversationError('stale_summary');
        if (command.kind === 'approve_summary' && conversation.record.approval?.revision !== command.revision
          && (priorPending === null || command.revision !== priorPending.revision)) throw new ConversationError('stale_summary');
        if (command.kind === 'approve_summary') {
          const repository = conversation.record.approval?.revision === command.revision
            ? conversation.record.approval.repositoryDirectory : priorPending?.repositoryDirectory;
          if (repository === undefined || !assignment.repositoryDirectories.includes(repository)) throw new ConversationError('invalid_assignment');
          if (priorPending !== null && priorPending.revision === command.revision) validateManagerSummary(priorPending.summary);
        }
        const changesRevision = command.kind !== 'approve_summary';
        let approval = conversation.record.approval;
        if (command.kind === 'approve_summary' && approval?.revision !== command.revision) {
          if (priorPending === null) throw new ConversationError('stale_summary');
          nextRevision(conversation.record.revision);
          approval = { state: 'reserved', revision: command.revision, goalId: randomUUID(), repositoryDirectory: priorPending.repositoryDirectory };
        }
        const priorRecord = conversation.record;
        save(conversation, { ...priorRecord, lastSpeaker: attachment.speaker,
          approval,
          ...(changesRevision ? { revision: nextRevision(conversation.record.revision), pending: null } : {}),
          running: { operationId: operation.id, kind: command.kind, owner: { pid: input.owner.pid, identity: input.owner.identity } } });
        if (command.kind === 'message') {
          try { speakers.write({ conversationId: conversation.record.id, operationId: operation.id, actor: attachment.speaker }); }
          catch {
            conversation.recoveryRecord = priorRecord;
            save(conversation, priorRecord);
            throw new ConversationError('storage_error');
          }
        }
        const owned = conversation;
        const accepted = operation;
        if (command.kind === 'message' && command.display !== false) {
          void publish(conversation, { kind: 'user_message', operationId: operation.id, message: command.text }, version(conversation, operation.id));
        }
        void publish(conversation, { kind: 'running', state: capture(conversation) }, version(conversation, operation.id));
        operation.completion = Promise.resolve().then(() => execute(owned, accepted, command, assignment, priorPending, attachment.agentOverrides));
        return { kind: 'accepted', operationId: operation.id };
      } catch (error) {
        if (operation !== undefined) operation.cleanupComplete = true;
        if (conversation !== undefined && operation !== undefined && conversation.active === operation && !conversation.storageFailed) conversation.active = undefined;
        return conversationErrorResult(error, conversation?.language ?? 'en');
      } finally { finishAdmission(); }
    },
    async snapshot(attachmentId) {
      const attachment = getAttachment(attachmentId);
      const { conversation } = attachment;
      if (conversation.storageFailed) {
        if (conversation.active !== undefined && !conversation.active.cleanupComplete) throw new ConversationError('storage_error');
        save(conversation, conversation.recoveryRecord ?? { ...conversation.record, running: null });
        conversation.active = undefined;
      }
      return readSnapshot(conversation, await currentAssignment(conversation), attachment);
    },
    detach,
  };
  return {
    ...service,
    async notifyDirector(notification: { id: string; message: string }): Promise<void> {
      const conversation = conversations.get(conversationId({ kind: 'daemon' }));
      if (conversation !== undefined) await publish(conversation, { kind: 'notice', ...notification }, version(conversation, conversation.active?.id ?? null));
    },
    get attachmentCount() { return attachments.size; },
    get activeOperationCount() { return initializing.size + [...conversations.values()].filter(({ active }) => active !== undefined).length; },
    stopAccepting() {
      if (closed) return;
      closed = true;
      shutdownDelivery = Promise.all([...conversations.values()].map((conversation) => publish(conversation,
        { kind: 'notice', id: randomUUID(), message: getLabel('manager.conversation.shutting_down', conversation.language) },
        version(conversation, conversation.active?.id ?? null)))).then(() => {});
    },
    async close() {
      closed = true;
      const pending = [...conversations.values()].flatMap(({ active }) => {
        active?.controller.abort();
        return active?.completion === undefined ? [] : [active.completion];
      });
      try { await Promise.all([...pending, ...admissions, shutdownDelivery]); }
      finally { for (const id of attachments.keys()) detach(id); await input.runtime.close(); }
    },
  };
}
