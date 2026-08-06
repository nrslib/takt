import type { AgentResponse } from '../core/models/types.js';
import { runAgent, type RunAgentOptions } from './runner.js';
import {
  assertProviderSupportsSelectorExecution,
} from '../infra/providers/provider-capabilities.js';
import type { StepProviderOptions } from '../core/models/workflow-types.js';
import type { Language } from '../core/models/types.js';
import type { ProviderType } from '../shared/types/provider.js';
import {
  resolveMcpAssignment,
  type McpAssignmentSection,
  type AgentExecutionContext,
} from '../infra/config/runtime-provider/mcp-assignment.js';

export {
  evaluateCondition,
  judgeStatus,
  type EvaluateConditionOptions,
  type JudgeStatusOptions,
  type JudgeStatusResult,
} from './judge-status-usecase.js';
export {
  decomposeTask,
  requestMoreParts,
  type DecomposeTaskOptions,
  type MorePartsResponse,
} from './decompose-task-usecase.js';
export { createWorkRequirementEstimator, type WorkRequirementEstimatorOptions } from './auto-routing-usecase.js';

export async function executeAgent(
  persona: string | undefined,
  instruction: string,
  options: RunAgentOptions,
): Promise<AgentResponse> {
  return runAgent(persona, instruction, options);
}

export interface ResolvedInternalAgentOptions {
  readonly cwd: string;
  readonly projectCwd?: string;
  readonly abortSignal?: AbortSignal;
  readonly language?: Language;
  readonly childProcessEnv?: Readonly<Record<string, string>>;
  readonly sessionId?: string;
  readonly resolution: {
    readonly provider: ProviderType;
    readonly model: string | undefined;
    readonly providerOptions: StepProviderOptions;
  };
  /**
   * Runtime MCP assignment section (runtime-v1 only). When provided, the
   * internal agent resolves its effective MCP server set via
   * `resolveMcpAssignment` with `isInternalAgent: true`, then forwards the
   * resolved servers to `runAgent` so `defaults.servers` and
   * `internal_agents.selector.exclude` apply (order.md:106,76-80).
   */
  readonly mcpAssignment?: McpAssignmentSection;
}

export async function executeIsolatedStructuredInternalAgent(
  systemPrompt: string,
  instruction: string,
  outputSchema: Record<string, unknown>,
  options: ResolvedInternalAgentOptions,
): Promise<AgentResponse> {
  assertProviderSupportsSelectorExecution(options.resolution.provider);
  const {
    resolution,
    mcpAssignment,
    ...executionOptions
  } = options;
  const mcp = resolveInternalAgentMcpServers(mcpAssignment);
  return runAgent(undefined, instruction, {
    ...executionOptions,
    sessionId: undefined,
    internalSystemPrompt: systemPrompt,
    internalAgentIsolation: 'strict-readonly',
    allowedTools: [],
    mcpServers: mcp.servers,
    mcpServerIdentity: mcp.identity,
    mcpAssignment,
    bypassPermissions: false,
    resolvedExecution: {
      provider: resolution.provider,
      model: resolution.model,
      providerOptions: resolution.providerOptions,
      permissionMode: 'readonly',
    },
    outputSchema,
  });
}

/**
 * Resolve the effective MCP server set for an internal agent execution.
 * Returns an empty record when no `mcpAssignment` is configured (legacy mode
 * or runtime-v1 without an `mcp` section), preserving the prior behavior of
 * running internal agents without MCP servers. When a section is present the
 * resolver applies `defaults.servers` and `internal_agents.selector.exclude`
 * with `isInternalAgent: true` (order.md:106,76-80). The returned identity
 * is propagated to `runAgent` so the OpenCode shared server pool isolates
 * different server sets (order.md:191-195,269,333).
 */
function resolveInternalAgentMcpServers(
  mcpAssignment: McpAssignmentSection | undefined,
): { servers: Record<string, import('../core/models/index.js').McpServerConfig>; identity: string | undefined } {
  if (mcpAssignment === undefined) {
    return { servers: {}, identity: undefined };
  }
  const context: AgentExecutionContext = {
    persona: undefined,
    tags: [],
    stepQualifiedName: undefined,
    isWorkflowCallNode: false,
    isInternalAgent: true,
  };
  const resolved = resolveMcpAssignment(mcpAssignment, context);
  if (!resolved.enabled) {
    return { servers: {}, identity: undefined };
  }
  return { servers: resolved.servers, identity: resolved.identity };
}

export const generateReport = executeAgent;
export const executePart = executeAgent;
