import type { Language, PartDefinition } from '../core/models/types.js';
import { runAgent, type StreamCallback } from './runner.js';
import { parseParts } from '../core/piece/engine/task-decomposer.js';
import { loadDecompositionSchema, loadMorePartsSchema } from '../infra/resources/schema-loader.js';
import { ensureUniquePartIds, parsePartDefinitionEntry } from '../core/piece/part-definition-validator.js';

export interface DecomposeTaskOptions {
  cwd: string;
  persona?: string;
  personaPath?: string;
  language?: Language;
  model?: string;
  provider?: 'claude' | 'codex' | 'opencode' | 'cursor' | 'copilot' | 'mock';
  onStream?: StreamCallback;
  onPromptResolved?: (promptParts: {
    systemPrompt: string;
    userInstruction: string;
  }) => void;
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
    maxTurns: 4,
    outputSchema: loadDecompositionSchema(maxParts),
    onStream: options.onStream,
    onPromptResolved: options.onPromptResolved,
  });

  if (response.status !== 'done') {
    const detail = response.error || response.content || response.status;
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
    maxTurns: 4,
    outputSchema: loadMorePartsSchema(maxAdditionalParts),
    onStream: options.onStream,
  });

  if (response.status !== 'done') {
    const detail = response.error || response.content || response.status;
    throw new Error(`Team leader feedback failed: ${detail}`);
  }

  return toMorePartsResponse(response.structuredOutput, maxAdditionalParts);
}
