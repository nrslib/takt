import { TurnToolScope } from '../daemonTurn/toolScope.js';
import { createHash } from 'node:crypto';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import { createConversationRuntime, type ConversationRuntime, type PreparedConversationRuntime } from '../manager/conversationRuntime.js';
import { createDirectorConversationPlan } from './conversationPlan.js';
import { createDirectorMcpServer, DIRECTOR_MCP_SERVER_NAME, DIRECTOR_TOOL_ALLOWLIST, type DirectorStateActions } from './mcp.js';
import { startLocalMcpConnection } from '../mcp/localConnection.js';
import { createDirectorTurnExecutor } from './turnExecutor.js';
import { getDirectorOutputSchema } from './turnResponse.js';
import { CODEX_SESSION_CONTRACT } from '../../shared/codex-session-contract.js';

export async function prepareDirectorTurn(
  configDirectory: string,
  actions: DirectorStateActions,
  signal: AbortSignal,
  overrides: AssistantCliOverrides,
) {
  signal.throwIfAborted();
  const plan = createDirectorConversationPlan(configDirectory, overrides);
  const turnScope = new TurnToolScope();
  turnScope.begin(signal);
  const connection = await startLocalMcpConnection((_request, _connection, responses) => createDirectorMcpServer(configDirectory, actions, signal, responses, turnScope));
  let disposed: Promise<void> | undefined;
  const dispose = (): Promise<void> => disposed ??= (async () => {
    const results = await Promise.allSettled([connection.dispose(), turnScope.end()]);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length === 1) throw failures[0]!.reason;
    if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), 'Director turn cleanup failed');
  })();
  try {
    await plan.ctx.provider.preflight?.({ cwd: plan.cwd, model: plan.ctx.model, providerOptions: plan.ctx.providerOptions,
      outputSchema: getDirectorOutputSchema(plan.ctx.providerType),
      permissionMode: 'readonly', strictToolAllowlist: DIRECTOR_TOOL_ALLOWLIST,
      mcpServers: { [DIRECTOR_MCP_SERVER_NAME]: connection.config }, abortSignal: signal });
    signal.throwIfAborted();
    const executor = createDirectorTurnExecutor(plan, connection.config);
    return { provider: plan.ctx.providerType, model: plan.ctx.model ?? null, language: plan.ctx.lang,
      contextKey: createHash('sha256').update(JSON.stringify({
        provider: plan.ctx.providerType, model: plan.ctx.model, options: plan.ctx.providerOptions, prompt: plan.systemPrompt,
        ...(plan.ctx.providerType === 'codex' ? { sessionContract: CODEX_SESSION_CONTRACT } : {}),
      })).digest('hex'), executor: { async execute(turn: Parameters<typeof executor.execute>[0]) {
        try { return await executor.execute(turn); }
        finally { await dispose(); }
      } }, dispose,
    };
  } catch (error) { await dispose(); throw error; }
}

export function createDaemonConversationRuntime(configDirectory: string, actions: DirectorStateActions): ConversationRuntime {
  const managers = createConversationRuntime(configDirectory);
  const connections = new Set<() => Promise<void>>();
  return {
    async resolve(assignment, signal, overrides) {
      if (assignment.kind !== 'daemon') return managers.resolve(assignment, signal, overrides);
      const prepared = await prepareDirectorTurn(configDirectory, actions, signal, overrides ?? {});
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
