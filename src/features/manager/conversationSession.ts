import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod/v4';
import { GoalCreateInputSchema, GoalSchema, type Goal } from '../../infra/goals/schema.js';
import { createMcpAdapter } from '../../infra/providers/mcp/index.js';
import { buildMcpServerSetIdentity } from '../../infra/config/runtime-provider/mcp-schema.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { toDisplayText } from '../tui/displayText.js';
import type { ManagerConversationPlan } from './conversationPlan.js';
import type { GoalConfirmationAuthority, ManagerGoalSummary } from './goalConfirmation.js';
import { ensureManagerRun } from './autoRun.js';
import { GoalStore } from '../../infra/goals/store.js';
import { withGoalTurns } from '../../infra/goals/turn-lock.js';
import { answerGoalQuestion } from '../../infra/goals/questions.js';
import { processGoalAnswers } from './completionTurn.js';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import { toManagerOutputSchema } from './outputSchema.js';

const summarySchema = GoalCreateInputSchema.omit({ cwd: true, confirmation: true, creationOrigin: true })
  .refine((summary) => [
    summary.objective, ...summary.outOfScope, ...summary.acceptanceCriteria,
    ...(summary.startBranch === undefined ? [] : [summary.startBranch]),
    ...(summary.integrationBranch === undefined ? [] : [summary.integrationBranch]),
  ].every((value) => toDisplayText(value) === value), 'Summary contains unsafe display characters');
const responseSchema = z.object({ message: z.string().min(1), summary: summarySchema.nullable() }).strict();
export const managerOutputSchema = toManagerOutputSchema(responseSchema);
export interface PendingManagerSummary { revision: number; summary: ManagerGoalSummary }
type ManagerTurnResult =
  | { kind: 'reply'; message: string }
  | { kind: 'error'; message: string };
type ManagerResult = ManagerTurnResult
  | { kind: 'goal_registered'; goal: Goal; turn: ManagerTurnResult };

export function createManagerConversationSession(input: {
  cwd: string;
  plan: ManagerConversationPlan;
  confirmation: GoalConfirmationAuthority;
  mcpClient: Pick<Client, 'callTool'>;
  agentOverrides?: AssistantCliOverrides;
}) {
  const { cwd, plan, confirmation, mcpClient } = input;
  const agent = plan.ctx.provider.setup({ name: 'manager', systemPrompt: plan.strategy.systemPrompt });
  let generation = 0;
  let pending: PendingManagerSummary | null = null;
  let active: AbortController | null = null;
  let registering = false;
  let sessionId: string | undefined;
  let closed = false;
  const operations = new Set<Promise<ManagerResult>>();
  const track = <T extends ManagerResult>(operation: Promise<T>): Promise<T> => {
    operations.add(operation);
    void operation.then(() => operations.delete(operation), () => operations.delete(operation));
    return operation;
  };

  const invalidate = (): void => { generation += 1; pending = null; };
  const session = {
    async answerQuestion(options: { goalId: string; questionId: string; text: string; abortSignal?: AbortSignal }): Promise<ManagerTurnResult> {
      if (closed || registering || active !== null) return { kind: 'error', message: 'Manager session is unavailable' };
      invalidate();
      const controller = new AbortController();
      active = controller;
      const cancel = (): void => { controller.abort(); };
      options.abortSignal?.addEventListener('abort', cancel, { once: true });
      if (options.abortSignal?.aborted) cancel();
      try {
        await withGoalTurns(cwd, [options.goalId], async () => {
          controller.signal.throwIfAborted();
          await new GoalStore(cwd).update(options.goalId, (goal) => answerGoalQuestion(goal, options.questionId, options.text));
        }, {}, controller.signal);
        await processGoalAnswers(cwd, options.goalId, input.agentOverrides ?? {}, controller.signal);
        return { kind: 'reply', message: 'Answer saved' };
      } catch (error) {
        return { kind: 'error', message: getErrorMessage(error) };
      } finally {
        options.abortSignal?.removeEventListener('abort', cancel);
        if (active === controller) active = null;
      }
    },
    getPendingSummary(): PendingManagerSummary | null {
      return pending === null ? null : structuredClone(pending);
    },
    async handleUserMessage(options: { text: string; abortSignal?: AbortSignal }): Promise<ManagerTurnResult> {
      if (closed) return { kind: 'error', message: 'Manager session is closed' };
      if (registering) return { kind: 'error', message: 'Goal registration is in progress' };
      if (active !== null) return { kind: 'error', message: 'A conversation turn is already running' };
      invalidate();
      const turn = generation;
      const controller = new AbortController();
      active = controller;
      const cancel = (): void => {
        controller.abort();
        if (generation === turn) {
          invalidate();
          sessionId = undefined;
          active = null;
        }
      };
      options.abortSignal?.addEventListener('abort', cancel, { once: true });
      if (options.abortSignal?.aborted) cancel();
      let prepared: Awaited<ReturnType<ReturnType<typeof createMcpAdapter>['prepare']>> | undefined;
      let result: ManagerTurnResult;
      try {
        if (controller.signal.aborted) throw new Error('Conversation interrupted');
        try {
          const servers = plan.ctx.mcpServers;
          if (servers !== undefined) {
            const adapter = createMcpAdapter(plan.ctx.providerType);
            const resolved = { enabled: true, servers, serverNames: Object.keys(servers).sort(), identity: buildMcpServerSetIdentity(servers) };
            adapter.validate(resolved);
            prepared = await adapter.prepare(resolved, { cwd, abortSignal: controller.signal, permissionMode: 'readonly' });
          }
          if (controller.signal.aborted) throw new Error('Conversation interrupted');
          const response = await agent.call(options.text, {
            cwd, model: plan.ctx.model, sessionId, abortSignal: controller.signal,
            providerOptions: plan.ctx.providerOptions,
            allowedTools: plan.strategy.allowedTools,
            mcpOnlySideEffects: plan.strategy.allowedTools,
            permissionMode: 'readonly', outputSchema: managerOutputSchema, language: plan.ctx.lang,
            mcpServers: servers, preparedMcp: prepared,
          });
          if (turn !== generation || controller.signal.aborted) throw new Error('Conversation interrupted');
          if (response.status !== 'done') throw new Error(response.error ?? 'Manager provider failed');
          const raw: unknown = response.structuredOutput ?? JSON.parse(response.content);
          const parsed = responseSchema.parse(raw);
          sessionId = response.sessionId ?? sessionId;
          pending = parsed.summary === null ? null : { revision: turn, summary: parsed.summary };
          result = { kind: 'reply', message: parsed.message };
        } finally {
          await prepared?.dispose();
        }
      } catch (error) {
        if (turn === generation) invalidate();
        result = { kind: 'error', message: getErrorMessage(error) };
      } finally {
        try { await ensureManagerRun(cwd); }
        finally {
          options.abortSignal?.removeEventListener('abort', cancel);
          if (active === controller) active = null;
        }
      }
      return result;
    },
    async approveSummary(revision: number): Promise<ManagerResult> {
      if (closed || registering || active !== null || pending === null || pending.revision !== revision) {
        return { kind: 'error', message: 'The displayed summary is no longer available for approval' };
      }
      const summary = structuredClone(pending.summary);
      registering = true;
      invalidate();
      try {
        const request = confirmation.sign(summary);
        const result = await mcpClient.callTool({ name: 'takt_create_goal', arguments: request });
        const content = result.content;
        const text = Array.isArray(content)
          ? content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
          : '';
        if (result.isError === true) throw new Error(text || 'Goal registration failed');
        const goal = z.object({ goal: GoalSchema }).parse(JSON.parse(text)).goal;
        registering = false;
        let turn: ManagerTurnResult;
        try {
          turn = await session.handleUserMessage({ text: JSON.stringify({ goalRegistered: goal }) });
        } catch (error) {
          turn = { kind: 'error', message: getErrorMessage(error) };
        }
        return { kind: 'goal_registered', goal, turn };
      } catch (error) {
        return { kind: 'error', message: getErrorMessage(error) };
      } finally {
        registering = false;
      }
    },
  };
  return {
    getPendingSummary: session.getPendingSummary,
    dismissSummary(revision: number): void {
      if (!registering && pending?.revision === revision) invalidate();
    },
    handleUserMessage: (options: { text: string; abortSignal?: AbortSignal }) => track(session.handleUserMessage(options)),
    approveSummary: (revision: number) => track(session.approveSummary(revision)),
    answerQuestion: (options: { goalId: string; questionId: string; text: string; abortSignal?: AbortSignal }) => track(session.answerQuestion(options)),
    async close(): Promise<void> {
      closed = true;
      invalidate();
      active?.abort();
      const results = await Promise.allSettled([...operations]);
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), 'Manager session cleanup failed');
    },
  };
}

export type ManagerConversationSession = ReturnType<typeof createManagerConversationSession>;
