import { TurnToolScope } from '../daemonTurn/toolScope.js';
import { createHash } from 'node:crypto';
import { createWorkspaceManagerContext } from './startupResolution.js';
import { conversationId } from '../../infra/conversations/identity.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import { createManagerConversationPlan } from './conversationPlan.js';
import type { ManagerConversationTurn } from './managerMcpConnection.js';
import { connectManagerMcp } from './managerMcp.js';
import { supportsManagerPermissionJudge } from './permissionJudgeSupport.js';
import { getManagerOutputSchema } from './turnResponse.js';
import { createManagerTurnExecutor } from './turnExecutor.js';
import type { ProviderType } from '../../infra/providers/types.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import type { ConversationDisplayAssignment } from './conversationPort.js';

export interface PreparedConversationRuntime {
  provider: ProviderType;
  model: string | null;
  language: 'ja' | 'en';
  contextKey: string;
  executor: ReturnType<typeof createManagerTurnExecutor>;
  release?(): Promise<void>;
}
export interface ConversationRuntime {
  resolve(assignment: ConversationDisplayAssignment, signal: AbortSignal, agentOverrides?: AssistantCliOverrides): Promise<PreparedConversationRuntime>;
  close(): Promise<void>;
}

export function createConversationRuntime(configDirectory: string): ConversationRuntime {
  const entries = new Map<string, PreparedConversationRuntime & { dispose(): Promise<void> }>();
  return {
    async resolve(assignment, signal, agentOverrides) {
      if (assignment.kind === 'daemon') throw new Error('Director runtime is required for daemon conversations');
      const identity: ConversationAssignment = assignment.kind === 'workspace'
        ? { kind: 'workspace', workspaceId: assignment.workspaceId }
        : { kind: 'repository', repositoryDirectory: assignment.repositoryDirectory };
      const cwd = assignment.kind === 'repository' ? assignment.repositoryDirectory
        : createWorkspaceManagerContext({ id: assignment.workspaceId, name: assignment.name, repositoryDirectories: assignment.repositoryDirectories }, configDirectory).cwd;
      const plan = createManagerConversationPlan(cwd, agentOverrides ?? {});
      const contextKey = createHash('sha256').update(JSON.stringify({
        provider: plan.ctx.providerType, model: plan.ctx.model, options: plan.ctx.providerOptions,
        mcp: plan.ctx.mcpServers, prompt: plan.strategy.systemPrompt, assignment,
        language: plan.ctx.lang, permissionJudge: plan.permissionJudge, sensitivePaths: resolveManagerConfig(cwd).sensitivePaths,
      })).digest('hex');
      const id = conversationId(identity);
      const existing = entries.get(id);
      if (existing?.contextKey === contextKey) return existing;
      if (existing !== undefined) { await existing.dispose(); entries.delete(id); }
      const turnScope = new TurnToolScope();
      let activeTurn: (ManagerConversationTurn & { signal: AbortSignal }) | undefined;
      const mcp = await connectManagerMcp(cwd, identity, plan.ctx.mcpServers, {
        turnScope,
        enableGoalExecutionTools: supportsManagerPermissionJudge(plan.ctx.providerType),
        conversationTurn: () => activeTurn === undefined || activeTurn.signal.aborted ? undefined
          : { operationId: activeTurn.operationId, directorMessage: activeTurn.directorMessage, patrol: activeTurn.patrol },
      });
      try {
        await plan.ctx.provider.preflight?.({
          cwd, abortSignal: signal, model: plan.ctx.model, providerOptions: plan.ctx.providerOptions,
          permissionMode: 'full', mcpServers: mcp.servers, outputSchema: getManagerOutputSchema(plan.ctx.providerType),
        });
        const executor = createManagerTurnExecutor(cwd, { ...plan, ctx: { ...plan.ctx, mcpServers: mcp.servers } });
        const entry = { provider: plan.ctx.providerType, model: plan.ctx.model ?? null, language: plan.ctx.lang,
          contextKey, executor: { async execute(turn: Parameters<typeof executor.execute>[0]) {
            turnScope.begin(turn.abortSignal);
            activeTurn = turn.conversationOperationId === undefined ? undefined : {
              operationId: turn.conversationOperationId, directorMessage: turn.directorMessage === true, signal: turn.abortSignal,
              patrol: turn.patrol === true,
            };
            try { return await executor.execute(turn); }
            finally { await turnScope.end(); activeTurn = undefined; }
          } }, dispose: mcp.dispose };
        entries.set(id, entry);
        return entry;
      } catch (error) { await mcp.dispose(); throw error; }
    },
    async close() {
      const results = await Promise.allSettled([...entries.values()].map((entry) => entry.dispose()));
      entries.clear();
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, 'Conversation runtime cleanup failed');
    },
  };
}
