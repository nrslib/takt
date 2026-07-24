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
  validateFindingContractDecomposition,
} from '../core/workflow/team-leader-finding-contract-decomposition-validation.js';
import {
  createTeamLeaderDecompositionValidationError,
  requestValidTeamLeaderDecomposition,
  type RejectedTeamLeaderDecomposition,
} from './team-leader-decomposition-retry.js';
import { createLogger } from '../shared/utils/index.js';

const log = createLogger('decompose-task-usecase');

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
};

export interface MorePartsResponse {
  done: boolean;
  reasoning: string;
  parts: PartDefinition[];
  providerUsage?: ProviderUsageSnapshot;
  findingContractDecision?: FindingContractTeamLeaderDecision;
}

export interface DecomposeTaskResponse {
  parts: PartDefinition[];
  providerUsage?: ProviderUsageSnapshot;
}

interface DecompositionRequestControl {
  rejectedDecomposition: RejectedTeamLeaderDecomposition | undefined;
  disableStructuredOutputRetry: boolean;
}

export async function requestDecompositionRawResponse(
  instruction: string,
  maxInitialParts: number | undefined,
  options: DecomposeTaskOptions,
): Promise<AgentResponse> {
  return requestDecompositionOnce(
    instruction,
    maxInitialParts,
    options,
    {
      rejectedDecomposition: undefined,
      disableStructuredOutputRetry: false,
    },
  );
}

export async function decomposeTask(
  instruction: string,
  maxInitialParts: number | undefined,
  options: DecomposeTaskOptions,
): Promise<DecomposeTaskResponse> {
  return requestValidTeamLeaderDecomposition({
    abortSignal: options.abortSignal,
    request: async (rejectedDecomposition) => {
      const response = await requestDecompositionOnce(
        instruction,
        maxInitialParts,
        options,
        {
          rejectedDecomposition,
          disableStructuredOutputRetry: true,
        },
      );

      if (response.status !== 'done') {
        const detail = response.error || response.content || response.status;
        throw new Error(`Team leader failed: ${detail}`);
      }

      const rawParts = response.structuredOutput?.parts;
      if (rawParts != null) {
        let parts: PartDefinition[];
        try {
          parts = options.findingContract === undefined
            ? toPartDefinitions(rawParts, maxInitialParts, false)
            : validateFindingContractDecomposition(
                rawParts,
                maxInitialParts,
                options.findingContract.targetFindingIds,
              );
        } catch (error) {
          throw createTeamLeaderDecompositionValidationError(
            'decomposition.parts_invalid',
            '$.parts',
            error,
          );
        }
        return {
          parts,
          ...(response.providerUsage !== undefined ? { providerUsage: response.providerUsage } : {}),
        };
      }

      if (options.findingContract !== undefined) {
        throw createTeamLeaderDecompositionValidationError(
          'decomposition.structured_output_missing',
          '$.parts',
          new Error('Finding Contract Team Leader decomposition requires structured output'),
        );
      }

      let parts: PartDefinition[];
      try {
        parts = parseParts(response.content, maxInitialParts);
      } catch (error) {
        throw createTeamLeaderDecompositionValidationError(
          'decomposition.parts_invalid',
          '$',
          error,
        );
      }
      return {
        parts,
        ...(response.providerUsage !== undefined ? { providerUsage: response.providerUsage } : {}),
      };
    },
    onRejected: (rejectedDecomposition) => {
      log.info('Team Leader decomposition failed validation; regenerating', {
        attempt: rejectedDecomposition.attempt,
        maxAttempts: rejectedDecomposition.maxAttempts,
        issueCodes: rejectedDecomposition.issues.map((issue) => issue.code),
      });
    },
  });
}

async function requestDecompositionOnce(
  instruction: string,
  maxInitialParts: number | undefined,
  options: DecomposeTaskOptions,
  control: DecompositionRequestControl,
): Promise<AgentResponse> {
  let response: AgentResponse;
  try {
    response = await runAgent(options.persona, buildDecomposePrompt(
      instruction,
      maxInitialParts,
      options.language,
      options.inspectTools,
      options.findingContract,
      control.rejectedDecomposition,
    ), {
      cwd: options.cwd,
      personaPath: options.personaPath,
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
      ...(control.disableStructuredOutputRetry ? { structuredOutputRetryCount: 0 } : {}),
      onStream: options.onStream,
      workflowMeta: options.workflowMeta,
      childProcessEnv: options.childProcessEnv,
      abortSignal: options.abortSignal,
      onPromptResolved: options.onPromptResolved,
    });
  } catch (error) {
    options.abortSignal?.throwIfAborted();
    options.onAgentError?.(error);
    throw error;
  }
  options.abortSignal?.throwIfAborted();
  options.onAgentResponse?.(response);
  return response;
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
  );

  let response: AgentResponse;
  try {
    response = await runAgent(options.persona, prompt, {
      cwd: options.cwd,
      personaPath: options.personaPath,
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
      onStream: options.onStream,
      workflowMeta: options.workflowMeta,
      childProcessEnv: options.childProcessEnv,
      abortSignal: options.abortSignal,
    });
  } catch (error) {
    options.onAgentError?.(error);
    throw error;
  }
  options.onAgentResponse?.(response);
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
      ? toMorePartsResponse(response.structuredOutput)
      : {
          done: findingContractDecision.decision !== 'continue',
          reasoning: findingContractDecision.reasoning,
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
