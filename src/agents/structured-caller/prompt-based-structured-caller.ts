import type { AgentResponse } from '../../core/models/types.js';
import type { SemanticRuleCandidate } from '../../core/models/workflow-rule-condition.js';
import {
  buildPromptBasedDecomposePrompt,
  buildPromptBasedMorePartsPrompt,
  toMorePartsResponse,
} from '../team-leader-structured-output.js';
import { buildJudgePrompt, detectJudgeIndex } from '../judge-utils.js';
import { runAgent } from '../runner.js';
import {
  isValidCandidateIndex,
  runJudgeFallbackStages,
  type EvaluateConditionOptions,
  type JudgeStatusOptions,
  type JudgeStatusResult,
} from '../judge-status-usecase.js';
import type {
  DecomposeTaskOptions,
  DecomposeTaskResponse,
  MorePartsOptions,
  MorePartsResponse,
  TeamLeaderPartFeedbackResult,
} from '../decompose-task-usecase.js';
import type { StructuredCaller } from './contracts.js';
import {
  buildPromptBasedStructuredInstruction,
  getErrorDetail,
  parseLastJsonBlock,
  resolveStructuredStep,
} from './shared.js';
import { parseParts } from '../../core/workflow/engine/task-decomposer.js';
import { createLogger, delay, getErrorMessage } from '../../shared/utils/index.js';
import { buildMaxTurnsOption } from '../provider-call-options.js';
import {
  createPublicationGuardedStreamCallback,
  requestValidTeamLeaderDecomposition,
  TeamLeaderDecompositionValidationError,
} from '../team-leader-decomposition-regeneration.js';
import {
  normalizeFindingIntake,
  type NormalizeFindingIntakeOptions,
} from '../finding-intake-normalizer-usecase.js';

const log = createLogger('prompt-based-structured-caller');

const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_DELAY_MS = 1000;

export class PromptBasedStructuredCaller implements StructuredCaller {
  async normalizeFindingIntake(
    report: string,
    options: NormalizeFindingIntakeOptions,
  ): Promise<AgentResponse> {
    return normalizeFindingIntake(report, options);
  }

  async judgeStatus(
    structuredInstruction: string,
    tagInstruction: string,
    candidates: SemanticRuleCandidate[],
    options: JudgeStatusOptions,
  ): Promise<JudgeStatusResult> {
    options.abortSignal?.throwIfAborted();
    if (candidates.length < 2) {
      throw new Error('judgeStatus requires at least two semantic candidates');
    }

    let structuredResponse: AgentResponse;
    try {
      structuredResponse = await runAgent('conductor', buildPromptBasedStructuredInstruction(structuredInstruction), {
        cwd: options.cwd,
        provider: options.provider,
        resolvedProvider: options.resolvedProvider,
        resolvedModel: options.resolvedModel,
        ...buildMaxTurnsOption(options.provider, options.resolvedProvider, 3),
        permissionMode: 'readonly',
        language: options.language,
        onStream: options.onStream,
        childProcessEnv: options.childProcessEnv,
        abortSignal: options.abortSignal,
        onPromptResolved: options.onStructuredPromptResolved,
      });
    } catch (error) {
      options.onJudgeStage?.({
        stage: 1,
        method: 'structured_output',
        status: 'error',
        instruction: structuredInstruction,
        response: getErrorMessage(error),
      });
      throw error;
    }

    options.onJudgeStage?.({
      stage: 1,
      method: 'structured_output',
      status: options.abortSignal?.aborted === true
        ? 'error'
        : structuredResponse.status === 'done' ? 'done' : 'error',
      instruction: structuredInstruction,
      response: structuredResponse.content,
      providerUsage: structuredResponse.providerUsage,
    });

    options.abortSignal?.throwIfAborted();

    let structuredParseError: string | undefined;
    if (structuredResponse.status === 'done') {
      try {
        const candidateIndex = resolveStructuredStep(parseLastJsonBlock(structuredResponse.content));
        if (isValidCandidateIndex(candidateIndex, candidates)) {
          return { candidateIndex, method: 'structured_output' };
        }
      } catch (error) {
        structuredParseError = getErrorDetail(error);
      }
    }

    const detail = structuredParseError == null
      ? undefined
      : ` Structured response parsing failed: ${structuredParseError}`;
    return runJudgeFallbackStages(
      structuredInstruction,
      tagInstruction,
      candidates,
      options,
      this.evaluateCondition.bind(this),
      detail,
    );
  }

  async evaluateCondition(
    agentOutput: string,
    conditions: Array<{ index: number; text: string }>,
    options: EvaluateConditionOptions,
  ): Promise<number> {
    options.abortSignal?.throwIfAborted();
    const prompt = buildJudgePrompt(agentOutput, conditions);
    let response: AgentResponse;
    try {
      response = await runAgent(undefined, prompt, {
        cwd: options.cwd,
        provider: options.provider,
        resolvedProvider: options.resolvedProvider,
        resolvedModel: options.resolvedModel,
        ...buildMaxTurnsOption(options.provider, options.resolvedProvider, 1),
        permissionMode: 'readonly',
        childProcessEnv: options.childProcessEnv,
        abortSignal: options.abortSignal,
      });
    } catch (error) {
      options.onJudgeResponse?.({
        instruction: prompt,
        status: 'error',
        response: getErrorMessage(error),
      });
      throw error;
    }

    options.onJudgeResponse?.({
      instruction: prompt,
      status: options.abortSignal?.aborted === true
        ? 'error'
        : response.status === 'done' ? 'done' : 'error',
      response: response.content,
      providerUsage: response.providerUsage,
    });

    options.abortSignal?.throwIfAborted();

    if (response.status !== 'done') {
      return -1;
    }

    return detectJudgeIndex(response.content);
  }

  async decomposeTask(
    instruction: string,
    maxInitialParts: number | undefined,
    options: DecomposeTaskOptions,
  ): Promise<DecomposeTaskResponse> {
    return requestValidTeamLeaderDecomposition({
      abortSignal: options.abortSignal,
      request: async (rejectedDecomposition) => {
        const prompt = buildPromptBasedDecomposePrompt(
          instruction,
          {
            maxInitialParts,
            language: options.language,
            inspectTools: options.inspectTools,
            rejectedDecomposition,
          },
        );
        const response = await this.requestPromptBasedRawResponse(
          prompt,
          options,
          options.inspectTools ?? [],
        );

        if (response.status !== 'done') {
          const detail = response.error || response.content || response.status;
          throw new Error(`Team leader failed: ${detail}`);
        }

        try {
          return {
            parts: parseParts(response.content, maxInitialParts),
            ...(response.providerUsage !== undefined
              ? { providerUsage: response.providerUsage }
              : {}),
          };
        } catch (error) {
          throw new TeamLeaderDecompositionValidationError(
            'decomposition.parts_invalid',
            '$',
            error,
          );
        }
      },
    });
  }

  async requestMoreParts(
    originalInstruction: string,
    allResults: TeamLeaderPartFeedbackResult[],
    existingIds: string[],
    options: MorePartsOptions,
  ): Promise<MorePartsResponse> {
    const prompt = buildPromptBasedMorePartsPrompt(
      originalInstruction,
      allResults,
      existingIds,
      options.language,
      options.cancellablePartIds,
    );

    return withRetry(async () => {
      const response = await this.requestPromptBasedRawResponse(prompt, options, []);
      if (response.status !== 'done') {
        const detail = response.error || response.content || response.status;
        throw new Error(`Team leader feedback failed: ${detail}`);
      }
      const raw = parseLastJsonBlock(response.content);
      return {
        ...toMorePartsResponse(raw, options.cancellablePartIds),
        ...(response.providerUsage !== undefined ? { providerUsage: response.providerUsage } : {}),
      };
    }, options.abortSignal);
  }

  private async requestPromptBasedRawResponse(
    prompt: string,
    options: DecomposeTaskOptions | MorePartsOptions,
    allowedTools: string[],
  ): Promise<AgentResponse> {
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
        allowedTools,
        mcpServers: options.mcpServers,
        permissionMode: 'readonly',
        onStream: createPublicationGuardedStreamCallback(options.onStream, options.abortSignal),
        workflowMeta: options.workflowMeta,
        childProcessEnv: options.childProcessEnv,
        abortSignal: options.abortSignal,
        ...('onPromptResolved' in options
          ? { onPromptResolved: options.onPromptResolved }
          : {}),
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
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

async function delayWithAbort(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    await delay(milliseconds);
    return;
  }
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function withRetry<T>(
  runOnce: () => Promise<T>,
  abortSignal: AbortSignal | undefined,
  shouldRetry: (error: unknown) => boolean = () => true,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    throwIfAborted(abortSignal);
    try {
      return await runOnce();
    } catch (error) {
      lastError = error;
      throwIfAborted(abortSignal);
      if (!shouldRetry(error)) {
        throw error;
      }
      if (attempt < RETRY_MAX_ATTEMPTS) {
        log.info('Structured call failed, retrying', {
          attempt,
          maxAttempts: RETRY_MAX_ATTEMPTS,
          error: getErrorMessage(error),
        });
        await delayWithAbort(RETRY_DELAY_MS, abortSignal);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(getErrorMessage(lastError));
}
