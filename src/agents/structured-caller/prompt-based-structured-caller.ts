import type { AgentResponse, WorkflowRule } from '../../core/models/types.js';
import {
  buildPromptBasedDecomposePrompt,
  buildPromptBasedMorePartsPrompt,
  toMorePartsResponse,
} from '../team-leader-structured-output.js';
import { buildJudgePrompt, detectJudgeIndex, isValidRuleIndex, buildJudgeConditions } from '../judge-utils.js';
import { runAgent } from '../runner.js';
import {
  createJudgeStageRecorder,
  runTagJudgeStage,
  type EvaluateConditionOptions,
  type JudgeStatusOptions,
  type JudgeStatusResult,
} from '../judge-status-usecase.js';
import type {
  DecomposeTaskOptions,
  DecomposeTaskResponse,
  MorePartsOptions,
  MorePartsResponse,
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

const log = createLogger('prompt-based-structured-caller');

const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_DELAY_MS = 1000;

export class PromptBasedStructuredCaller implements StructuredCaller {
  async judgeStatus(
    structuredInstruction: string,
    tagInstruction: string,
    rules: WorkflowRule[],
    options: JudgeStatusOptions,
  ): Promise<JudgeStatusResult> {
    if (rules.length === 0) {
      throw new Error('judgeStatus requires at least one rule');
    }
    if (rules.length === 1) {
      return { ruleIndex: 0, method: 'auto_select' };
    }

    const interactiveEnabled = options.interactive === true;

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
      status: structuredResponse.status === 'done' ? 'done' : 'error',
      instruction: structuredInstruction,
      response: structuredResponse.content,
      providerUsage: structuredResponse.providerUsage,
    });

    let structuredParseError: string | undefined;
    if (structuredResponse.status === 'done') {
      try {
        const ruleIndex = resolveStructuredStep(parseLastJsonBlock(structuredResponse.content));
        if (isValidRuleIndex(ruleIndex, rules, interactiveEnabled)) {
          return { ruleIndex, method: 'structured_output' };
        }
      } catch (error) {
        structuredParseError = getErrorDetail(error);
      }
    }

    const tagResult = await runTagJudgeStage(
      tagInstruction,
      rules,
      interactiveEnabled,
      {
        cwd: options.cwd,
        provider: options.provider,
        resolvedProvider: options.resolvedProvider,
        resolvedModel: options.resolvedModel,
        language: options.language,
        onStream: options.onStream,
        childProcessEnv: options.childProcessEnv,
        stepName: options.stepName,
      },
      options.onJudgeStage,
    );
    if (tagResult !== undefined) {
      return tagResult;
    }

    const conditions = buildJudgeConditions(rules, interactiveEnabled);

    if (conditions.length > 0) {
      const stage3 = createJudgeStageRecorder();
      let fallbackIndex: number;
      try {
        fallbackIndex = await this.evaluateCondition(structuredInstruction, conditions, {
          cwd: options.cwd,
          provider: options.provider,
          resolvedProvider: options.resolvedProvider,
          resolvedModel: options.resolvedModel,
          childProcessEnv: options.childProcessEnv,
          onJudgeResponse: stage3.capture,
        });
      } catch (error) {
        options.onJudgeStage?.(stage3.stage({
          stage: 3,
          method: 'ai_judge',
        }));
        throw error;
      }

      options.onJudgeStage?.(stage3.stage({
        stage: 3,
        method: 'ai_judge',
      }));

      if (isValidRuleIndex(fallbackIndex, rules, interactiveEnabled)) {
        return { ruleIndex: fallbackIndex, method: 'ai_judge' };
      }
    }

    const detail = structuredParseError == null
      ? ''
      : ` Structured response parsing failed: ${structuredParseError}`;
    throw new Error(`Status not found for step "${options.stepName}".${detail}`);
  }

  async evaluateCondition(
    agentOutput: string,
    conditions: Array<{ index: number; text: string }>,
    options: EvaluateConditionOptions,
  ): Promise<number> {
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
      status: response.status === 'done' ? 'done' : 'error',
      response: response.content,
      providerUsage: response.providerUsage,
    });

    if (response.status !== 'done') {
      return -1;
    }

    return detectJudgeIndex(response.content);
  }

  async decomposeTask(
    instruction: string,
    maxTotalParts: number,
    options: DecomposeTaskOptions,
  ): Promise<DecomposeTaskResponse> {
    const prompt = buildPromptBasedDecomposePrompt(
      instruction,
      maxTotalParts,
      options.language,
      options.inspectTools,
    );

    return withRetry(async () => {
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
          allowedTools: options.inspectTools ?? [],
          mcpServers: options.mcpServers,
          permissionMode: 'readonly',
          onStream: options.onStream,
          workflowMeta: options.workflowMeta,
          childProcessEnv: options.childProcessEnv,
          abortSignal: options.abortSignal,
          onPromptResolved: options.onPromptResolved,
        });
      } catch (error) {
        options.onAgentError?.(error);
        throw error;
      }
      options.onAgentResponse?.(response);

      if (response.status !== 'done') {
        const detail = response.error || response.content || response.status;
        throw new Error(`Team leader failed: ${detail}`);
      }

      return {
        parts: parseParts(response.content, maxTotalParts),
        ...(response.providerUsage !== undefined ? { providerUsage: response.providerUsage } : {}),
      };
    }, options.abortSignal);
  }

  async requestMoreParts(
    originalInstruction: string,
    allResults: Array<{ id: string; title: string; status: string; content: string }>,
    existingIds: string[],
    maxAdditionalParts: number,
    options: MorePartsOptions,
  ): Promise<MorePartsResponse> {
    const prompt = buildPromptBasedMorePartsPrompt(
      originalInstruction,
      allResults,
      existingIds,
      maxAdditionalParts,
      options.language,
    );

    return withRetry(async () => {
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

      if (response.status !== 'done') {
        const detail = response.error || response.content || response.status;
        throw new Error(`Team leader feedback failed: ${detail}`);
      }

      return {
        ...toMorePartsResponse(parseLastJsonBlock(response.content), maxAdditionalParts),
        ...(response.providerUsage !== undefined ? { providerUsage: response.providerUsage } : {}),
      };
    }, options.abortSignal);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('Structured call aborted');
  }
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
      reject(new Error('Structured call aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function withRetry<T>(runOnce: () => Promise<T>, abortSignal: AbortSignal | undefined): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    throwIfAborted(abortSignal);
    try {
      return await runOnce();
    } catch (error) {
      lastError = error;
      throwIfAborted(abortSignal);
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
