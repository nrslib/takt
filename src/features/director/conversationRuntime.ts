import { createHash } from 'node:crypto';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import { createConversationRuntime, type ConversationRuntime, type PreparedConversationRuntime } from '../manager/conversationRuntime.js';
import { createDirectorConversationPlan } from './conversationPlan.js';
import { createDirectorMcpServer, DIRECTOR_MCP_SERVER_NAME, DIRECTOR_TOOL_ALLOWLIST, type DirectorNotifications } from './mcp.js';
import { startLocalMcpConnection } from '../mcp/localConnection.js';
import { createDirectorTurnExecutor } from './turnExecutor.js';

export async function prepareDirectorTurn(
  configDirectory: string,
  notifications: DirectorNotifications,
  signal: AbortSignal,
  overrides: AssistantCliOverrides,
  patrol: boolean,
) {
  signal.throwIfAborted();
  const plan = createDirectorConversationPlan(configDirectory, overrides);
  const connection = await startLocalMcpConnection(() => createDirectorMcpServer(configDirectory, notifications, signal, patrol));
  try {
    await plan.ctx.provider.preflight?.({ cwd: plan.cwd, model: plan.ctx.model, providerOptions: plan.ctx.providerOptions,
      permissionMode: 'readonly', strictToolAllowlist: DIRECTOR_TOOL_ALLOWLIST,
      mcpServers: { [DIRECTOR_MCP_SERVER_NAME]: connection.config }, abortSignal: signal });
    signal.throwIfAborted();
    const executor = createDirectorTurnExecutor(plan, connection.config);
    return { provider: plan.ctx.providerType, model: plan.ctx.model ?? null, language: plan.ctx.lang,
      contextKey: createHash('sha256').update(JSON.stringify({
        provider: plan.ctx.providerType, model: plan.ctx.model, options: plan.ctx.providerOptions, prompt: plan.systemPrompt,
      })).digest('hex'), executor, dispose: connection.dispose,
    };
  } catch (error) { await connection.dispose(); throw error; }
}

export function createDaemonConversationRuntime(configDirectory: string, notifications: DirectorNotifications): ConversationRuntime {
  const managers = createConversationRuntime(configDirectory);
  const connections = new Set<() => Promise<void>>();
  return {
    async resolve(assignment, signal, overrides) {
      if (assignment.kind !== 'daemon') return managers.resolve(assignment, signal, overrides);
      const prepared = await prepareDirectorTurn(configDirectory, notifications, signal, overrides ?? {}, false);
      const { executor, dispose, ...configuration } = prepared;
      let released: Promise<void> | undefined;
      const release = (): Promise<void> => released ??= Promise.resolve().then(dispose).finally(() => { connections.delete(release); });
      connections.add(release);
      return { ...configuration, release,
        executor: { async execute(turn: Parameters<PreparedConversationRuntime['executor']['execute']>[0]) {
          try { return await executor.execute(turn); }
          finally { await release(); }
        } },
      };
    },
    async close() {
      const results = await Promise.allSettled([managers.close(), ...[...connections].map((release) => release())]);
      connections.clear();
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, 'Daemon conversation runtime cleanup failed');
    },
  };
}
