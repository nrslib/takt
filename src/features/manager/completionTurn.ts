import { z } from 'zod/v4';
import { GoalStore } from '../../infra/goals/store.js';
import { getRegisteredGoal, listRegisteredGoals } from '../../infra/goals/registration.js';
import { withGoalTurns } from '../../infra/goals/turn-lock.js';
import { recordGoalCompletion, reconcileGoalTasks } from '../../infra/goals/reconcile.js';
import type { GoalTaskResult } from '../../infra/goals/schema.js';
import { markGoalCompletionProcessed, verifiedGoalCompletionContext } from '../../infra/goals/completion-evidence.js';
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

const responseSchema = z.object({ message: z.string().min(1), summary: z.null() }).strict();
const outputSchema = z.toJSONSchema(responseSchema) as Record<string, unknown>;
const log = createLogger('manager-completion');

export async function processGoalCompletions(cwd: string, goalId: string, overrides: AssistantCliOverrides = {}, completion?: {
  taskName: string; runSlug: string; result: GoalTaskResult;
}): Promise<void> {
  let turnStarted = false;
  try {
    await getRegisteredGoal(cwd, goalId);
    if (completion !== undefined) await recordGoalCompletion(cwd, goalId, completion);
    await withGoalTurns(cwd, [goalId], async (owners) => {
      await getRegisteredGoal(cwd, goalId);
      await reconcileGoalTasks(cwd, goalId);
      const store = new GoalStore(cwd);
      const pending = verifiedGoalCompletionContext(cwd, await getRegisteredGoal(cwd, goalId)).events?.filter((event) => !event.processed) ?? [];
      if (pending.length === 0) return;
      turnStarted = true;
      const plan = createManagerConversationPlan(cwd, overrides);
      const confirmation = createGoalConfirmation(cwd);
      const mcp = await prepareManagerMcp(confirmation.publicKey, owners);
      try {
        await plan.ctx.provider.preflight?.({
          cwd, model: plan.ctx.model, providerOptions: plan.ctx.providerOptions,
          allowedTools: plan.strategy.allowedTools, mcpOnlySideEffects: plan.strategy.allowedTools,
          permissionMode: 'readonly', mcpServers: mcp.servers, outputSchema,
        });
        const adapter = createMcpAdapter(plan.ctx.providerType);
        const resolved = {
          enabled: true, servers: mcp.servers, serverNames: Object.keys(mcp.servers).sort(),
          identity: buildMcpServerSetIdentity(mcp.servers),
        };
        adapter.validate(resolved);
        const agent = plan.ctx.provider.setup({ name: 'manager', systemPrompt: plan.strategy.systemPrompt });
        for (const event of pending) {
          const goal = verifiedGoalCompletionContext(cwd, await getRegisteredGoal(cwd, goalId));
          const currentEvent = goal.events?.find((saved) => saved.taskName === event.taskName && saved.runSlug === event.runSlug && !saved.processed);
          if (currentEvent === undefined) continue;
          const prepared = await adapter.prepare(resolved, { cwd, permissionMode: 'readonly' });
          let response;
          let session: { provider: string; sessionId: string } | undefined;
          try {
            const verified = verifiedGoalCompletionContext(cwd, await getRegisteredGoal(cwd, goalId));
            const verifiedEvent = verified.events?.find((saved) => saved.taskName === currentEvent.taskName && saved.runSlug === currentEvent.runSlug && !saved.processed);
            if (verifiedEvent === undefined) continue;
            session = verified.sessions?.find((saved) => saved.provider === plan.ctx.providerType);
            response = await agent.call(JSON.stringify({ goal: verified, event: verifiedEvent }), {
              cwd, model: plan.ctx.model, sessionId: session?.sessionId,
              providerOptions: plan.ctx.providerOptions, permissionMode: 'readonly',
              allowedTools: plan.strategy.allowedTools, mcpOnlySideEffects: plan.strategy.allowedTools,
              mcpServers: mcp.servers, preparedMcp: prepared, outputSchema, language: plan.ctx.lang,
            });
          } finally { await prepared.dispose(); }
          if (response.status !== 'done') throw new Error(response.error ?? 'Manager completion turn failed');
          const reply = responseSchema.parse(response.structuredOutput ?? JSON.parse(response.content));
          markGoalCompletionProcessed(cwd, goalId, currentEvent, reply.message,
            response.sessionId === undefined ? session : { provider: plan.ctx.providerType, sessionId: response.sessionId });
          await store.update(goalId, (current) => ({
            ...current,
            sessions: verifiedGoalCompletionContext(cwd, current).sessions,
            events: current.events?.map((saved) => saved.taskName === event.taskName && saved.runSlug === event.runSlug
              ? { ...currentEvent, processed: true, summary: reply.message } : saved),
          }));
        }
      } finally { await mcp.dispose(); }
    });
  } catch (error) {
    recordManagerRunFailure(cwd, error);
    log.error('Manager event remains pending', { goalId, error: sanitizeSensitiveText(getErrorMessage(error)) });
  } finally {
    if (turnStarted) {
      try { await ensureManagerRun(cwd, 'turn-ended'); }
      catch (error) { log.error('Failed to judge manager run startup', { goalId, error: sanitizeSensitiveText(getErrorMessage(error)) }); }
    }
  }
}

export async function recoverManagerEvents(cwd: string): Promise<void> {
  const { goals, errors } = await listRegisteredGoals(cwd);
  for (const { goalId, error } of errors) {
    log.error('Cannot recover unverified manager goal', { goalId, error: sanitizeSensitiveText(getErrorMessage(error)) });
  }
  for (const goal of goals) {
    await processGoalCompletions(cwd, goal.id);
  }
}
