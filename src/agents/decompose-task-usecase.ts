import type {
  AgentResponse,
  CompanionFinding,
  Language,
  PermissionMode,
  PartDefinition,
} from '../core/models/types.js';
import type { ProviderUsageSnapshot } from '../core/models/response.js';
import type { ProviderType } from '../core/workflow/types.js';
import type { RunAgentOptions, StreamCallback } from './runner.js';
import type { StepProviderOptions } from '../core/models/workflow-types.js';
import {
  executeStructuredAgent,
  requireStructuredAgentProvider,
  StructuredAgentResponseError,
} from './structured-caller/transport.js';
import { parseParts } from '../core/workflow/engine/task-decomposer.js';
import { loadDecompositionSchema, loadMorePartsSchema } from '../infra/resources/schema-loader.js';
import {
  buildDecomposePrompt,
  buildMorePartsPrompt,
  toMorePartsResponse,
  toPartDefinitions,
} from './team-leader-structured-output.js';
import {
  createPublicationGuardedStreamCallback,
  requestValidTeamLeaderDecomposition,
  TeamLeaderDecompositionValidationError,
  type RejectedTeamLeaderDecomposition,
} from './team-leader-decomposition-regeneration.js';
import {
  createAgentResponseFailureError,
} from '../shared/types/agent-failure.js';

export interface TeamLeaderPartFeedbackResult {
  id: string;
  title: string;
  status: string;
  content: string;
}

export interface DecomposeTaskOptions {
  cwd: string;
  persona?: string;
  personaPath?: string;
  workflowBundleResourceRoot?: string;
  language?: Language;
  model?: string;
  provider?: ProviderType;
  resolvedModel?: string;
  resolvedProvider?: ProviderType;
  resolvedProviderOptions?: StepProviderOptions;
  permissionMode?: PermissionMode;
  projectCwd?: string;
  onStream?: StreamCallback;
  onActivity?: RunAgentOptions['onActivity'];
  workflowMeta?: RunAgentOptions['workflowMeta'];
  childProcessEnv?: RunAgentOptions['childProcessEnv'];
  abortSignal?: RunAgentOptions['abortSignal'];
  failureDir?: RunAgentOptions['failureDir'];
  mcpServers?: RunAgentOptions['mcpServers'];
  mcpAssignment?: RunAgentOptions['mcpAssignment'];
  mcpServerIdentity?: RunAgentOptions['mcpServerIdentity'];
  inspectTools?: string[];
  inspectGuidance?: boolean;
  onPromptResolved?: (promptParts: {
    systemPrompt: string;
    userInstruction: string;
  }) => void;
  onAgentResponse?: (response: AgentResponse) => void;
  onAgentError?: (error: unknown) => void;
}

export type MorePartsOptions = Omit<
  DecomposeTaskOptions,
  'onPromptResolved'
> & {
  cancellablePartIds: readonly string[];
  /** Known IDs tolerated in model output but removed before the response is returned. */
  ignoredCancelPartIds?: readonly string[];
  companionFindings?: readonly CompanionFinding[];
};

export interface MorePartsResponse {
  done: boolean;
  reasoning: string;
  cancelPartIds: string[];
  parts: PartDefinition[];
  providerUsage?: ProviderUsageSnapshot;
}

export interface DecomposeTaskResponse {
  parts: PartDefinition[];
  providerUsage?: ProviderUsageSnapshot;
}

export async function requestDecompositionRawResponse(
  instruction: string,
  maxInitialParts: number | undefined,
  options: DecomposeTaskOptions,
  rejectedDecomposition?: RejectedTeamLeaderDecomposition,
): Promise<AgentResponse> {
  let response: AgentResponse;
  try {
    response = await executeStructuredAgent<Record<string, unknown>>(buildDecomposePrompt(
      instruction,
      {
        maxInitialParts,
        language: options.language,
        inspectTools: options.inspectTools,
        inspectGuidance: options.inspectGuidance === true,
        rejectedDecomposition,
      },
    ), loadDecompositionSchema(maxInitialParts), {
      name: 'team-leader-decomposer',
      persona: options.persona,
      cwd: options.cwd,
      projectCwd: options.projectCwd,
      personaPath: options.personaPath,
      workflowBundleResourceRoot: options.workflowBundleResourceRoot,
      language: options.language,
      resolution: {
        provider: requireStructuredAgentProvider(options.resolvedProvider ?? options.provider, 'task-decomposer'),
        model: options.resolvedModel ?? options.model,
        providerOptions: options.resolvedProviderOptions,
        permissionMode: options.permissionMode,
      },
      ...(options.inspectTools === undefined ? {} : { allowedTools: options.inspectTools }),
      mcpServers: options.mcpServers,
      mcpAssignment: options.mcpAssignment,
      mcpServerIdentity: options.mcpServerIdentity,
      onStream: createPublicationGuardedStreamCallback(options.onStream, options.abortSignal),
      onActivity: options.onActivity,
      workflowMeta: options.workflowMeta,
      childProcessEnv: options.childProcessEnv,
      abortSignal: options.abortSignal,
      failureDir: options.failureDir,
      onPromptResolved: options.onPromptResolved,
    });
  } catch (error) {
    if (error instanceof StructuredAgentResponseError) {
      response = error.response;
    } else {
      if (options.abortSignal?.aborted !== true) {
        options.onAgentError?.(error);
      }
      throw error;
    }
  }
  if (options.abortSignal?.aborted !== true) {
    options.onAgentResponse?.(response);
  }
  return response;
}

export async function decomposeTask(
  instruction: string,
  maxInitialParts: number | undefined,
  options: DecomposeTaskOptions,
): Promise<DecomposeTaskResponse> {
  return requestValidTeamLeaderDecomposition({
    abortSignal: options.abortSignal,
    request: async (rejectedDecomposition) => {
      const response = await requestDecompositionRawResponse(
        instruction,
        maxInitialParts,
        options,
        rejectedDecomposition,
      );
      return parseDecomposition(response, maxInitialParts);
    },
  });
}

function parseDecomposition(
  response: AgentResponse,
  maxInitialParts: number | undefined,
): DecomposeTaskResponse {
  if (response.status !== 'done') {
    throw createAgentResponseFailureError(response, 'Team leader failed');
  }

  const parts = response.structuredOutput?.parts;
  try {
    return {
      parts: parts == null
        ? parseParts(response.content, maxInitialParts)
        : toPartDefinitions(parts, maxInitialParts),
      ...(response.providerUsage !== undefined ? { providerUsage: response.providerUsage } : {}),
    };
  } catch (error) {
    throw new TeamLeaderDecompositionValidationError(
      'decomposition.parts_invalid',
      parts == null ? '$' : '$.parts',
      error,
    );
  }
}

export async function requestMorePartsRawResponse(
  originalInstruction: string,
  allResults: TeamLeaderPartFeedbackResult[],
  existingIds: string[],
  options: MorePartsOptions,
): Promise<AgentResponse> {
  const prompt = buildMorePartsPrompt(
    originalInstruction,
    allResults,
    existingIds,
    options.language,
    options.cancellablePartIds,
    options.inspectTools,
    options.inspectGuidance === true,
    options.companionFindings,
  );

  let response: AgentResponse;
  try {
    response = await executeStructuredAgent<Record<string, unknown>>(prompt, loadMorePartsSchema(), {
      name: 'team-leader-more-parts',
      persona: options.persona,
      cwd: options.cwd,
      projectCwd: options.projectCwd,
      personaPath: options.personaPath,
      workflowBundleResourceRoot: options.workflowBundleResourceRoot,
      language: options.language,
      resolution: {
        provider: requireStructuredAgentProvider(options.resolvedProvider ?? options.provider, 'task-more-parts'),
        model: options.resolvedModel ?? options.model,
        providerOptions: options.resolvedProviderOptions,
        permissionMode: options.permissionMode,
      },
      ...(options.inspectTools === undefined ? {} : { allowedTools: options.inspectTools }),
      mcpServers: options.mcpServers,
      mcpAssignment: options.mcpAssignment,
      mcpServerIdentity: options.mcpServerIdentity,
      onStream: createPublicationGuardedStreamCallback(options.onStream, options.abortSignal),
      onActivity: options.onActivity,
      workflowMeta: options.workflowMeta,
      childProcessEnv: options.childProcessEnv,
      abortSignal: options.abortSignal,
      failureDir: options.failureDir,
    });
  } catch (error) {
    if (error instanceof StructuredAgentResponseError) {
      response = error.response;
    } else {
      if (options.abortSignal?.aborted !== true) {
        options.onAgentError?.(error);
      }
      throw error;
    }
  }
  if (options.abortSignal?.aborted !== true) {
    options.onAgentResponse?.(response);
  }
  return response;
}

export async function requestMoreParts(
  originalInstruction: string,
  allResults: TeamLeaderPartFeedbackResult[],
  existingIds: string[],
  options: MorePartsOptions,
): Promise<MorePartsResponse> {
  const response = await requestMorePartsRawResponse(
    originalInstruction,
    allResults,
    existingIds,
    options,
  );

  if (response.status !== 'done') {
    throw createAgentResponseFailureError(response, 'Team leader feedback failed');
  }

  const ignoredCancelPartIds = new Set(options.ignoredCancelPartIds ?? []);
  const parsedResponse = toMorePartsResponse(response.structuredOutput, [
    ...options.cancellablePartIds,
    ...ignoredCancelPartIds,
  ]);
  return {
    ...parsedResponse,
    cancelPartIds: parsedResponse.cancelPartIds.filter((partId) => !ignoredCancelPartIds.has(partId)),
    ...(response.providerUsage !== undefined ? { providerUsage: response.providerUsage } : {}),
  };
}
