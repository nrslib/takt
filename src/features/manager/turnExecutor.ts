import type { DaemonStateRequest, DaemonStateReply } from '../../core/daemon/processProtocol.js';
import type { ManagerConversationPlan } from './conversationPlan.js';
import type { ManagerAssignmentIdentity } from './assignment.js';
import { withManagerAssignment } from './assignment.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from './managerMcp.js';
import { TAKT_MCP_MANAGER_TOOL_NAMES } from '../mcp/server.js';
import { createMcpAdapter } from '../../infra/providers/mcp/index.js';
import { buildMcpServerSetIdentity } from '../../infra/config/runtime-provider/mcp-schema.js';
import { getManagerOutputSchema, parseManagerResponse } from './turnResponse.js';
import { withoutDiagnosticLogging } from '../../shared/utils/diagnostic-context.js';
import type { ConversationActivity } from '../../shared/types/conversation-activity.js';
import { verifyManagerConversation } from './formalSpecVerification.js';
import type { ResolvedFormalSpecConfiguration } from '../interactive/taskInstructionFormat.js';
import { createTurnActivityReporter } from './turnActivity.js';
import { callWithManagerSessionRecovery } from './sessionRecovery.js';
import type { ToolActivityEvent } from '../../shared/tool-activity/types.js';

const managerToolNames = [
  ...TAKT_MCP_MANAGER_TOOL_NAMES, 'takt_pause_goal', 'takt_resume_goal', 'takt_abort_goal',
];

const addRepositoryTools = new Set([
  'takt_add_workspace_repository',
  `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__takt_add_workspace_repository`,
  `${TAKT_MANAGER_MCP_SERVER_NAME}__takt_add_workspace_repository`,
  `${TAKT_MANAGER_MCP_SERVER_NAME}_takt_add_workspace_repository`,
]);

export interface ManagerTurnInput {
  requestDaemon?: (request: DaemonStateRequest) => Promise<DaemonStateReply>;
  operationId?: string;
  prompt: string;
  sessionId: string | undefined;
  abortSignal: AbortSignal;
  assignment: ManagerAssignmentIdentity | undefined;
  patrol?: boolean;
  verify?: ResolvedFormalSpecConfiguration & { repositoryDirectory: string };
  onProviderOutput?: () => void;
  onActivity?: (activity: ConversationActivity) => void;
  onText?: (message: string) => void;
  onToolEvent?: (event: ToolActivityEvent) => void;
  recovery?: { context: string; invalidateSession(): Promise<void> };
}

export function createManagerTurnExecutor(cwd: string, plan: ManagerConversationPlan) {
  const agent = plan.ctx.provider.setup({ name: 'manager', systemPrompt: plan.strategy.systemPrompt });
  return {
    execute(input: ManagerTurnInput) {
      const run = async () => {
        const signal = input.abortSignal;
        signal.throwIfAborted();
        if (input.verify !== undefined) return verifyManagerConversation(cwd, plan, input, input.verify);
        let assignment = input.assignment;
        const reporter = createTurnActivityReporter((activity) => input.onActivity?.(activity), (message) => input.onText?.(message));
        const servers = plan.ctx.mcpServers === undefined ? undefined : Object.fromEntries(
          Object.entries(plan.ctx.mcpServers).map(([name, config]) => [name,
            assignment === undefined || name !== TAKT_MANAGER_MCP_SERVER_NAME ? config : withManagerAssignment(config, assignment)]),
        );
        let prepared: Awaited<ReturnType<ReturnType<typeof createMcpAdapter>['prepare']>> | undefined;
        try {
          if (servers !== undefined) {
            const adapter = createMcpAdapter(plan.ctx.providerType);
            const resolved = { enabled: true, servers, serverNames: Object.keys(servers).sort(), identity: buildMcpServerSetIdentity(servers) };
            adapter.validate(resolved);
            prepared = await adapter.prepare(resolved, {
              cwd, abortSignal: signal, permissionMode: 'full',
              ...(plan.ctx.providerType === 'codex'
                ? { toolApprovalAllowlist: { [TAKT_MANAGER_MCP_SERVER_NAME]: managerToolNames } } : {}),
            });
          }
          signal.throwIfAborted();
          const additions = new Set<string>();
          const response = await callWithManagerSessionRecovery(agent, {
            resume: input.prompt,
            fresh: input.recovery === undefined || input.recovery.context.length === 0
              ? input.prompt : `${input.prompt}\n\nBusiness context (not approval): ${input.recovery.context}`,
          }, {
            cwd, model: plan.ctx.model, sessionId: input.patrol ? undefined : input.sessionId, abortSignal: signal,
            providerOptions: plan.ctx.providerOptions, permissionMode: 'full',
            aiReviewPermissions: plan.ctx.aiReviewPermissions,
            ...(servers?.[TAKT_MANAGER_MCP_SERVER_NAME] !== undefined
              && (plan.ctx.providerType === 'claude' || plan.ctx.providerType === 'claude-sdk')
              ? { allowedTools: managerToolNames.map((name) => `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__${name}`) }
              : {}),
            outputSchema: getManagerOutputSchema(plan.ctx.providerType), language: plan.ctx.lang,
            ...(input.recovery === undefined ? {} : { callerManagedSession: true as const }),
            mcpServers: servers, preparedMcp: prepared, callerManagedMcp: true,
            onStream: (event) => {
              input.onProviderOutput?.();
              if (!signal.aborted) reporter.onStream(event);
              if (!signal.aborted && (event.type === 'tool_use' || event.type === 'tool_result' || event.type === 'tool_output')) {
                input.onToolEvent?.(event);
              }
              if (event.type === 'tool_use') {
                if (addRepositoryTools.has(event.data.tool)) additions.add(event.data.id);
              }
              if (event.type === 'tool_result' && event.data.id !== undefined
                && additions.delete(event.data.id) && !event.data.isError) {
                try {
                  const content: unknown = JSON.parse(event.data.content);
                  const value = (Array.isArray(content)
                    ? JSON.parse(content.find((block) => block.type === 'text')?.text) : content) as { workspace?: { id?: string } } | null;
                  if (value?.workspace?.id) assignment = { kind: 'workspace', workspaceId: value.workspace.id };
                } catch { return; }
              }
            },
          }, input.patrol ? undefined : input.recovery?.invalidateSession, reporter.discard);
          signal.throwIfAborted();
          return { ...parseManagerResponse(response, plan.ctx.providerType),
            sessionId: response.sessionId, assignment };
        } finally {
          reporter.discard();
          await prepared?.dispose();
        }
      };
      return input.recovery === undefined ? run() : withoutDiagnosticLogging(run);
    },
  };
}
