import type { ManagerConversationPlan } from './conversationPlan.js';
import type { ManagerAssignmentIdentity } from './assignment.js';
import { withManagerAssignment } from './assignment.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from './managerMcp.js';
import { TAKT_MCP_MANAGER_TOOL_NAMES } from '../mcp/server.js';
import { createMcpAdapter } from '../../infra/providers/mcp/index.js';
import { buildMcpServerSetIdentity } from '../../infra/config/runtime-provider/mcp-schema.js';
import { createManagerToolPermissionHandler } from './toolPermissionDecision.js';
import type { ManagerPermissionGoal } from './toolPermissionJudge.js';
import { supportsManagerPermissionJudge } from './permissionJudgeSupport.js';
import { getManagerOutputSchema, parseManagerResponse } from './turnResponse.js';
import { createAgentFailureError, isAgentFailureError } from '../../shared/types/agent-failure.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { withoutDiagnosticLogging } from '../../shared/utils/diagnostic-context.js';
import { createBoundedSensitiveValues, sanitizeSensitiveValueWithKnownValues } from '../../shared/utils/sensitiveText.js';

// Keep the judgment context finite; omitted observations must remain visible as omissions.
const MAX_OBSERVED_TOOL_EVENT_BYTES = 64 * 1024;

const addRepositoryTools = new Set([
  'takt_add_workspace_repository',
  `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__takt_add_workspace_repository`,
  `${TAKT_MANAGER_MCP_SERVER_NAME}__takt_add_workspace_repository`,
  `${TAKT_MANAGER_MCP_SERVER_NAME}_takt_add_workspace_repository`,
]);

export interface ManagerTurnInput {
  prompt: string;
  instruction: string;
  sessionId: string | undefined;
  abortSignal: AbortSignal;
  assignment: ManagerAssignmentIdentity | undefined;
  configDirectory: string;
  conversationOperationId?: string;
  goal?: ManagerPermissionGoal;
  onProviderOutput?: () => void;
  onNotification?: (message: string) => void;
  onDenial?: (reason: string) => void;
  recovery?: { context: string; invalidateSession(): Promise<void> };
}

export function createManagerTurnExecutor(cwd: string, plan: ManagerConversationPlan) {
  const agent = plan.ctx.provider.setup({ name: 'manager', systemPrompt: plan.strategy.systemPrompt });
  return {
    execute(input: ManagerTurnInput) {
      const run = async () => {
        const signal = input.abortSignal;
        signal.throwIfAborted();
        let assignment = input.assignment;
        let sessionId = input.sessionId;
        const observedEvents: string[] = [];
        let observationsTruncated = false;
        const sensitiveValues = createBoundedSensitiveValues();
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
                ? { toolApprovalAllowlist: { [TAKT_MANAGER_MCP_SERVER_NAME]: TAKT_MCP_MANAGER_TOOL_NAMES } } : {}),
            });
          }
          signal.throwIfAborted();
          const usesJudge = supportsManagerPermissionJudge(plan.ctx.providerType);
          if (usesJudge && plan.permissionJudge === undefined) throw new Error('Manager permission judge plan is missing');
          const onToolPermissionDecision = usesJudge ? createManagerToolPermissionHandler({
            plan: plan.permissionJudge!, provider: plan.ctx.providerType, cwd, instruction: input.instruction,
            goal: input.goal, configDirectory: input.configDirectory,
            get observedToolEvents() {
              return { events: observedEvents.map((value) => sanitizeSensitiveValueWithKnownValues(JSON.parse(value), sensitiveValues)),
                truncated: observationsTruncated || sensitiveValues.exhausted };
            },
            get owner() { return assignment ?? { kind: 'repository', repositoryDirectory: cwd }; },
            abortSignal: signal, onNotification: input.onNotification, onDenial: (reason) => { input.onDenial?.(reason); },
          }) : undefined;
          let usedTools = false;
          const additions = new Set<string>();
          const call = async (prompt: string) => {
            signal.throwIfAborted();
            const turnPrompt = input.conversationOperationId === undefined ? prompt
              : `Conversation operation ID: ${input.conversationOperationId}\nFor takt_merge_goal_pr, pass this ID as conversationOperationId. It identifies this turn; merge authorization is checked against the saved conversation.\n\n${prompt}`;
            const response = await agent.call(turnPrompt, {
              cwd, model: plan.ctx.model, sessionId, abortSignal: signal,
              providerOptions: plan.ctx.providerOptions, permissionMode: 'full',
              outputSchema: getManagerOutputSchema(plan.ctx.providerType), language: plan.ctx.lang,
              ...(input.recovery === undefined ? {} : { callerManagedSession: true as const }),
              mcpServers: servers, preparedMcp: prepared, callerManagedMcp: true,
              ...(onToolPermissionDecision === undefined ? {} : { onToolPermissionDecision }),
              onStream: (event) => {
                input.onProviderOutput?.();
                if (usesJudge && (event.type === 'tool_use' || event.type === 'tool_result' || event.type === 'tool_output')) {
                  sensitiveValues.collect(event);
                  const serialized = JSON.stringify(sanitizeSensitiveValueWithKnownValues(event, sensitiveValues));
                  const bytes = Buffer.byteLength(serialized);
                  if (bytes > MAX_OBSERVED_TOOL_EVENT_BYTES) observationsTruncated = true;
                  else {
                    while (observedEvents.reduce((size, value) => size + Buffer.byteLength(value), bytes) > MAX_OBSERVED_TOOL_EVENT_BYTES) {
                      observedEvents.shift();
                      observationsTruncated = true;
                    }
                    observedEvents.push(serialized);
                  }
                }
                if (event.type === 'tool_result' || event.type === 'tool_output') usedTools = true;
                if (event.type === 'tool_use') {
                  usedTools = true;
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
            });
            if (response.status !== 'done') {
              if (response.failureCategory !== undefined) throw createAgentFailureError(response.failureCategory, response.error ?? 'Manager provider failed');
              throw new Error(response.error ?? 'Manager provider failed');
            }
            return response;
          };
          let response;
          const freshPrompt = (): string => input.recovery === undefined || input.recovery.context.length === 0
            ? input.prompt : `${input.prompt}\n\nBusiness context (not approval): ${input.recovery.context}`;
          try {
            response = await call(sessionId === undefined ? freshPrompt() : input.prompt);
          } catch (error) {
            const rejectedResume = sessionId !== undefined && isAgentFailureError(error)
              && error.failureCategory === 'session_continuation_unsupported';
            if (rejectedResume) {
              sessionId = undefined;
              await input.recovery?.invalidateSession();
            }
            if (usedTools || signal.aborted || (!rejectedResume && !/prompt is too long/i.test(getErrorMessage(error)))) throw error;
            sessionId = undefined;
            if (!rejectedResume) await input.recovery?.invalidateSession();
            // Both recovery causes share this single retry; tool side effects are never replayed.
            response = await call(freshPrompt());
          }
          signal.throwIfAborted();
          return { ...parseManagerResponse(response, plan.ctx.providerType),
            sessionId: response.sessionId ?? sessionId, assignment };
        } finally {
          await prepared?.dispose();
        }
      };
      return input.recovery === undefined ? run() : withoutDiagnosticLogging(run);
    },
  };
}
