import { z } from 'zod/v4';
import { GoalStore } from '../../infra/goals/store.js';
import { tryWithGoalTurn, withGoalTurns, type GoalTurnOwners } from '../../infra/goals/turn-lock.js';
import { TaskRunner } from '../../infra/task/runner.js';
import { isStaleRunningTask } from '../../infra/task/process.js';
import { recordGoalCompletion, reconcileGoalTasks } from '../../infra/goals/reconcile.js';
import type { Goal, GoalTaskResult } from '../../infra/goals/schema.js';
import { recordManagerRunFailure } from '../../infra/task/manager-run-state.js';
import { createManagerConversationPlan } from './conversationPlan.js';
import { createGoalConfirmation } from './goalConfirmation.js';
import { prepareManagerMcp } from './managerMcp.js';
import { createMcpAdapter } from '../../infra/providers/mcp/index.js';
import { buildMcpServerSetIdentity } from '../../infra/config/runtime-provider/mcp-schema.js';
import { ensureManagerRun } from './autoRun.js';
import { createLogger } from '../../shared/utils/debug.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import { toManagerOutputSchema } from './outputSchema.js';

const responseSchema = z.object({ message: z.string().min(1), summary: z.null() }).strict();
const outputSchema = toManagerOutputSchema(responseSchema);
const log = createLogger('manager-completion');
type PendingGoalEvent =
  | { kind: 'completion'; event: NonNullable<Goal['events']>[number] }
  | { kind: 'answer'; event: NonNullable<Goal['answerEvents']>[number] };

function pendingGoalEvents(goal: Goal): PendingGoalEvent[] {
  return [
    ...(goal.events ?? []).filter((event) => !event.processed).map((event) => ({ kind: 'completion' as const, event })),
    ...(goal.answerEvents ?? []).filter((event) => !event.processed).map((event) => ({ kind: 'answer' as const, event })),
  ];
}

export async function processGoalCompletions(cwd: string, goalId: string, overrides: AssistantCliOverrides = {}, completion?: {
  taskName: string; runSlug: string; result: GoalTaskResult;
}, signal?: AbortSignal): Promise<void> {
  await runGoalCompletionTurn(cwd, goalId, overrides, completion, undefined, signal);
}

export async function processGoalAnswers(cwd: string, goalId: string, overrides: AssistantCliOverrides, signal?: AbortSignal): Promise<void> {
  await runGoalCompletionTurn(cwd, goalId, overrides, undefined, undefined, signal);
}

async function runGoalCompletionTurn(
  cwd: string, goalId: string, overrides: AssistantCliOverrides,
  completion: { taskName: string; runSlug: string; result: GoalTaskResult } | undefined,
  recovery: { interrupted: boolean } | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const store = new GoalStore(cwd);
  let turnStarted = false;
  try {
    signal?.throwIfAborted();
    await store.get(goalId);
    const turn = async (owners: GoalTurnOwners): Promise<void> => {
      await store.get(goalId);
      signal?.throwIfAborted();
      if (recovery?.interrupted) new TaskRunner(cwd).failInterruptedRunningTasks(goalId);
      if (completion !== undefined) await recordGoalCompletion(cwd, goalId, completion);
      await reconcileGoalTasks(cwd, goalId);
      const pending = pendingGoalEvents(await store.get(goalId));
      signal?.throwIfAborted();
      if (pending.length === 0) return;
      turnStarted = true;
      const plan = createManagerConversationPlan(cwd, overrides);
      const confirmation = createGoalConfirmation(cwd);
      const mcp = await prepareManagerMcp(confirmation.publicKey, owners);
      try {
        signal?.throwIfAborted();
        await plan.ctx.provider.preflight?.({
          cwd, model: plan.ctx.model, providerOptions: plan.ctx.providerOptions,
          abortSignal: signal,
          allowedTools: plan.strategy.allowedTools, mcpOnlySideEffects: plan.strategy.allowedTools,
          permissionMode: 'readonly', mcpServers: mcp.servers, outputSchema,
        });
        signal?.throwIfAborted();
        const adapter = createMcpAdapter(plan.ctx.providerType);
        const resolved = {
          enabled: true, servers: mcp.servers, serverNames: Object.keys(mcp.servers).sort(),
          identity: buildMcpServerSetIdentity(mcp.servers),
        };
        adapter.validate(resolved);
        const agent = plan.ctx.provider.setup({ name: 'manager', systemPrompt: plan.strategy.systemPrompt });
        for (const pendingEvent of pending) {
          const goal = (await store.get(goalId));
          const currentEvent = pendingEvent.kind === 'completion'
            ? goal.events?.find((saved) => saved.taskName === pendingEvent.event.taskName && saved.runSlug === pendingEvent.event.runSlug && !saved.processed)
            : goal.answerEvents?.find((saved) => saved.questionId === pendingEvent.event.questionId && !saved.processed);
          if (currentEvent === undefined) continue;
          signal?.throwIfAborted();
          const prepared = await adapter.prepare(resolved, { cwd, permissionMode: 'readonly', abortSignal: signal });
          let response;
          try {
            signal?.throwIfAborted();
            const session = goal.sessions?.find((saved) => saved.provider === plan.ctx.providerType);
            response = await agent.call(JSON.stringify({ goal, event: currentEvent }), {
              cwd, model: plan.ctx.model, sessionId: session?.sessionId,
              abortSignal: signal,
              providerOptions: plan.ctx.providerOptions, permissionMode: 'readonly',
              allowedTools: plan.strategy.allowedTools, mcpOnlySideEffects: plan.strategy.allowedTools,
              mcpServers: mcp.servers, preparedMcp: prepared, outputSchema, language: plan.ctx.lang,
            });
          } finally { await prepared.dispose(); }
          signal?.throwIfAborted();
          if (response.status !== 'done') throw new Error(response.error ?? 'Manager completion turn failed');
          const reply = responseSchema.parse(response.structuredOutput ?? JSON.parse(response.content));
          await store.update(goalId, (current) => {
            signal?.throwIfAborted();
            return {
              ...current,
              sessions: response.sessionId === undefined ? current.sessions : [
                ...(current.sessions ?? []).filter((saved) => saved.provider !== plan.ctx.providerType),
                { provider: plan.ctx.providerType, sessionId: response.sessionId },
              ],
              ...(pendingEvent.kind === 'completion' ? {
                events: current.events?.map((saved) => saved.taskName === pendingEvent.event.taskName && saved.runSlug === pendingEvent.event.runSlug
                  ? { ...saved, processed: true, summary: reply.message } : saved),
              } : {
                answerEvents: current.answerEvents?.map((saved) => saved.questionId === pendingEvent.event.questionId
                  ? { ...saved, processed: true, summary: reply.message } : saved),
              }),
            };
          });
        }
      } finally { await mcp.dispose(); }
    };
    if (recovery !== undefined) await tryWithGoalTurn(cwd, goalId, turn);
    else await withGoalTurns(cwd, [goalId], turn, {}, signal);
  } catch (error) {
    if (signal?.aborted !== true) recordManagerRunFailure(cwd, error);
    log.error('Manager event remains pending', { goalId, error: sanitizeSensitiveText(getErrorMessage(error)) });
  } finally {
    if (turnStarted && signal?.aborted !== true) {
      try { await ensureManagerRun(cwd); }
      catch (error) { log.error('Failed to judge manager run startup', { goalId, error: sanitizeSensitiveText(getErrorMessage(error)) }); }
    }
  }
}

export async function recoverManagerEvents(cwd: string, overrides: AssistantCliOverrides = {}, signal?: AbortSignal): Promise<void> {
  try {
    signal?.throwIfAborted();
    const { goals, errors } = await new GoalStore(cwd).list();
    signal?.throwIfAborted();
    for (const { goalId, error } of errors) {
      log.error('Cannot recover unreadable manager goal', { goalId, error: sanitizeSensitiveText(getErrorMessage(error)) });
    }
    if (goals.length === 0) return;
    const tasks = new TaskRunner(cwd).listTaskStateItems();
    for (const goal of goals) {
      signal?.throwIfAborted();
      const interrupted = tasks.some((task) => task.goalId === goal.id
        && task.status === 'running' && isStaleRunningTask(task.ownerPid, task.ownerStartTime));
      const pending = interrupted || goal.events?.some((event) => !event.processed)
        || goal.answerEvents?.some((event) => !event.processed)
        || tasks.some((task) => task.goalId === goal.id && (
          (task.goalPurpose !== undefined && !goal.workUnits?.some((unit) => unit.taskName === task.name))
          || (task.completion !== undefined && task.runSlug !== undefined
            && !goal.events?.some((event) => event.taskName === task.name && event.runSlug === task.runSlug))
        ));
      if (pending) await runGoalCompletionTurn(cwd, goal.id, overrides, undefined, { interrupted }, signal);
    }
  } catch (error) {
    // Goal recovery must not prevent ordinary queued tasks from running.
    if (signal?.aborted !== true) recordManagerRunFailure(cwd, error);
  }
}
