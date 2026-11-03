import { randomUUID } from 'node:crypto';
import type { TurnEvent } from '../../core/daemon/events.js';
import type { TurnOutcome } from '../../core/daemon/messages.js';
import type { ConversationDisplayAssignment, OperationResult } from './conversationPort.js';
import type { ConversationAssignment, PendingSummary } from '../../infra/conversations/schema.js';
import type { TurnBusiness } from '../daemonTurn/processRuntime.js';
import { TurnConversationState } from '../daemonTurn/conversationState.js';
import { buildTurnBusinessContext } from '../daemonTurn/turnContext.js';
import type { ConversationRuntime } from './conversationRuntime.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { resolveCurrentManagerAssignment, resolveAssignedProjectRoot, findAssignedGoalRepository } from './assignment.js';
import { validateManagerSummary } from './turnResponse.js';
import { ConversationError, conversationErrorResult } from './conversationErrors.js';
import { answerConversationInquiry } from './conversationAnswers.js';
import { GoalStore } from '../../infra/goals/store.js';
import { registerReservedGoal } from '../../infra/goals/service.js';
import { setGoalExecutionStatus } from '../../infra/goals/execution.js';
import { TaskRunner } from '../../infra/task/runner.js';
import { ensureManagerRun } from './autoRun.js';
import { resolveConfigValue } from '../../infra/config/resolveConfigValue.js';
import { createWorkspaceManagerContext } from './startupResolution.js';
import { notifyManagerTurnFailure } from './turnFailureNotification.js';
import { getLabel } from '../../shared/i18n/index.js';
import { reconcileLostRun } from '../daemonTurn/reconcileLostRun.js';
import { appendGoalWorkLog } from '../../infra/goals/workLog.js';

function nextRevision(revision: number): number {
  if (revision >= Number.MAX_SAFE_INTEGER) throw new ConversationError('operation_failed');
  return revision + 1;
}
function identityOf(assignment: Exclude<ConversationDisplayAssignment, { kind: 'daemon' }>): Exclude<ConversationAssignment, { kind: 'daemon' }>;
function identityOf(assignment: ConversationDisplayAssignment): ConversationAssignment;
function identityOf(assignment: ConversationDisplayAssignment): ConversationAssignment {
  if (assignment.kind === 'daemon') return { kind: 'daemon' };
  return assignment.kind === 'workspace' ? { kind: 'workspace', workspaceId: assignment.workspaceId }
    : { kind: 'repository', repositoryDirectory: assignment.repositoryDirectory };
}

function eventReference(event: TurnEvent): { repositoryDirectory: string; goalId?: string | null } | undefined {
  switch (event.kind) {
    case 'task_completed': case 'task_failed': return event.task;
    case 'goal_registered': case 'goal_resumed': return event;
    case 'watch_observation': {
      const observation = event.observation;
      switch (observation.kind) {
        case 'run_process_lost': case 'run_log_stalled': return observation.task;
        case 'watch_failed': return undefined;
        default: return observation;
      }
    }
    default: return undefined;
  }
}

export function createConversationTurnService(configDirectory: string, runtime: ConversationRuntime): Pick<TurnBusiness, 'execute'> {
  let contextKey: string | undefined;
  let denials: string[] = [];
  return {
    async execute(input, io): Promise<TurnOutcome> {
      const state = new TurnConversationState(input.state, io);
      const event = input.event.event;
      const identity = input.state.assignment;
      const assignment: ConversationDisplayAssignment = identity.kind === 'daemon' ? { kind: 'daemon', repositoryDirectories: [] }
        : await resolveCurrentManagerAssignment(identity, configDirectory);
      if (conversationId(identityOf(assignment)) !== input.turn.conversationId) throw new ConversationError('invalid_assignment');
      const cwd = assignment.kind === 'daemon' ? configDirectory : assignment.kind === 'repository' ? assignment.repositoryDirectory
        : createWorkspaceManagerContext({ id: assignment.workspaceId, name: assignment.name, repositoryDirectories: assignment.repositoryDirectories }, configDirectory).cwd;
      let language = resolveConfigValue(cwd, 'language');
      const priorPending = state.current.pending;
      const directorMessage = event.kind === 'director_message';
      const human = event.kind === 'human_command';
      const command = human || event.kind === 'inquiry_answer' ? event.command
        : { kind: 'message' as const, text: directorMessage ? event.text : JSON.stringify({ event, instruction: 'Handle this event for the existing goals. Do not propose a new registration.' }) };
      let result: OperationResult;
      try {
        io.signal.throwIfAborted();
        const reference = eventReference(event);
        if (reference !== undefined && !assignment.repositoryDirectories.includes(reference.repositoryDirectory)) throw new ConversationError('invalid_assignment');
        if (event.kind === 'watch_observation' && event.observation.kind === 'run_process_lost') reconcileLostRun(event.observation, io.signal);
        const eventGoal = reference?.goalId !== undefined && reference.goalId !== null
          ? { repositoryDirectory: reference.repositoryDirectory, goal: await new GoalStore(reference.repositoryDirectory).get(reference.goalId) } : undefined;
        if (eventGoal?.goal.executionStatus === 'paused' || eventGoal?.goal.executionStatus === 'aborted') {
          return { kind: 'completed', result: { kind: 'reply', message: getLabel(eventGoal.goal.executionStatus === 'paused'
            ? 'manager.goalPaused' : 'manager.goalAborted', language, { goalId: eventGoal.goal.id }) } };
        }
        if (identity.kind === 'daemon' && command.kind !== 'message') throw new ConversationError('invalid_input');
        if (state.current.approval?.state === 'reserved'
          && (command.kind !== 'approve_summary' || command.revision !== state.current.approval.revision)) throw new ConversationError('registration_recovery');
        if (human && command.kind !== 'approve_summary') {
          if (command.kind === 'dismiss_summary' && priorPending?.revision !== command.revision) throw new ConversationError('stale_summary');
          await state.save({ proposal: { revision: nextRevision(state.current.revision), pending: null } });
        }
        if (assignment.kind !== 'daemon' && command.kind === 'approve_summary') {
          const existing = state.current.approval;
          if (command.requirePending && (priorPending?.revision !== command.revision || state.current.revision !== command.revision)) throw new ConversationError('stale_summary');
          if (existing?.revision === command.revision && existing.state === 'registered') {
            if (!assignment.repositoryDirectories.includes(existing.repositoryDirectory)) throw new ConversationError('invalid_assignment');
            result = { kind: 'goal_registered', goal: await new GoalStore(existing.repositoryDirectory).get(existing.goalId) };
          } else {
            if (priorPending === null || priorPending.revision !== command.revision || state.current.revision !== command.revision) throw new ConversationError('stale_summary');
            if (!assignment.repositoryDirectories.includes(priorPending.repositoryDirectory)) throw new ConversationError('invalid_assignment');
            validateManagerSummary(priorPending.summary);
            nextRevision(state.current.revision);
            const reservation = existing?.revision === command.revision ? existing
              : { state: 'reserved' as const, revision: command.revision, goalId: randomUUID(), repositoryDirectory: priorPending.repositoryDirectory };
            // The reservation must be durable before creating a goal or its Git resources.
            await state.save({ approval: reservation });
            io.signal.throwIfAborted();
            const goal = await registerReservedGoal({ ...priorPending.summary, cwd: reservation.repositoryDirectory, id: reservation.goalId }, io.signal);
            return { kind: 'completed', result: { kind: 'goal_registered', goal }, change: state.change({
              approval: { ...reservation, state: 'registered' }, proposal: { revision: nextRevision(state.current.revision), pending: null },
            }) };
          }
        } else if (command.kind === 'message') {
          const resolved = await runtime.resolve(assignment, io.signal, human ? event.agentOverrides : undefined);
          try {
            const changed = state.current.session.provider !== resolved.provider || state.current.session.model !== resolved.model
              || contextKey !== undefined && contextKey !== resolved.contextKey;
            if (changed) await state.save({ session: { provider: resolved.provider, model: resolved.model, sessionId: null } });
            contextKey = resolved.contextKey;
            language = resolved.language;
            const previousDenials = denials;
            denials = [];
            const businessContext = assignment.kind === 'daemon' ? '' : await buildTurnBusinessContext(assignment, priorPending);
            const speaker = directorMessage ? { namespace: 'agent', id: 'director' } : human ? event.speaker : undefined;
            const output = await resolved.executor.execute({
              prompt: [command.text, ...(speaker?.namespace === 'agent' ? [`Speaker: ${JSON.stringify(speaker)}`] : []),
                ...(previousDenials.length === 0 ? [] : [`Previous tool permission denials: ${JSON.stringify(previousDenials)}`])].join('\n\n'),
              instruction: command.text, sessionId: state.current.session.sessionId ?? undefined,
              assignment: assignment.kind === 'daemon' ? undefined : identityOf(assignment),
              abortSignal: io.signal, configDirectory, conversationOperationId: input.turn.operationId, directorMessage,
              ...(eventGoal === undefined ? {} : { goal: { id: eventGoal.goal.id, repositoryDirectory: eventGoal.repositoryDirectory, constraints: eventGoal.goal.constraints } }),
              recovery: { context: businessContext, invalidateSession: () => state.save({ session: { ...state.current.session, sessionId: null } }) },
              onNotification: io.progress, onDenial: (reason) => { if (!io.signal.aborted) denials.push(reason); },
            });
            io.signal.throwIfAborted();
            const latest = assignment.kind === 'daemon' ? assignment
              : await resolveCurrentManagerAssignment(identityOf(assignment), configDirectory);
            if (conversationId(identityOf(latest)) !== input.turn.conversationId) {
              io.progress(getLabel('manager.conversation.assignment_changed', language));
            }
            let pending: PendingSummary | null = null;
            if (output.summary !== null) {
              if (!human || assignment.kind === 'daemon') throw new Error('Event turns cannot propose a registration');
              const { repositoryDirectory: requested, ...summary } = output.summary;
              const target = requested ?? (assignment.kind === 'repository' ? assignment.repositoryDirectory : undefined);
              if (target === undefined) throw new ConversationError('invalid_assignment');
              const repositoryDirectory = await resolveAssignedProjectRoot(target, assignment);
              if (!latest.repositoryDirectories.includes(repositoryDirectory)) throw new ConversationError('invalid_assignment');
              validateManagerSummary(summary);
              pending = { revision: state.current.revision, repositoryDirectory, summary };
            }
            if (!human && !directorMessage && assignment.kind !== 'daemon' && eventGoal !== undefined) {
              await new GoalStore(eventGoal.repositoryDirectory).update(eventGoal.goal.id, (goal) => appendGoalWorkLog(goal, { summary: output.message }));
            }
            return { kind: 'completed', result: { kind: 'reply', message: output.message }, change: state.change({
              session: { ...state.current.session, sessionId: output.sessionId ?? null },
              ...(human && assignment.kind !== 'daemon' ? { proposal: { revision: state.current.revision, pending } } : {}),
            }) };
          } finally { await resolved.release?.(); }
        } else if (assignment.kind !== 'daemon') switch (command.kind) {
          case 'dismiss_summary': result = { kind: 'reply', message: getLabel('manager.conversation.dismissed', language) }; break;
          case 'answer_question': result = await answerConversationInquiry(command, assignment, configDirectory, io.signal, language); break;
          case 'pause_goal': case 'resume_goal': case 'abort_goal': {
            const repository = await findAssignedGoalRepository(command.goalId, assignment);
            const status = command.kind === 'pause_goal' ? 'paused' : command.kind === 'resume_goal' ? 'active' : 'aborted';
            await setGoalExecutionStatus(repository, command.goalId, status, io.signal);
            if (status === 'aborted') new TaskRunner(repository).invalidatePendingGoalTasks(command.goalId);
            if (status === 'active') await ensureManagerRun(repository);
            result = { kind: 'reply', message: getLabel(status === 'paused' ? 'manager.goalPaused' : status === 'active' ? 'manager.goalResumed' : 'manager.goalAborted', language, { goalId: command.goalId }) };
            break;
          }
          default: throw new ConversationError('invalid_input');
        } else throw new ConversationError('invalid_input');
        io.signal.throwIfAborted();
        return { kind: 'completed', result };
      } catch (error) {
        if (io.signal.aborted) {
          denials = [];
          return { kind: 'interrupted', change: state.change({ session: { ...state.current.session, sessionId: null } }) };
        }
        if (command.kind === 'message' && assignment.kind !== 'daemon') {
          const notice = await notifyManagerTurnFailure(cwd, undefined, error);
          if (notice !== undefined) io.progress(notice);
        }
        return { kind: 'completed', result: conversationErrorResult(error, language) };
      } finally {
        if (assignment.kind !== 'daemon') {
          for (const directory of assignment.repositoryDirectories) await ensureManagerRun(directory);
        }
      }
    },
  };
}
