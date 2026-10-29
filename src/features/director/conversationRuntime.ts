import { createHash } from 'node:crypto';
import { createConversationRuntime, type ConversationRuntime, type PreparedConversationRuntime } from '../manager/conversationRuntime.js';
import { createDirectorConversationPlan } from './conversationPlan.js';
import { createDirectorMcpServer, DIRECTOR_MCP_SERVER_NAME, DIRECTOR_TOOL_ALLOWLIST, type DirectorNotifications } from './mcp.js';
import { startLocalMcpConnection } from '../mcp/localConnection.js';
import { createDirectorTurnExecutor } from './turnExecutor.js';

export function createDaemonConversationRuntime(configDirectory: string, notifications: DirectorNotifications): ConversationRuntime {
  const managers = createConversationRuntime(configDirectory);
  let current: { dispose(): Promise<void> } | undefined;
  return {
    async resolve(assignment, signal, overrides) {
      if (assignment.kind !== 'daemon') return managers.resolve(assignment, signal, overrides);
      const plan = createDirectorConversationPlan(configDirectory, overrides ?? {});
      const contextKey = createHash('sha256').update(JSON.stringify({
        provider: plan.ctx.providerType, model: plan.ctx.model, options: plan.ctx.providerOptions, prompt: plan.systemPrompt,
      })).digest('hex');
      if (current !== undefined) { await current.dispose(); current = undefined; }
      const connection = await startLocalMcpConnection(() => createDirectorMcpServer(configDirectory, notifications, signal));
      try {
        await plan.ctx.provider.preflight?.({ cwd: plan.cwd, model: plan.ctx.model, providerOptions: plan.ctx.providerOptions,
          permissionMode: 'readonly', strictToolAllowlist: DIRECTOR_TOOL_ALLOWLIST,
          mcpServers: { [DIRECTOR_MCP_SERVER_NAME]: connection.config }, abortSignal: signal });
        const runtime = { provider: plan.ctx.providerType, model: plan.ctx.model ?? null, language: plan.ctx.lang, contextKey,
          executor: { async execute(turn: Parameters<PreparedConversationRuntime['executor']['execute']>[0]) {
            try { return await createDirectorTurnExecutor(plan, connection.config).execute(turn); }
            finally {
              await connection.dispose();
              if (current === connection) current = undefined;
            }
          } } };
        current = connection;
        return runtime;
      } catch (error) { await connection.dispose(); throw error; }
    },
    async close() {
      const results = await Promise.allSettled([managers.close(), current?.dispose()]);
      current = undefined;
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, 'Daemon conversation runtime cleanup failed');
    },
  };
}
