import type { Language, PartDefinition } from '../core/models/types.js';
import { ensureUniquePartIds, parsePartDefinitionEntry } from '../core/piece/part-definition-validator.js';
import type { MorePartsResponse } from './decompose-task-usecase.js';

function summarizePartContent(content: string): string {
  const maxLength = 2000;
  if (content.length <= maxLength) {
    return content;
  }

  return `${content.slice(0, maxLength)}\n...[truncated]`;
}

export function toPartDefinitions(raw: unknown, maxParts: number): PartDefinition[] {
  if (!Array.isArray(raw)) {
    throw new Error('Structured output "parts" must be an array');
  }
  if (raw.length === 0) {
    throw new Error('Structured output "parts" must not be empty');
  }
  if (raw.length > maxParts) {
    throw new Error(`Structured output produced too many parts: ${raw.length} > ${maxParts}`);
  }

  const parts = raw.map((entry, index) => parsePartDefinitionEntry(entry, index));
  ensureUniquePartIds(parts);
  return parts;
}

export function toMorePartsResponse(raw: unknown, maxAdditionalParts: number): MorePartsResponse {
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

  const parts = payload.parts.map((entry, index) => parsePartDefinitionEntry(entry, index));
  ensureUniquePartIds(parts);

  return {
    done: payload.done,
    reasoning: payload.reasoning,
    parts,
  };
}

function buildDecomposeBasePrompt(instruction: string, maxParts: number, language?: Language): string {
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

function buildMorePartsBasePrompt(
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

export function buildDecomposePrompt(
  instruction: string,
  maxParts: number,
  language?: Language,
): string {
  return buildDecomposeBasePrompt(instruction, maxParts, language);
}

export function buildPromptBasedDecomposePrompt(
  instruction: string,
  maxParts: number,
  language?: Language,
): string {
  const outputInstruction = language === 'ja'
    ? [
        '',
        '出力形式:',
        '- ```json ... ``` ブロックのみを返す',
        '- JSON は配列にする',
        '- 各要素は {"id","title","instruction","timeout_ms?"} を持つ',
      ]
    : [
        '',
        'Output format:',
        '- Return only one ```json ... ``` block',
        '- The JSON must be an array',
        '- Each item must include {"id","title","instruction","timeout_ms?"}',
      ];

  return `${buildDecomposeBasePrompt(instruction, maxParts, language)}\n${outputInstruction.join('\n')}`;
}

export function buildMorePartsPrompt(
  originalInstruction: string,
  allResults: Array<{ id: string; title: string; status: string; content: string }>,
  existingIds: string[],
  maxAdditionalParts: number,
  language?: Language,
): string {
  return buildMorePartsBasePrompt(
    originalInstruction,
    allResults,
    existingIds,
    maxAdditionalParts,
    language,
  );
}

export function buildPromptBasedMorePartsPrompt(
  originalInstruction: string,
  allResults: Array<{ id: string; title: string; status: string; content: string }>,
  existingIds: string[],
  maxAdditionalParts: number,
  language?: Language,
): string {
  const outputInstruction = language === 'ja'
    ? [
        '',
        '出力形式:',
        '- ```json ... ``` ブロックのみを返す',
        '- JSON は {"done": boolean, "reasoning": string, "parts": []} の形にする',
      ]
    : [
        '',
        'Output format:',
        '- Return only one ```json ... ``` block',
        '- The JSON must be {"done": boolean, "reasoning": string, "parts": []}',
      ];

  return `${buildMorePartsBasePrompt(
    originalInstruction,
    allResults,
    existingIds,
    maxAdditionalParts,
    language,
  )}\n${outputInstruction.join('\n')}`;
}
