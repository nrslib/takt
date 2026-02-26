import type { AgentResponse, PartDefinition, PieceRule, RuleMatchMethod, Language } from '../models/types.js';
import { runAgent, type RunAgentOptions } from '../../agents/runner.js';
import { detectJudgeIndex, buildJudgePrompt } from '../../agents/judge-utils.js';
import { parseParts } from './engine/task-decomposer.js';
import { loadJudgmentSchema, loadEvaluationSchema, loadDecompositionSchema, loadMorePartsSchema } from './schema-loader.js';
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
  personaPath?: string;
  language?: Language;
  model?: string;
  provider?: 'claude' | 'codex' | 'opencode' | 'mock';
}

export interface MorePartsResponse {
  done: boolean;
  reasoning: string;
  parts: PartDefinition[];
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

function toMorePartsResponse(raw: unknown, maxAdditionalParts: number): MorePartsResponse {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) {
    throw new Error('Structured output must be an object');
  }

  const payload = raw as Record<string, unknown>;
  if (typeof payload.done !== 'boolean') {
    throw new Error('Structured output "done" must be a boolean');
  }
  if (typeof payload.reasoning !== 'string') {
    throw new Error('Structured output "reasoning" must be a string');
  }
  if (!Array.isArray(payload.parts)) {
    throw new Error('Structured output "parts" must be an array');
  }
  if (payload.parts.length > maxAdditionalParts) {
    throw new Error(`Structured output produced too many parts: ${payload.parts.length} > ${maxAdditionalParts}`);
  }

  const parts: PartDefinition[] = payload.parts.map((entry, index) => parsePartDefinitionEntry(entry, index));
  ensureUniquePartIds(parts);

  return {
    done: payload.done,
    reasoning: payload.reasoning,
    parts,
  };
}

function summarizePartContent(content: string): string {
  const maxLength = 2000;
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength)}\n...[truncated]`;
}

function buildDecomposePrompt(instruction: string, maxParts: number, language?: Language): string {
  if (language === 'ja') {
    return [
      '以下はタスク分解専用の指示です。タスクを実行せず、分解だけを行ってください。',
      '- ツールは使用しない',
      `- パート数は 1 以上 ${maxParts} 以下`,
      '- パートは互いに独立させる',
      '',
      '## 元タスク',
      instruction,
    ].join('\n');
  }

  return [
    'This is decomposition-only planning. Do not execute the task.',
    '- Do not use any tool',
    `- Produce between 1 and ${maxParts} independent parts`,
    '- Keep each part self-contained',
    '',
    '## Original Task',
    instruction,
  ].join('\n');
}

function buildMorePartsPrompt(
  originalInstruction: string,
  allResults: Array<{ id: string; title: string; status: string; content: string }>,
  existingIds: string[],
  maxAdditionalParts: number,
  language?: Language,
): string {
  const resultBlock = allResults.map((result) => [
    `### ${result.id}: ${result.title} (${result.status})`,
    summarizePartContent(result.content),
  ].join('\n')).join('\n\n');

  if (language === 'ja') {
    return [
      '以下の実行結果を見て、追加のサブタスクが必要か判断してください。',
      '- ツールは使用しない',
      '',
      '## 元タスク',
      originalInstruction,
      '',
      '## 完了済みパート',
      resultBlock || '(なし)',
      '',
      '## 判断ルール',
      '- 追加作業が不要なら done=true にする',
      '- 追加作業が必要なら parts に新しいパートを入れる',
      '- 不足が複数ある場合は、可能な限り一括で複数パートを返す',
      `- 既存IDは再利用しない: ${existingIds.join(', ') || '(なし)'}`,
      `- 追加できる最大数: ${maxAdditionalParts}`,
    ].join('\n');
  }

  return [
    'Review completed part results and decide whether additional parts are needed.',
    '- Do not use any tool',
    '',
    '## Original Task',
    originalInstruction,
    '',
    '## Completed Parts',
    resultBlock || '(none)',
    '',
    '## Decision Rules',
    '- Set done=true when no additional work is required',
    '- If more work is needed, provide new parts in "parts"',
    '- If multiple missing tasks are known, return multiple new parts in one batch when possible',
    `- Do not reuse existing IDs: ${existingIds.join(', ') || '(none)'}`,
    `- Maximum additional parts: ${maxAdditionalParts}`,
  ].join('\n');
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
  const response = await runAgent(options.persona, buildDecomposePrompt(instruction, maxParts, options.language), {
    cwd: options.cwd,
    personaPath: options.personaPath,
    language: options.language,
    model: options.model,
    provider: options.provider,
    allowedTools: [],
    permissionMode: 'readonly',
    maxTurns: 2,
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

export async function requestMoreParts(
  originalInstruction: string,
  allResults: Array<{ id: string; title: string; status: string; content: string }>,
  existingIds: string[],
  maxAdditionalParts: number,
  options: DecomposeTaskOptions,
): Promise<MorePartsResponse> {
  const prompt = buildMorePartsPrompt(
    originalInstruction,
    allResults,
    existingIds,
    maxAdditionalParts,
    options.language,
  );

  const response = await runAgent(options.persona, prompt, {
    cwd: options.cwd,
    personaPath: options.personaPath,
    language: options.language,
    model: options.model,
    provider: options.provider,
    allowedTools: [],
    permissionMode: 'readonly',
    maxTurns: 2,
    outputSchema: loadMorePartsSchema(maxAdditionalParts),
  });

  if (response.status !== 'done') {
    const detail = response.error ?? response.content;
    throw new Error(`Team leader feedback failed: ${detail}`);
  }

  return toMorePartsResponse(response.structuredOutput, maxAdditionalParts);
}
