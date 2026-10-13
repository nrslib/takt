import { saveManagerEvent } from '../../infra/goals/events.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { GoalSummarySchema, type Goal, type ManagerGoalSummary } from '../../infra/goals/schema.js';
import { isStdioServer } from '../../infra/providers/mcp/types.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from './managerMcp.js';
import { createMcpAdapter } from '../../infra/providers/mcp/index.js';
import { buildMcpServerSetIdentity } from '../../infra/config/runtime-provider/mcp-schema.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { toDisplayText } from '../tui/displayText.js';
import type { ManagerConversationPlan } from './conversationPlan.js';
import { createGoal } from '../../infra/goals/service.js';
import { ensureManagerRun } from './autoRun.js';
import { GoalStore } from '../../infra/goals/store.js';
import { answerGoalQuestion } from '../../infra/goals/questions.js';
import { setGoalExecutionStatus } from '../../infra/goals/execution.js';
import { TaskRunner } from '../../infra/task/runner.js';
import { getLabel } from '../../shared/i18n/index.js';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import type { ProviderType } from '../../infra/providers/index.js';
import { toManagerOutputSchema, toStrictManagerOutputSchema } from './outputSchema.js';

import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { MANAGER_ASSIGNMENT_ENV, findAssignedGoalRepository, resolveAssignedProjectRoot, resolveCurrentManagerAssignment, type ManagerAssignmentIdentity } from './assignment.js';

const summarySchema = GoalSummarySchema.extend({ repositoryDirectory: z.string().min(1).optional() })
  .refine((summary) => [
    summary.objective, ...summary.outOfScope, ...summary.acceptanceCriteria, ...summary.constraints,
    ...(summary.repositoryDirectory === undefined ? [] : [summary.repositoryDirectory]),
    ...(summary.startBranch === undefined ? [] : [summary.startBranch]),
    ...(summary.integrationBranch === undefined ? [] : [summary.integrationBranch]),
  ].every((value) => toDisplayText(value) === value), 'Summary contains unsafe display characters');
const responseSchema = z.object({ message: z.string().min(1), summary: summarySchema.nullable() }).strict();
const addRepositoryToolNames = new Set([
  'takt_add_workspace_repository',
  `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__takt_add_workspace_repository`,
  `${TAKT_MANAGER_MCP_SERVER_NAME}__takt_add_workspace_repository`,
  `${TAKT_MANAGER_MCP_SERVER_NAME}_takt_add_workspace_repository`,
]);
export const managerOutputSchema = toManagerOutputSchema(responseSchema);
const codexOutputSchema = toStrictManagerOutputSchema(z.object({
  message: z.string(),
  summary: z.object({
    repositoryDirectory: z.string().nullable(),
    objective: z.string(),
    outOfScope: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
    constraints: z.array(z.string()),
    startBranch: z.string().nullable(),
    integrationBranch: z.string().nullable(),
  }).strict().nullable(),
}).strict());
const codexResponseSchema = responseSchema.extend({
  summary: z.preprocess((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const summary = { ...value } as Record<string, unknown>;
    if (summary.repositoryDirectory === null) delete summary.repositoryDirectory;
    if (summary.startBranch === null) delete summary.startBranch;
    if (summary.integrationBranch === null) delete summary.integrationBranch;
    return summary;
  }, summarySchema.nullable()),
});

export function getManagerOutputSchema(providerType: ProviderType): Record<string, unknown> {
  return providerType === 'codex' ? codexOutputSchema : managerOutputSchema;
}

export interface PendingManagerSummary { revision: number; summary: ManagerGoalSummary; repositoryDirectory?: string }
type ManagerTurnResult =
  | { kind: 'reply'; message: string }
  | { kind: 'error'; message: string };
type ManagerResult = ManagerTurnResult
  | { kind: 'goal_registered'; goal: Goal; turn: ManagerTurnResult };

export function createManagerConversationSession(input: {
  cwd: string;
  assignment?: ManagerAssignmentIdentity;
  plan: ManagerConversationPlan;
  agentOverrides?: AssistantCliOverrides;
}) {
  const { cwd, plan } = input;
  const agent = plan.ctx.provider.setup({ name: 'manager', systemPrompt: plan.strategy.systemPrompt });
  let generation = 0;
  let pending: PendingManagerSummary | null = null;
  let active: AbortController | null = null;
  let registering = false;
  let sessionId: string | undefined;
  let closed = false;
  const operations = new Set<Promise<ManagerResult | null>>();
  const track = <T extends ManagerResult | null>(operation: Promise<T>): Promise<T> => {
    operations.add(operation);
    void operation.then(() => operations.delete(operation), () => operations.delete(operation));
    return operation;
  };

  let assignmentIdentity = input.assignment;
  const getAssignment = async () => {
    if (assignmentIdentity === undefined) return undefined;
    const assignment = await resolveCurrentManagerAssignment(assignmentIdentity, getGlobalConfigDir());
    if (assignment.kind === 'workspace') assignmentIdentity = { kind: 'workspace', workspaceId: assignment.workspaceId };
    return assignment;
  };
  const goalRepository = async (goalId: string): Promise<string> => {
    const assignment = await getAssignment();
    return assignment === undefined ? cwd : findAssignedGoalRepository(goalId, assignment);
  };
  const invalidate = (): void => { generation += 1; pending = null; };
  const changeGoalExecution = async (
    options: { goalId: string; abortSignal?: AbortSignal }, executionStatus: Goal['executionStatus'],
  ): Promise<ManagerTurnResult> => {
    if (closed || registering || active !== null) return { kind: 'error', message: getLabel('manager.sessionUnavailable', plan.ctx.lang) };
    invalidate();
    const controller = new AbortController();
    active = controller;
    const cancel = (): void => { controller.abort(); };
    options.abortSignal?.addEventListener('abort', cancel, { once: true });
    if (options.abortSignal?.aborted) cancel();
    try {
      const repository = await goalRepository(options.goalId);
      await setGoalExecutionStatus(repository, options.goalId, executionStatus, controller.signal);
      if (executionStatus === 'aborted') new TaskRunner(repository).invalidatePendingGoalTasks(options.goalId);
      if (executionStatus === 'active') {
        controller.signal.throwIfAborted();
        await ensureManagerRun(repository);
      }
      const label = executionStatus === 'aborted' ? 'manager.goalAborted'
        : executionStatus === 'paused' ? 'manager.goalPaused' : 'manager.goalResumed';
      return { kind: 'reply', message: getLabel(label, plan.ctx.lang, { goalId: options.goalId }) };
    } catch (error) {
      return { kind: 'error', message: getLabel('manager.goalExecutionFailed', plan.ctx.lang, { reason: getErrorMessage(error) }) };
    } finally {
      options.abortSignal?.removeEventListener('abort', cancel);
      if (active === controller) active = null;
    }
  };
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
        const repository = await goalRepository(options.goalId);
        controller.signal.throwIfAborted();
        const saved = await new GoalStore(repository).update(options.goalId, (goal) => answerGoalQuestion(goal, options.questionId, options.text));
        const answer = saved.questions!.find((question) => question.id === options.questionId)!.answer!;
        saveManagerEvent(repository, { kind: 'answer', goalId: options.goalId, questionId: options.questionId, answer });
        await ensureManagerRun(repository);
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
        }
      };
      options.abortSignal?.addEventListener('abort', cancel, { once: true });
      if (options.abortSignal?.aborted) cancel();
      let prepared: Awaited<ReturnType<ReturnType<typeof createMcpAdapter>['prepare']>> | undefined;
      let result: ManagerTurnResult;
      try {
        if (controller.signal.aborted) throw new Error('Conversation interrupted');
        try {
          const assignment = await getAssignment();
          const servers = plan.ctx.mcpServers === undefined ? undefined : Object.fromEntries(Object.entries(plan.ctx.mcpServers).map(([name, config]) => [
            name, assignmentIdentity === undefined || name !== TAKT_MANAGER_MCP_SERVER_NAME || !isStdioServer(config) ? config : { ...config, env: { ...config.env, [MANAGER_ASSIGNMENT_ENV]: JSON.stringify(assignmentIdentity) } },
          ]));
          if (servers !== undefined) {
            const adapter = createMcpAdapter(plan.ctx.providerType);
            const resolved = { enabled: true, servers, serverNames: Object.keys(servers).sort(), identity: buildMcpServerSetIdentity(servers) };
            adapter.validate(resolved);
            prepared = await adapter.prepare(resolved, { cwd, abortSignal: controller.signal, permissionMode: 'readonly' });
          }
          if (controller.signal.aborted) throw new Error('Conversation interrupted');
          const memories = await Promise.all((assignment?.repositoryDirectories ?? [cwd]).map(async (repositoryDirectory) => {
            try {
              const { goals, errors } = await new GoalStore(repositoryDirectory).list();
              return { repositoryDirectory, goals, diagnostics: errors.map(({ goalId, error }) => ({ goalId, message: getErrorMessage(error) })) };
            } catch (error) {
              return { repositoryDirectory, goals: undefined, diagnostics: [{ message: getErrorMessage(error) }] };
            }
          }));
          const text = memories.some(({ goals, diagnostics }) => (goals !== undefined && goals.length > 0) || diagnostics.length > 0)
            ? `${options.text}\n\nGoal memory (including run manager results): ${JSON.stringify(memories)}` : options.text;
          const prompt = assignment === undefined ? text : `Current manager assignment: ${JSON.stringify(assignment)}\n\n${text}`;
          const repositoryAdditionIds = new Set<string>();
          const response = await agent.call(prompt, {
            cwd, model: plan.ctx.model, sessionId, abortSignal: controller.signal,
            providerOptions: plan.ctx.providerOptions,
            allowedTools: plan.strategy.allowedTools,
            mcpOnlySideEffects: plan.strategy.allowedTools,
            permissionMode: 'readonly', outputSchema: getManagerOutputSchema(plan.ctx.providerType), language: plan.ctx.lang,
            mcpServers: servers, preparedMcp: prepared,
            onStream: (event) => {
              if (event.type === 'tool_use' && addRepositoryToolNames.has(event.data.tool)) {
                repositoryAdditionIds.add(event.data.id);
              }
              if (event.type === 'tool_result' && event.data.id !== undefined
                && repositoryAdditionIds.delete(event.data.id) && !event.data.isError) {
                try {
                  const content: unknown = JSON.parse(event.data.content);
                  const result = (Array.isArray(content)
                    ? JSON.parse(content.find((block) => block.type === 'text')?.text)
                    : content) as { workspace?: { id?: string } } | null;
                  if (result?.workspace?.id) assignmentIdentity = { kind: 'workspace', workspaceId: result.workspace.id };
                } catch { return; }
              }
            },
          });
          if (turn !== generation || controller.signal.aborted) throw new Error('Conversation interrupted');
          if (response.status !== 'done') throw new Error(response.error ?? 'Manager provider failed');
          const raw: unknown = response.structuredOutput ?? JSON.parse(response.content);
          const parsed = (plan.ctx.providerType === 'codex' ? codexResponseSchema : responseSchema).parse(raw);
          sessionId = response.sessionId ?? sessionId;
          if (parsed.summary !== null) {
            const { repositoryDirectory: requested, ...summary } = parsed.summary;
            const summaryAssignment = await getAssignment();
            if (summaryAssignment?.kind === 'workspace' && requested === undefined) throw new Error('Choose one assigned repository for the goal summary');
            const repositoryDirectory = summaryAssignment === undefined ? requested
              : await resolveAssignedProjectRoot(requested ?? cwd, summaryAssignment);
            if (turn !== generation || controller.signal.aborted) throw new Error('Conversation interrupted');
            pending = { revision: turn, summary, ...(repositoryDirectory === undefined ? {} : { repositoryDirectory }) };
          }
          result = { kind: 'reply', message: parsed.message };
        } finally {
          await prepared?.dispose();
        }
      } catch (error) {
        if (turn === generation) invalidate();
        result = { kind: 'error', message: getErrorMessage(error) };
      } finally {
        try {
          const assignment = await getAssignment();
          for (const directory of assignment?.repositoryDirectories ?? [cwd]) await ensureManagerRun(directory);
        }
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
      const { summary, repositoryDirectory } = structuredClone(pending);
      registering = true;
      invalidate();
      try {
        const assignment = await getAssignment();
        const repository = assignment === undefined ? repositoryDirectory ?? cwd
          : await resolveAssignedProjectRoot(repositoryDirectory ?? cwd, assignment);
        const goal = await createGoal({ ...summary, cwd: repository, id: randomUUID() });
        await ensureManagerRun(repository);
        return { kind: 'goal_registered', goal, turn: { kind: 'reply', message: plan.ctx.lang === 'ja' ? '最初の投入のイベントを保存しました' : 'Saved the event for initial task submission' } };
      } catch (error) {
        return { kind: 'error', message: getErrorMessage(error) };
      } finally {
        registering = false;
      }
    },
  };
  return {
    getAssignment,
    getPendingSummary: session.getPendingSummary,
    dismissSummary(revision: number): void {
      if (!registering && pending?.revision === revision) invalidate();
    },
    handleUserMessage: (options: { text: string; abortSignal?: AbortSignal }) => track(session.handleUserMessage(options)),
    approveSummary: (revision: number) => track(session.approveSummary(revision)),
    answerQuestion: (options: { goalId: string; questionId: string; text: string; abortSignal?: AbortSignal }) => track(session.answerQuestion(options)),
    pauseGoal: (options: { goalId: string; abortSignal?: AbortSignal }) => track(changeGoalExecution(options, 'paused')),
    resumeGoal: (options: { goalId: string; abortSignal?: AbortSignal }) => track(changeGoalExecution(options, 'active')),
    abortGoal: (options: { goalId: string; abortSignal?: AbortSignal }) => track(changeGoalExecution(options, 'aborted')),
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
