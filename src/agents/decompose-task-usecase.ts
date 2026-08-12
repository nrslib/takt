import type {
  AgentResponse,
  Language,
  PartDefinition,
} from '../core/models/types.js';
import type { ProviderUsageSnapshot } from '../core/models/response.js';
import type { ProviderType } from '../core/workflow/types.js';
import { runAgent, type RunAgentOptions, type StreamCallback } from './runner.js';
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
  onStream?: StreamCallback;
  workflowMeta?: RunAgentOptions['workflowMeta'];
  childProcessEnv?: RunAgentOptions['childProcessEnv'];
  abortSignal?: RunAgentOptions['abortSignal'];
  mcpServers?: RunAgentOptions['mcpServers'];
  inspectTools?: string[];
  onPromptResolved?: (promptParts: {
    systemPrompt: string;
    userInstruction: string;
  }) => void;
  onAgentResponse?: (response: AgentResponse) => void;
  onAgentError?: (error: unknown) => void;
}

export type MorePartsOptions = Omit<
  DecomposeTaskOptions,
  'inspectTools' | 'onPromptResolved'
> & {
  cancellablePartIds: readonly string[];
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

async function requestDecompositionResponse(
  instruction: string,
  maxInitialParts: number | undefined,
  options: DecomposeTaskOptions,
  rejectedDecomposition?: RejectedTeamLeaderDecomposition,
): Promise<AgentResponse> {
  let response: AgentResponse;
  try {
    response = await runAgent(options.persona, buildDecomposePrompt(
      instruction,
      {
        maxInitialParts,
        language: options.language,
        inspectTools: options.inspectTools,
        rejectedDecomposition,
      },
    ), {
      cwd: options.cwd,
      personaPath: options.personaPath,
      workflowBundleResourceRoot: options.workflowBundleResourceRoot,
      language: options.language,
      model: options.model,
      provider: options.provider,
      resolvedModel: options.resolvedModel,
      resolvedProvider: options.resolvedProvider,
      allowedTools: options.inspectTools ?? [],
      mcpServers: options.mcpServers,
      permissionMode: 'readonly',
      outputSchema: loadDecompositionSchema(maxInitialParts),
      onStream: createPublicationGuardedStreamCallback(options.onStream, options.abortSignal),
      workflowMeta: options.workflowMeta,
      childProcessEnv: options.childProcessEnv,
      abortSignal: options.abortSignal,
      onPromptResolved: options.onPromptResolved,
    });
  } catch (error) {
    if (options.abortSignal?.aborted !== true) {
      options.onAgentError?.(error);
    }
    throw error;
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
      const response = await requestDecompositionResponse(
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
    const detail = response.error || response.content || response.status;
    throw new Error(`Team leader failed: ${detail}`);
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
  );

  let response: AgentResponse;
  try {
    response = await runAgent(options.persona, prompt, {
      cwd: options.cwd,
      personaPath: options.personaPath,
      workflowBundleResourceRoot: options.workflowBundleResourceRoot,
      language: options.language,
      model: options.model,
      provider: options.provider,
      resolvedModel: options.resolvedModel,
      resolvedProvider: options.resolvedProvider,
      allowedTools: [],
      mcpServers: options.mcpServers,
      permissionMode: 'readonly',
      outputSchema: loadMorePartsSchema(),
      onStream: createPublicationGuardedStreamCallback(options.onStream, options.abortSignal),
      workflowMeta: options.workflowMeta,
      childProcessEnv: options.childProcessEnv,
      abortSignal: options.abortSignal,
    });
  } catch (error) {
    if (options.abortSignal?.aborted !== true) {
      options.onAgentError?.(error);
    }
    throw error;
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
    const detail = response.error || response.content || response.status;
    throw new Error(`Team leader feedback failed: ${detail}`);
  }

  return {
    ...toMorePartsResponse(response.structuredOutput, options.cancellablePartIds),
    ...(response.providerUsage !== undefined ? { providerUsage: response.providerUsage } : {}),
  };
}
