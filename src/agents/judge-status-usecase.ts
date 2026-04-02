import type { PieceRule, RuleMatchMethod, Language } from '../core/models/types.js';
import type { ProviderType } from '../core/piece/types.js';
import { runAgent, type StreamCallback } from './runner.js';
import { detectJudgeIndex, buildJudgePrompt, isValidRuleIndex, buildJudgeConditions } from './judge-utils.js';
import { loadJudgmentSchema, loadEvaluationSchema } from '../infra/resources/schema-loader.js';
import { detectRuleIndex } from '../shared/utils/ruleIndex.js';

export interface JudgeStatusOptions {
  cwd: string;
  movementName: string;
  provider?: ProviderType;
  language?: Language;
  interactive?: boolean;
  onStream?: StreamCallback;
  onJudgeStage?: (entry: {
    stage: 1 | 2 | 3;
    method: 'structured_output' | 'phase3_tag' | 'ai_judge';
    status: 'done' | 'error' | 'skipped';
    instruction: string;
    response: string;
  }) => void;
  onStructuredPromptResolved?: (promptParts: {
    systemPrompt: string;
    userInstruction: string;
  }) => void;
}

export interface TagJudgeRunOptions {
  cwd: string;
  provider?: ProviderType;
  language?: Language;
  onStream?: StreamCallback;
  movementName: string;
}

export async function runTagJudgeStage(
  tagInstruction: string,
  rules: PieceRule[],
  interactiveEnabled: boolean,
  runOptions: TagJudgeRunOptions,
  onJudgeStage?: JudgeStatusOptions['onJudgeStage'],
): Promise<JudgeStatusResult | undefined> {
  const tagResponse = await runAgent('conductor', tagInstruction, {
    cwd: runOptions.cwd,
    provider: runOptions.provider,
    maxTurns: 3,
    permissionMode: 'readonly',
    language: runOptions.language,
    onStream: runOptions.onStream,
  });

  onJudgeStage?.({
    stage: 2,
    method: 'phase3_tag',
    status: tagResponse.status === 'done' ? 'done' : 'error',
    instruction: tagInstruction,
    response: tagResponse.content,
  });

  if (tagResponse.status === 'done') {
    const tagRuleIndex = detectRuleIndex(tagResponse.content, runOptions.movementName);
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
  onJudgeResponse?: (entry: {
    instruction: string;
    status: 'done' | 'error';
    response: string;
  }) => void;
}

export async function evaluateCondition(
  agentOutput: string,
  conditions: Array<{ index: number; text: string }>,
  options: EvaluateConditionOptions,
): Promise<number> {
  const prompt = buildJudgePrompt(agentOutput, conditions);
  const response = await runAgent(undefined, prompt, {
    cwd: options.cwd,
    provider: options.provider,
    maxTurns: 1,
    permissionMode: 'readonly',
    outputSchema: loadEvaluationSchema(),
  });

  options.onJudgeResponse?.({
    instruction: prompt,
    status: response.status === 'done' ? 'done' : 'error',
    response: response.content,
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

export async function judgeStatus(
  structuredInstruction: string,
  tagInstruction: string,
  rules: PieceRule[],
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
    maxTurns: 3,
    permissionMode: 'readonly' as const,
    language: options.language,
    onStream: options.onStream,
  };

  const structuredResponse = await runAgent('conductor', structuredInstruction, {
    ...agentOptions,
    provider: options.provider,
    outputSchema: loadJudgmentSchema(),
    onPromptResolved: options.onStructuredPromptResolved,
  });

  options.onJudgeStage?.({
    stage: 1,
    method: 'structured_output',
    status: structuredResponse.status === 'done' ? 'done' : 'error',
    instruction: structuredInstruction,
    response: structuredResponse.content,
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
    { cwd: options.cwd, provider: options.provider, language: options.language, onStream: options.onStream, movementName: options.movementName },
    options.onJudgeStage,
  );
  if (tagResult !== undefined) {
    return tagResult;
  }

  const conditions = buildJudgeConditions(rules, interactiveEnabled);

  if (conditions.length > 0) {
    let stage3Status: 'done' | 'error' | 'skipped' = 'skipped';
    let stage3Instruction = '';
    let stage3Response = '';
    const normalizedConditions = conditions.map((c, pos) => ({ index: pos, text: c.text }));
    const fallbackPosition = await evaluateCondition(structuredInstruction, normalizedConditions, {
      cwd: options.cwd,
      provider: options.provider,
      onJudgeResponse: (entry) => {
        stage3Status = entry.status;
        stage3Instruction = entry.instruction;
        stage3Response = entry.response;
      },
    });

    options.onJudgeStage?.({
      stage: 3,
      method: 'ai_judge',
      status: stage3Status,
      instruction: stage3Instruction,
      response: stage3Response,
    });

    if (fallbackPosition >= 0 && fallbackPosition < conditions.length) {
      const originalIndex = conditions[fallbackPosition]?.index;
      if (originalIndex !== undefined) {
        return { ruleIndex: originalIndex, method: 'ai_judge' };
      }
    }
  }

  throw new Error(`Status not found for movement "${options.movementName}"`);
}
