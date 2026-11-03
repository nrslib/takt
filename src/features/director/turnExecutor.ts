import type { DirectorConversationPlan } from './conversationPlan.js';
import type { ManagerTurnInput } from '../manager/turnExecutor.js';
import { DIRECTOR_MCP_SERVER_NAME, DIRECTOR_TOOL_ALLOWLIST } from './mcp.js';
import type { McpHttpServerConfig } from '../../core/models/workflow-provider-options.js';
import { createMcpAdapter } from '../../infra/providers/mcp/index.js';
import { buildMcpServerSetIdentity } from '../../infra/config/runtime-provider/mcp-schema.js';
import { createAgentFailureError, isAgentFailureError } from '../../shared/types/agent-failure.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { withoutDiagnosticLogging } from '../../shared/utils/diagnostic-context.js';

export function createDirectorTurnExecutor(plan: DirectorConversationPlan, config: McpHttpServerConfig) {
  const agent = plan.ctx.provider.setup({ name: 'director', systemPrompt: plan.systemPrompt });
  return { execute: (input: ManagerTurnInput) => withoutDiagnosticLogging(async () => {
    const servers = { [DIRECTOR_MCP_SERVER_NAME]: config };
    const adapter = createMcpAdapter(plan.ctx.providerType);
    const resolved = { enabled: true, servers, serverNames: Object.keys(servers), identity: buildMcpServerSetIdentity(servers) };
    adapter.validate(resolved);
    const prepared = await adapter.prepare(resolved, { cwd: plan.cwd, permissionMode: 'readonly', abortSignal: input.abortSignal });
    try {
      let sessionId = input.sessionId;
      let usedTools = false;
      const call = async () => {
        input.abortSignal.throwIfAborted();
        const response = await agent.call(input.prompt, {
          cwd: plan.cwd, model: plan.ctx.model, language: plan.ctx.lang, sessionId,
          permissionMode: 'readonly', strictToolAllowlist: DIRECTOR_TOOL_ALLOWLIST,
          providerOptions: plan.ctx.providerOptions, abortSignal: input.abortSignal,
          callerManagedSession: true, callerManagedMcp: true, mcpServers: servers, preparedMcp: prepared,
          onStream: (event) => { if (['tool_use', 'tool_result', 'tool_output'].includes(event.type)) usedTools = true; },
        });
        if (response.status !== 'done') {
          if (response.failureCategory !== undefined) throw createAgentFailureError(response.failureCategory, response.error ?? 'Director provider failed');
          throw new Error(response.error ?? 'Director provider failed');
        }
        return response;
      };
      let response;
      try { response = await call(); }
      catch (error) {
        const rejectedResume = sessionId !== undefined && isAgentFailureError(error) && error.failureCategory === 'session_continuation_unsupported';
        if (usedTools || input.abortSignal.aborted || !rejectedResume && !/prompt is too long/i.test(getErrorMessage(error))) throw error;
        sessionId = undefined;
        await input.recovery?.invalidateSession();
        response = await call();
      }
      input.abortSignal.throwIfAborted();
      return { message: response.content, summary: null, sessionId: response.sessionId ?? sessionId, assignment: undefined };
    } finally { await prepared.dispose(); }
  }) };
}
