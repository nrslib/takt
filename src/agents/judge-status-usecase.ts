import type { AgentResponse, RuleMatchMethod, Language } from '../core/models/types.js';
import type { SemanticRuleCandidate } from '../core/models/workflow-rule-condition.js';
import type { ProviderUsageSnapshot } from '../core/models/response.js';
import type { ProviderType } from '../core/workflow/types.js';
import { runAgent, type RunAgentOptions, type StreamCallback } from './runner.js';
import { detectJudgeIndex, buildJudgePrompt } from './judge-utils.js';
import { loadJudgmentSchema, loadEvaluationSchema } from '../infra/resources/schema-loader.js';
import { detectCandidateIndex } from '../shared/utils/ruleIndex.js';
import { buildMaxTurnsOption } from './provider-call-options.js';
import {
  assertStructuredOutputSchema,
  StructuredOutputValueValidationError,
  validateStructuredOutputAgainstSchema,
} from '../core/workflow/engine/structured-output-schema-validator.js';
import { getErrorMessage } from '../shared/utils/index.js';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';

export interface JudgeStatusOptions {
  cwd: string;
  stepName: string;
  provider?: ProviderType;
  resolvedProvider?: ProviderType;
  resolvedModel?: string;
  language?: Language;
  childProcessEnv?: RunAgentOptions['childProcessEnv'];
  abortSignal?: AbortSignal;
  onStream?: StreamCallback;
  onJudgeStage?: (entry: JudgeStageLogEntry) => void;
  onStructuredPromptResolved?: (promptParts: {
    systemPrompt: string;
    userInstruction: string;
  }) => void;
}

export interface JudgeStageLogEntry {
  stage: 1 | 2 | 3;
  method: 'structured_output' | 'phase3_tag' | 'ai_judge';
  status: 'done' | 'error' | 'skipped';
  instruction: string;
  response: string;
  providerUsage?: ProviderUsageSnapshot;
}

type JudgeResponseEntry = Pick<JudgeStageLogEntry, 'instruction' | 'status' | 'response' | 'providerUsage'>;

export interface TagJudgeRunOptions {
  cwd: string;
  provider?: ProviderType;
  resolvedProvider?: ProviderType;
  resolvedModel?: string;
  language?: Language;
  onStream?: StreamCallback;
  childProcessEnv?: RunAgentOptions['childProcessEnv'];
  abortSignal?: AbortSignal;
  stepName: string;
  onPromptResolved?: JudgeStatusOptions['onStructuredPromptResolved'];
}

export async function runTagJudgeStage(
  tagInstruction: string,
  candidates: SemanticRuleCandidate[],
  runOptions: TagJudgeRunOptions,
  onJudgeStage?: JudgeStatusOptions['onJudgeStage'],
): Promise<JudgeStatusResult | undefined> {
  runOptions.abortSignal?.throwIfAborted();
  let tagResponse: AgentResponse;
  try {
    tagResponse = await runAgent('conductor', tagInstruction, {
      cwd: runOptions.cwd,
      provider: runOptions.provider,
      resolvedProvider: runOptions.resolvedProvider,
      resolvedModel: runOptions.resolvedModel,
      ...buildMaxTurnsOption(runOptions.provider, runOptions.resolvedProvider, 3),
      permissionMode: 'readonly',
      language: runOptions.language,
      onStream: runOptions.onStream,
      childProcessEnv: runOptions.childProcessEnv,
      abortSignal: runOptions.abortSignal,
      onPromptResolved: runOptions.onPromptResolved,
    });
  } catch (error) {
    onJudgeStage?.({
      stage: 2,
      method: 'phase3_tag',
      status: 'error',
      instruction: tagInstruction,
      response: getErrorMessage(error),
    });
    throw error;
  }

  onJudgeStage?.({
    stage: 2,
    method: 'phase3_tag',
    status: runOptions.abortSignal?.aborted === true
      ? 'error'
      : tagResponse.status === 'done' ? 'done' : 'error',
    instruction: tagInstruction,
    response: tagResponse.content,
    providerUsage: tagResponse.providerUsage,
  });

  runOptions.abortSignal?.throwIfAborted();

  if (tagResponse.status === 'done') {
    const tagCandidateIndex = detectCandidateIndex(tagResponse.content, runOptions.stepName);
    if (isValidCandidateIndex(tagCandidateIndex, candidates)) {
      return { candidateIndex: tagCandidateIndex, method: 'phase3_tag' };
    }
  }

  return undefined;
}

export interface JudgeStatusResult {
  candidateIndex: number;
  method: RuleMatchMethod;
}

export function isValidCandidateIndex(index: number, candidates: SemanticRuleCandidate[]): boolean {
  return Number.isInteger(index) && index >= 0 && index < candidates.length;
}

export interface EvaluateConditionOptions {
  cwd: string;
  provider?: ProviderType;
  resolvedProvider?: ProviderType;
  resolvedModel?: string;
  childProcessEnv?: RunAgentOptions['childProcessEnv'];
  abortSignal?: AbortSignal;
  onJudgeResponse?: (entry: {
    instruction: string;
    status: 'done' | 'error';
    response: string;
    providerUsage?: ProviderUsageSnapshot;
  }) => void;
}

function isValidJudgeStructuredOutput(
  structuredOutput: Record<string, unknown> | undefined,
  schema: Record<string, unknown>,
): structuredOutput is Record<string, unknown> {
  if (structuredOutput === undefined) {
    return false;
  }

  try {
    validateStructuredOutputAgainstSchema(structuredOutput, schema);
    return true;
  } catch (error) {
    if (error instanceof StructuredOutputValueValidationError) {
      return false;
    }
    throw error;
  }
}

export async function evaluateCondition(
  agentOutput: string,
  conditions: Array<{ index: number; text: string }>,
  options: EvaluateConditionOptions,
): Promise<number> {
  options.abortSignal?.throwIfAborted();
  const prompt = buildJudgePrompt(agentOutput, conditions);
  const evaluationSchema = loadEvaluationSchema();
  assertStructuredOutputSchema(evaluationSchema);
  const response = await runAgent(undefined, prompt, {
    cwd: options.cwd,
    provider: options.provider,
    resolvedProvider: options.resolvedProvider,
    resolvedModel: options.resolvedModel,
    ...buildMaxTurnsOption(options.provider, options.resolvedProvider, 1),
    permissionMode: 'readonly',
    outputSchema: evaluationSchema,
    childProcessEnv: options.childProcessEnv,
    abortSignal: options.abortSignal,
  });

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

  const matchedIndex = isValidJudgeStructuredOutput(response.structuredOutput, evaluationSchema)
    ? response.structuredOutput.matched_index
    : undefined;
  if (typeof matchedIndex === 'number' && Number.isInteger(matchedIndex)) {
    const zeroBased = matchedIndex - 1;
    if (zeroBased >= 0 && zeroBased < conditions.length) {
      return zeroBased;
    }
  }

  return detectJudgeIndex(response.content);
}

function createJudgeStageRecorder(): {
  capture(entry: JudgeResponseEntry): void;
  stage(entry: Pick<JudgeStageLogEntry, 'stage' | 'method'>): JudgeStageLogEntry;
} {
  let latest: JudgeResponseEntry = {
    status: 'skipped',
    instruction: '',
    response: '',
  };
  return {
    capture(entry): void {
      latest = entry;
    },
    stage(entry): JudgeStageLogEntry {
      return {
        ...entry,
        ...latest,
      };
    },
  };
}

type JudgeConditionEvaluator = (
  agentOutput: string,
  conditions: Array<{ index: number; text: string }>,
  options: EvaluateConditionOptions,
) => Promise<number>;

async function runAiJudgeStage(
  structuredInstruction: string,
  candidates: SemanticRuleCandidate[],
  options: JudgeStatusOptions,
  evaluate: JudgeConditionEvaluator,
): Promise<JudgeStatusResult | undefined> {
  const conditions = candidates.map((candidate, index) => ({ index, text: candidate.label }));
  const stage3 = createJudgeStageRecorder();
  let candidateIndex: number;
  try {
    candidateIndex = await evaluate(structuredInstruction, conditions, {
      cwd: options.cwd,
      provider: options.provider,
      resolvedProvider: options.resolvedProvider,
      resolvedModel: options.resolvedModel,
      childProcessEnv: options.childProcessEnv,
      abortSignal: options.abortSignal,
      onJudgeResponse: stage3.capture,
    });
  } catch (error) {
    const entry = stage3.stage({ stage: 3, method: 'ai_judge' });
    options.onJudgeStage?.(entry.status === 'skipped'
      ? {
          stage: 3,
          method: 'ai_judge',
          status: 'error',
          instruction: structuredInstruction,
          response: getErrorMessage(error),
        }
      : entry);
    throw error;
  }

  options.onJudgeStage?.(stage3.stage({ stage: 3, method: 'ai_judge' }));
  return isValidCandidateIndex(candidateIndex, candidates)
    ? { candidateIndex, method: 'ai_judge' }
    : undefined;
}

export async function runJudgeFallbackStages(
  structuredInstruction: string,
  tagInstruction: string,
  candidates: SemanticRuleCandidate[],
  options: JudgeStatusOptions,
  evaluate: JudgeConditionEvaluator,
  detectionFailureDetail?: string,
): Promise<JudgeStatusResult> {
  const tagResult = await runTagJudgeStage(
    tagInstruction,
    candidates,
    {
      cwd: options.cwd,
      provider: options.provider,
      resolvedProvider: options.resolvedProvider,
      resolvedModel: options.resolvedModel,
      language: options.language,
      onStream: options.onStream,
      childProcessEnv: options.childProcessEnv,
      abortSignal: options.abortSignal,
      stepName: options.stepName,
      onPromptResolved: options.onStructuredPromptResolved,
    },
    options.onJudgeStage,
  );
  if (tagResult !== undefined) {
    return tagResult;
  }

  const aiJudgeResult = await runAiJudgeStage(
    structuredInstruction,
    candidates,
    options,
    evaluate,
  );
  if (aiJudgeResult !== undefined) {
    return aiJudgeResult;
  }

  throw new RuleDetectionExhaustedError(options.stepName, detectionFailureDetail);
}

export async function judgeStatus(
  structuredInstruction: string,
  tagInstruction: string,
  candidates: SemanticRuleCandidate[],
  options: JudgeStatusOptions,
): Promise<JudgeStatusResult> {
  options.abortSignal?.throwIfAborted();
  if (candidates.length < 2) {
    throw new Error('judgeStatus requires at least two semantic candidates');
  }

  const judgmentSchema = loadJudgmentSchema();
  assertStructuredOutputSchema(judgmentSchema);

  const agentOptions = {
    cwd: options.cwd,
    ...buildMaxTurnsOption(options.provider, options.resolvedProvider, 3),
    permissionMode: 'readonly' as const,
    language: options.language,
    onStream: options.onStream,
    childProcessEnv: options.childProcessEnv,
    abortSignal: options.abortSignal,
  };

  const structuredResponse = await runAgent('conductor', structuredInstruction, {
    ...agentOptions,
    provider: options.provider,
    resolvedProvider: options.resolvedProvider,
    resolvedModel: options.resolvedModel,
    outputSchema: judgmentSchema,
    onPromptResolved: options.onStructuredPromptResolved,
  });

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

  if (structuredResponse.status === 'done' && isValidJudgeStructuredOutput(structuredResponse.structuredOutput, judgmentSchema)) {
    const stepNumber = structuredResponse.structuredOutput.step;
    if (typeof stepNumber === 'number' && Number.isInteger(stepNumber)) {
      const candidateIndex = stepNumber - 1;
      if (isValidCandidateIndex(candidateIndex, candidates)) {
        return { candidateIndex, method: 'structured_output' };
      }
    }
  }

  return runJudgeFallbackStages(
    structuredInstruction,
    tagInstruction,
    candidates,
    options,
    evaluateCondition,
  );
}
