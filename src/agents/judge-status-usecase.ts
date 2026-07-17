import type { AgentResponse, WorkflowRule, RuleMatchMethod, Language } from '../core/models/types.js';
import type { ProviderUsageSnapshot } from '../core/models/response.js';
import type { ProviderType } from '../core/workflow/types.js';
import { runAgent, type RunAgentOptions, type StreamCallback } from './runner.js';
import { detectJudgeIndex, buildJudgePrompt, isValidRuleIndex, buildJudgeConditions } from './judge-utils.js';
import { loadJudgmentSchema, loadEvaluationSchema } from '../infra/resources/schema-loader.js';
import { detectRuleIndex } from '../shared/utils/ruleIndex.js';
import { buildMaxTurnsOption } from './provider-call-options.js';
import { getErrorMessage } from '../shared/utils/index.js';

export interface JudgeStatusOptions {
  cwd: string;
  stepName: string;
  provider?: ProviderType;
  resolvedProvider?: ProviderType;
  resolvedModel?: string;
  language?: Language;
  interactive?: boolean;
  childProcessEnv?: RunAgentOptions['childProcessEnv'];
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
  stepName: string;
}

export async function runTagJudgeStage(
  tagInstruction: string,
  rules: WorkflowRule[],
  interactiveEnabled: boolean,
  runOptions: TagJudgeRunOptions,
  onJudgeStage?: JudgeStatusOptions['onJudgeStage'],
): Promise<JudgeStatusResult | undefined> {
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
    status: tagResponse.status === 'done' ? 'done' : 'error',
    instruction: tagInstruction,
    response: tagResponse.content,
    providerUsage: tagResponse.providerUsage,
  });

  if (tagResponse.status === 'done') {
    const tagRuleIndex = detectRuleIndex(tagResponse.content, runOptions.stepName);
    if (isValidRuleIndex(tagRuleIndex, rules, interactiveEnabled)) {
      return { ruleIndex: tagRuleIndex, method: 'phase3_tag' };
    }
  }

  return undefined;
}

export interface JudgeStatusResult {
  ruleIndex: number;
  method: RuleMatchMethod;
}

export interface EvaluateConditionOptions {
  cwd: string;
  provider?: ProviderType;
  resolvedProvider?: ProviderType;
  resolvedModel?: string;
  childProcessEnv?: RunAgentOptions['childProcessEnv'];
  onJudgeResponse?: (entry: {
    instruction: string;
    status: 'done' | 'error';
    response: string;
    providerUsage?: ProviderUsageSnapshot;
  }) => void;
}

export async function evaluateCondition(
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
      outputSchema: loadEvaluationSchema(),
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

  const matchedIndex = response.structuredOutput?.matched_index;
  if (typeof matchedIndex === 'number' && Number.isInteger(matchedIndex)) {
    const zeroBased = matchedIndex - 1;
    if (zeroBased >= 0 && zeroBased < conditions.length) {
      return zeroBased;
    }
  }

  return detectJudgeIndex(response.content);
}

export function createJudgeStageRecorder(): {
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

export async function judgeStatus(
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

  const agentOptions = {
    cwd: options.cwd,
    ...buildMaxTurnsOption(options.provider, options.resolvedProvider, 3),
    permissionMode: 'readonly' as const,
    language: options.language,
    onStream: options.onStream,
    childProcessEnv: options.childProcessEnv,
  };

  let structuredResponse: AgentResponse;
  try {
    structuredResponse = await runAgent('conductor', structuredInstruction, {
      ...agentOptions,
      provider: options.provider,
      resolvedProvider: options.resolvedProvider,
      resolvedModel: options.resolvedModel,
      outputSchema: loadJudgmentSchema(),
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

  if (structuredResponse.status === 'done') {
    const stepNumber = structuredResponse.structuredOutput?.step;
    if (typeof stepNumber === 'number' && Number.isInteger(stepNumber)) {
      const ruleIndex = stepNumber - 1;
      if (isValidRuleIndex(ruleIndex, rules, interactiveEnabled)) {
        return { ruleIndex, method: 'structured_output' };
      }
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
    const normalizedConditions = conditions.map((c, pos) => ({ index: pos, text: c.text }));
    let fallbackPosition: number;
    try {
      fallbackPosition = await evaluateCondition(structuredInstruction, normalizedConditions, {
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

    if (fallbackPosition >= 0 && fallbackPosition < conditions.length) {
      const originalIndex = conditions[fallbackPosition]?.index;
      if (originalIndex !== undefined) {
        return { ruleIndex: originalIndex, method: 'ai_judge' };
      }
    }
  }

  throw new Error(`Status not found for step "${options.stepName}"`);
}
