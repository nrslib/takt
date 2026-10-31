import { deleteManagerEvent, readManagerEvents, type SavedManagerEvent } from '../../infra/goals/events.js';
import type { Goal } from '../../infra/goals/schema.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import { GoalStore } from '../../infra/goals/store.js';
import { appendGoalWorkLog } from '../../infra/goals/workLog.js';
import { TaskRunner } from '../../infra/task/runner.js';
import { error as logError } from '../../shared/ui/index.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { createManagerConversationPlan } from './conversationPlan.js';
import { getManagerOutputSchema } from './turnResponse.js';
import { createManagerTurnExecutor } from './turnExecutor.js';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { ensureManagerRun } from './autoRun.js';
import { connectManagerMcp } from './managerMcp.js';
import { buildGoalTurnContext } from './turnContext.js';
import { notifyManagerTurnFailure } from './turnFailureNotification.js';
import { isGoalPatrolDue } from './patrol.js';
import { supportsManagerPermissionJudge } from './permissionJudgeSupport.js';
import { randomUUID } from 'node:crypto';
import { ManagerTurnScheduler } from './managerTurnScheduler.js';
import { resolveCurrentManagerAssignment } from './assignment.js';
import { conversationId } from '../../infra/conversations/identity.js';

const MANAGER_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export function createRunEventManager(cwd: string, scheduler?: ManagerTurnScheduler) {
  const turns = scheduler ?? new ManagerTurnScheduler();
  // Failed events remain in the inbox; polling does not retry them.
  const failedEvents = new Set<string>();
  let executor: ReturnType<typeof createManagerTurnExecutor> | undefined;
  let mcp: Awaited<ReturnType<typeof connectManagerMcp>> | undefined;
  const getExecutor = async (signal: AbortSignal) => {
    if (executor !== undefined) return executor;
    const plan = createManagerConversationPlan(cwd, {});
    mcp = await connectManagerMcp(cwd, undefined, plan.ctx.mcpServers, {
      enableGoalExecutionTools: supportsManagerPermissionJudge(plan.ctx.providerType),
    });
    try {
      await plan.ctx.provider.preflight?.({
        cwd, abortSignal: signal, model: plan.ctx.model, providerOptions: plan.ctx.providerOptions,
        permissionMode: 'full', mcpServers: mcp.servers,
        outputSchema: getManagerOutputSchema(plan.ctx.providerType),
      });
    } catch (error) {
      const started = mcp;
      mcp = undefined;
      await started.dispose();
      throw error;
    }
    executor = createManagerTurnExecutor(cwd, { ...plan, ctx: { ...plan.ctx, mcpServers: mcp.servers } });
    return executor;
  };
  const canProcessPatrol = (goal: Goal, saved: SavedManagerEvent): boolean => {
    const { patrolInterval } = resolveManagerConfig(cwd);
    return isGoalPatrolDue(goal, Date.now(), patrolInterval)
      && (goal.lastPatrolCompletedAt === undefined || Date.parse(saved.event.createdAt) > Date.parse(goal.lastPatrolCompletedAt));
  };
  const processEvent = async (saved: SavedManagerEvent, signal: AbortSignal, budget: { remaining: number }): Promise<boolean> => {
    budget.remaining--;
    const store = new GoalStore(cwd);
    const patrol = saved.event.kind === 'patrol';
    let release: (() => void) | undefined;
    try {
      let goal = await store.get(saved.event.goalId);
      if (patrol && !canProcessPatrol(goal, saved)) {
        deleteManagerEvent(saved);
        return true;
      }
      if (goal.executionStatus === 'paused') {
        budget.remaining++;
        return false;
      }
      if (goal.executionStatus !== 'aborted') {
        if (patrol) {
          // Retry failures only when a due patrol is being handled, never on ordinary polls.
          for (const failed of readManagerEvents(cwd)) {
            if (signal.aborted) return false;
            if (budget.remaining === 0) break;
            if (failed.event.kind === 'patrol' || !failedEvents.has(failed.filePath)) continue;
            await processEvent(failed, signal, budget);
          }
        }
        if (signal.aborted) return false;
        const identity = { kind: 'repository' as const, repositoryDirectory: cwd };
        const assignment = await resolveCurrentManagerAssignment(identity, getGlobalConfigDir());
        release = await turns.acquire(conversationId(assignment), randomUUID(), signal);
        goal = await store.get(saved.event.goalId);
        if (patrol && !canProcessPatrol(goal, saved)) {
          deleteManagerEvent(saved);
          return true;
        }
        if (goal.executionStatus === 'paused') { budget.remaining++; return false; }
        if (goal.executionStatus === 'aborted') {
          deleteManagerEvent(saved);
          failedEvents.delete(saved.filePath);
          return true;
        }
        const timeout = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
          timeout.abort(new Error('Manager provider produced no output for 30 minutes'));
        }, MANAGER_IDLE_TIMEOUT_MS);
        const turnSignal = AbortSignal.any([signal, timeout.signal]);
        try {
          const runner = await getExecutor(turnSignal);
          turnSignal.throwIfAborted();
          if (patrol) {
            goal = await store.get(saved.event.goalId);
            if (!canProcessPatrol(goal, saved)) {
              deleteManagerEvent(saved);
              return true;
            }
          }
          const prompt = buildGoalTurnContext(cwd, goal, saved.event, new TaskRunner(cwd).listTaskStateItems());
          let result;
          try {
            result = await runner.execute({
              prompt, instruction: prompt, sessionId: undefined, abortSignal: turnSignal,
              assignment: { kind: 'repository', repositoryDirectory: cwd }, configDirectory: getGlobalConfigDir(),
              goal: { id: goal.id, repositoryDirectory: cwd, constraints: goal.constraints },
              onProviderOutput: () => { if (!turnSignal.aborted) timer?.refresh(); },
            });
          } finally { await ensureManagerRun(cwd); }
          if (signal.aborted) return false;
          if (result.summary !== null) {
            throw new Error('Event processing requires actions for the existing goal, not a registration summary');
          }
          await store.update(goal.id, (current) => ({
            ...appendGoalWorkLog(current, { summary: result.message, ...(patrol ? { kind: 'patrol' as const } : {}) }),
            ...(patrol ? { lastPatrolCompletedAt: new Date().toISOString() } : {}),
          }));
        } catch (error) {
          if (turnSignal.aborted) throw turnSignal.reason;
          throw error;
        } finally {
          clearTimeout(timer);
          timer = undefined;
        }
      }
      deleteManagerEvent(saved);
      failedEvents.delete(saved.filePath);
      return true;
    } catch (error) {
      if (signal.aborted) return false;
      logError(`Manager could not handle ${saved.event.kind} event for goal ${saved.event.goalId}: ${sanitizeSensitiveText(getErrorMessage(error))}`);
      await notifyManagerTurnFailure(cwd, saved.event.goalId, error);
      if (patrol) {
        await store.update(saved.event.goalId, (current) => ({ ...current, lastPatrolCompletedAt: new Date().toISOString() }));
        deleteManagerEvent(saved);
        return true;
      }
      failedEvents.add(saved.filePath);
      return false;
    } finally {
      release?.();
    }
  };
  return {
    async processPending(signal: AbortSignal, maxEvents: number): Promise<boolean> {
      let handled = false;
      const budget = { remaining: maxEvents };
      const failedAtPollStart = new Set(failedEvents);
      for (const saved of readManagerEvents(cwd)) {
        if (signal.aborted || budget.remaining <= 0) return handled;
        if (failedAtPollStart.has(saved.filePath)) continue;
        if (await processEvent(saved, signal, budget)) handled = true;
      }
      return handled;
    },
    async close(): Promise<void> {
      await mcp?.dispose();
    },
  };
}
