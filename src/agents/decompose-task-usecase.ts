import type {
  AgentResponse,
  FindingContractTeamLeaderDecision,
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
  createFindingContractDecompositionJsonSchema,
  createFindingContractFeedbackJsonSchema,
  type FindingContractFindingDigest,
  type FindingContractPartIndexEntry,
} from '../core/workflow/team-leader-finding-contract.js';
import { parseFindingContractTeamLeaderDecision } from '../core/workflow/team-leader-finding-contract-decision.js';
import type { FindingContractDecisionEvidenceSnapshot } from '../core/workflow/team-leader-finding-contract-evidence.js';
import type {
  FindingContractRecoveryPromptContext,
} from '../core/workflow/engine/team-leader-finding-contract-recovery.js';
import type {
  FindingContractRejectedDecisionDigest,
} from '../core/workflow/team-leader-finding-contract-decision-validation.js';
import type {
  FindingContractRejectedDecompositionDigest,
} from '../core/workflow/team-leader-finding-contract-decomposition-validation.js';
import {
  FindingContractDecompositionValidationError,
  validateFindingContractDecomposition,
} from '../core/workflow/team-leader-finding-contract-decomposition-validation.js';
import {
  createFindingContractControlValidationIssue,
} from '../core/workflow/team-leader-finding-contract-control-validation.js';
import {
  createPublicationGuardedStreamCallback,
  requestValidTeamLeaderDecomposition,
  TeamLeaderDecompositionValidationError,
  type RejectedTeamLeaderDecomposition,
} from './team-leader-decomposition-regeneration.js';

export interface FindingContractDecompositionContext {
  readonly targetFindingIds: readonly string[];
  readonly actionableFindings: string;
  readonly recovery?: FindingContractRecoveryPromptContext<FindingContractRejectedDecompositionDigest>;
}

export interface FindingContractFeedbackContext extends FindingContractDecompositionContext {
  readonly completedPartIndex: readonly FindingContractFindingDigest[];
  readonly plannedParts: readonly PartDefinition[];
  readonly evidence: FindingContractDecisionEvidenceSnapshot;
  previousDecision?: {
    readonly decision: 'continue';
    readonly reasoning: string;
  };
  readonly recovery?: FindingContractRecoveryPromptContext<FindingContractRejectedDecisionDigest>;
}

export interface TeamLeaderPartFeedbackResult {
  id: string;
  title: string;
  status: string;
  content: string;
  findingContractClaim?: FindingContractPartIndexEntry;
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
  findingContract?: FindingContractDecompositionContext;
}

export type MorePartsOptions = Omit<
  DecomposeTaskOptions,
  'inspectTools' | 'onPromptResolved' | 'findingContract'
> & {
  findingContract?: FindingContractFeedbackContext;
  cancellablePartIds: readonly string[];
};

export interface MorePartsResponse {
  done: boolean;
  reasoning: string;
  cancelPartIds: string[];
  parts: PartDefinition[];
  providerUsage?: ProviderUsageSnapshot;
  findingContractDecision?: FindingContractTeamLeaderDecision;
}

export interface DecomposeTaskResponse {
  parts: PartDefinition[];
  providerUsage?: ProviderUsageSnapshot;
}

export async function requestDecompositionRawResponse(
  instruction: string,
  maxInitialParts: number | undefined,
  options: DecomposeTaskOptions,
): Promise<AgentResponse> {
  return requestDecompositionResponse(instruction, maxInitialParts, options);
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
        findingContract: options.findingContract,
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
      outputSchema: options.findingContract === undefined
        ? loadDecompositionSchema(maxInitialParts)
        : withMaxInitialParts(createFindingContractDecompositionJsonSchema(), maxInitialParts),
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
  if (options.findingContract === undefined) {
    return requestValidTeamLeaderDecomposition({
      abortSignal: options.abortSignal,
      request: async (rejectedDecomposition) => {
        const response = await requestDecompositionResponse(
          instruction,
          maxInitialParts,
          options,
          rejectedDecomposition,
        );
        return parseNonFindingContractDecomposition(response, maxInitialParts);
      },
    });
  }

  const response = await requestDecompositionResponse(instruction, maxInitialParts, options);

  if (response.status !== 'done') {
    const detail = response.error || response.content || response.status;
    throw new Error(`Team leader failed: ${detail}`);
  }

  const parts = response.structuredOutput?.parts;
  if (parts != null) {
    const parsedParts = validateFindingContractDecomposition(
      parts,
      maxInitialParts,
      options.findingContract.targetFindingIds,
    );
    return {
      parts: parsedParts,
      ...(response.providerUsage !== undefined ? { providerUsage: response.providerUsage } : {}),
    };
  }

  throw new FindingContractDecompositionValidationError([
    createFindingContractControlValidationIssue({
      boundaryKind: 'decomposition',
      code: 'shape.structured_output',
      category: 'shape',
      path: '$',
      message: 'Finding Contract Team Leader decomposition requires structured output',
      retryability: 'corrective_retry',
    }),
  ], response.content);
}

function parseNonFindingContractDecomposition(
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
    options.findingContract,
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
      outputSchema: options.findingContract === undefined
        ? loadMorePartsSchema()
        : createFindingContractFeedbackJsonSchema(),
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

  const findingContractDecision = options.findingContract === undefined
    ? undefined
    : parseFindingContractTeamLeaderDecision(
        response.structuredOutput,
        {
          targetFindingIds: options.findingContract.targetFindingIds,
          plannedParts: options.findingContract.plannedParts,
          evidence: options.findingContract.evidence,
        },
      );
  return {
    ...(findingContractDecision === undefined
      ? toMorePartsResponse(response.structuredOutput, options.cancellablePartIds)
      : {
          done: findingContractDecision.decision !== 'continue',
          reasoning: findingContractDecision.reasoning,
          cancelPartIds: [],
          parts: findingContractDecision.parts,
          findingContractDecision,
        }),
    ...(response.providerUsage !== undefined ? { providerUsage: response.providerUsage } : {}),
  };
}

function withMaxInitialParts(schema: Record<string, unknown>, maxInitialParts: number | undefined): Record<string, unknown> {
  const clone = structuredClone(schema);
  if (maxInitialParts === undefined) return clone;
  const properties = clone.properties as Record<string, unknown>;
  const parts = properties.parts as Record<string, unknown>;
  parts.maxItems = maxInitialParts;
  return clone;
}
