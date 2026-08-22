import type { AgentResponse } from '../core/models/types.js';
import { runAgent, type RunAgentOptions } from './runner.js';
import {
  assertProviderSupportsIsolatedStructuredExecution,
} from '../infra/providers/provider-capabilities.js';
import type { StepProviderOptions } from '../core/models/workflow-types.js';
import type { Language } from '../core/models/types.js';
import type { ProviderActivityCallback, ProviderType, StreamCallback } from '../shared/types/provider.js';
import {
  resolveInternalAgentMcpServers,
  type McpAssignmentSection,
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
  readonly agentName?: string;
  readonly cwd: string;
  readonly projectCwd?: string;
  readonly persona?: string;
  readonly workflowBundleResourceRoot?: string;
  readonly personaPath?: string;
  readonly abortSignal?: AbortSignal;
  readonly language?: Language;
  readonly childProcessEnv?: Readonly<Record<string, string>>;
  readonly failureDir?: string;
  readonly sessionId?: string;
  readonly onStream?: StreamCallback;
  readonly onActivity?: ProviderActivityCallback;
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
  assertProviderSupportsIsolatedStructuredExecution(options.resolution.provider);
  const {
    resolution,
    agentName,
    persona,
    mcpAssignment,
    ...executionOptions
  } = options;
  const mcp = resolveInternalAgentMcpServers(mcpAssignment);
  return runAgent(persona, instruction, {
    ...executionOptions,
    executionProfile: 'isolated-structured',
    ...(agentName === undefined ? {} : { internalAgentName: agentName }),
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

export const generateReport = executeAgent;
export const executePart = executeAgent;
