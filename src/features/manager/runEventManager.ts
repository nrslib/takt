import { deleteManagerEvent, readManagerEvents } from '../../infra/goals/events.js';
import { GoalStore } from '../../infra/goals/store.js';
import { appendGoalWorkLog } from '../../infra/goals/workLog.js';
import { TaskRunner } from '../../infra/task/runner.js';
import { createManagerConversationPlan } from './conversationPlan.js';
import { createManagerConversationSession, getManagerOutputSchema, type ManagerConversationSession } from './conversationSession.js';
import { connectManagerMcp } from './managerMcp.js';
import { buildGoalTurnContext } from './turnContext.js';
import { notifyManagerTurnFailure } from './turnFailureNotification.js';

export function createRunEventManager(cwd: string) {
  let session: ManagerConversationSession | undefined;
  let mcp: Awaited<ReturnType<typeof connectManagerMcp>> | undefined;
  const getSession = async (signal: AbortSignal): Promise<ManagerConversationSession> => {
    if (session !== undefined) return session;
    const plan = createManagerConversationPlan(cwd, {});
    mcp = await connectManagerMcp(cwd);
    await plan.ctx.provider.preflight?.({
      cwd, abortSignal: signal, model: plan.ctx.model, providerOptions: plan.ctx.providerOptions,
      allowedTools: plan.strategy.allowedTools, mcpOnlySideEffects: plan.strategy.allowedTools,
      permissionMode: 'readonly', mcpServers: mcp.servers,
      outputSchema: getManagerOutputSchema(plan.ctx.providerType),
    });
    session = createManagerConversationSession({
      cwd, plan: { ...plan, ctx: { ...plan.ctx, mcpServers: mcp.servers } },
    });
    return session;
  };
  return {
    async processPending(signal: AbortSignal): Promise<boolean> {
      let handled = false;
      while (!signal.aborted) {
        let processed = false;
        for (const saved of readManagerEvents(cwd)) {
          if (signal.aborted) return handled;
          try {
            const store = new GoalStore(cwd);
            const goal = await store.get(saved.event.goalId);
            if (goal.executionStatus === 'paused') continue;
            if (goal.executionStatus !== 'aborted') {
              const manager = await getSession(signal);
              const result = await manager.handleUserMessage({
                text: buildGoalTurnContext(cwd, goal, saved.event, new TaskRunner(cwd).listTaskStateItems()),
                abortSignal: signal,
              });
              if (signal.aborted) return handled;
              if (result.kind === 'error') throw new Error(result.message);
              const summary = manager.getPendingSummary();
              if (summary !== null) {
                manager.dismissSummary(summary.revision);
                throw new Error('Event processing requires actions for the existing goal, not a registration summary');
              }
              await store.update(goal.id, (current) => appendGoalWorkLog(current, { summary: result.message }));
            }
            deleteManagerEvent(saved);
            processed = true;
            handled = true;
          } catch (error) {
            if (signal.aborted) return handled;
            await notifyManagerTurnFailure(cwd, saved.event.goalId, error);
            throw error;
          }
        }
        if (!processed) return handled;
      }
      return handled;
    },
    async close(): Promise<void> {
      try { await session?.close(); } finally { await mcp?.dispose(); }
    },
  };
}
