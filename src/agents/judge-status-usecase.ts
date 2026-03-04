import type { PieceRule, RuleMatchMethod, Language } from '../core/models/types.js';
import { runAgent, type StreamCallback } from './runner.js';
import { detectJudgeIndex, buildJudgePrompt } from './judge-utils.js';
import { loadJudgmentSchema, loadEvaluationSchema } from '../infra/resources/schema-loader.js';
import { detectRuleIndex } from '../shared/utils/ruleIndex.js';

export interface JudgeStatusOptions {
  cwd: string;
  movementName: string;
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

export interface JudgeStatusResult {
  ruleIndex: number;
  method: RuleMatchMethod;
}

export interface EvaluateConditionOptions {
  cwd: string;
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

  const isValidRuleIndex = (index: number): boolean => {
    if (index < 0 || index >= rules.length) return false;
    const rule = rules[index];
    return !(rule?.interactiveOnly && !interactiveEnabled);
  };

  const agentOptions = {
    cwd: options.cwd,
    maxTurns: 3,
    permissionMode: 'readonly' as const,
    language: options.language,
    onStream: options.onStream,
  };

  const structuredResponse = await runAgent('conductor', structuredInstruction, {
    ...agentOptions,
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
      if (isValidRuleIndex(ruleIndex)) {
        return { ruleIndex, method: 'structured_output' };
      }
    }
  }

  const tagResponse = await runAgent('conductor', tagInstruction, agentOptions);

  options.onJudgeStage?.({
    stage: 2,
    method: 'phase3_tag',
    status: tagResponse.status === 'done' ? 'done' : 'error',
    instruction: tagInstruction,
    response: tagResponse.content,
  });

  if (tagResponse.status === 'done') {
    const tagRuleIndex = detectRuleIndex(tagResponse.content, options.movementName);
    if (isValidRuleIndex(tagRuleIndex)) {
      return { ruleIndex: tagRuleIndex, method: 'phase3_tag' };
    }
  }

  const conditions = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => interactiveEnabled || !rule.interactiveOnly)
    .map(({ index, rule }) => ({ index, text: rule.condition }));

  if (conditions.length > 0) {
    let stage3Status: 'done' | 'error' | 'skipped' = 'skipped';
    let stage3Instruction = '';
    let stage3Response = '';
    const fallbackIndex = await evaluateCondition(structuredInstruction, conditions, {
      cwd: options.cwd,
      onJudgeResponse: (entry) => {
        stage3Status = entry.status;
        stage3Instruction = entry.instruction;
        stage3Response = entry.response;
      },
    });

    if (stage3Status === 'skipped' || stage3Instruction === '') {
      throw new Error(`AI judge response missing for movement "${options.movementName}"`);
    }

    options.onJudgeStage?.({
      stage: 3,
      method: 'ai_judge',
      status: stage3Status,
      instruction: stage3Instruction,
      response: stage3Response,
    });

    if (fallbackIndex >= 0 && fallbackIndex < conditions.length) {
      const originalIndex = conditions[fallbackIndex]?.index;
      if (originalIndex !== undefined) {
        return { ruleIndex: originalIndex, method: 'ai_judge' };
      }
    }
  }

  throw new Error(`Status not found for movement "${options.movementName}"`);
}
