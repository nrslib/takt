import type { AgentResponse, PartDefinition, PieceRule, RuleMatchMethod, Language } from '../models/types.js';
import { runAgent, type RunAgentOptions } from '../../agents/runner.js';
import { detectJudgeIndex, buildJudgePrompt } from '../../agents/judge-utils.js';
import { parseParts } from './engine/task-decomposer.js';
import { loadJudgmentSchema, loadEvaluationSchema, loadDecompositionSchema } from './schema-loader.js';
import { detectRuleIndex } from '../../shared/utils/ruleIndex.js';
import { ensureUniquePartIds, parsePartDefinitionEntry } from './part-definition-validator.js';

export interface JudgeStatusOptions {
  cwd: string;
  movementName: string;
  language?: Language;
  interactive?: boolean;
}

export interface JudgeStatusResult {
  ruleIndex: number;
  method: RuleMatchMethod;
}

export interface EvaluateConditionOptions {
  cwd: string;
}

export interface DecomposeTaskOptions {
  cwd: string;
  persona?: string;
  language?: Language;
  model?: string;
  provider?: 'claude' | 'codex' | 'opencode' | 'cursor' | 'mock';
}

function toPartDefinitions(raw: unknown, maxParts: number): PartDefinition[] {
  if (!Array.isArray(raw)) {
    throw new Error('Structured output "parts" must be an array');
  }
  if (raw.length === 0) {
    throw new Error('Structured output "parts" must not be empty');
  }
  if (raw.length > maxParts) {
    throw new Error(`Structured output produced too many parts: ${raw.length} > ${maxParts}`);
  }

  const parts: PartDefinition[] = raw.map((entry, index) => parsePartDefinitionEntry(entry, index));
  ensureUniquePartIds(parts);

  return parts;
}

export async function executeAgent(
  persona: string | undefined,
  instruction: string,
  options: RunAgentOptions,
): Promise<AgentResponse> {
  return runAgent(persona, instruction, options);
}
export const generateReport = executeAgent;
export const executePart = executeAgent;

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
  };

  // Stage 1: Structured output
  const structuredResponse = await runAgent('conductor', structuredInstruction, {
    ...agentOptions,
    outputSchema: loadJudgmentSchema(),
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

  // Stage 2: Tag detection (dedicated call, no outputSchema)
  const tagResponse = await runAgent('conductor', tagInstruction, agentOptions);

  if (tagResponse.status === 'done') {
    const tagRuleIndex = detectRuleIndex(tagResponse.content, options.movementName);
    if (isValidRuleIndex(tagRuleIndex)) {
      return { ruleIndex: tagRuleIndex, method: 'phase3_tag' };
    }
  }

  // Stage 3: AI judge
  const conditions = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => interactiveEnabled || !rule.interactiveOnly)
    .map(({ index, rule }) => ({ index, text: rule.condition }));

  if (conditions.length > 0) {
    const fallbackIndex = await evaluateCondition(structuredInstruction, conditions, { cwd: options.cwd });
    if (fallbackIndex >= 0 && fallbackIndex < conditions.length) {
      const originalIndex = conditions[fallbackIndex]?.index;
      if (originalIndex !== undefined) {
        return { ruleIndex: originalIndex, method: 'ai_judge' };
      }
    }
  }

  throw new Error(`Status not found for movement "${options.movementName}"`);
}

export async function decomposeTask(
  instruction: string,
  maxParts: number,
  options: DecomposeTaskOptions,
): Promise<PartDefinition[]> {
  const response = await runAgent(options.persona, instruction, {
    cwd: options.cwd,
    language: options.language,
    model: options.model,
    provider: options.provider,
    permissionMode: 'readonly',
    maxTurns: 3,
    outputSchema: loadDecompositionSchema(maxParts),
  });

  if (response.status !== 'done') {
    const detail = response.error ?? response.content;
    throw new Error(`Team leader failed: ${detail}`);
  }

  const parts = response.structuredOutput?.parts;
  if (parts != null) {
    return toPartDefinitions(parts, maxParts);
  }

  return parseParts(response.content, maxParts);
}
