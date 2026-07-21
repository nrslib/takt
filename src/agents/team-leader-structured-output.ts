import type { Language, PartDefinition } from '../core/models/types.js';
import { ensureUniquePartIds, parsePartDefinitionEntry } from '../core/workflow/part-definition-validator.js';
import type { MorePartsResponse } from './decompose-task-usecase.js';

export function toPartDefinitions(raw: unknown, maxTotalParts: number): PartDefinition[] {
  if (!Array.isArray(raw)) {
    throw new Error('Structured output "parts" must be an array');
  }
  if (raw.length === 0) {
    throw new Error('Structured output "parts" must not be empty');
  }
  if (raw.length > maxTotalParts) {
    throw new Error(`Structured output produced too many total parts: ${raw.length} > max_total_parts ${maxTotalParts}`);
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

function buildInspectToolGuidance(
  language: Language | undefined,
  inspectTools: readonly string[] | undefined,
  options: { requireAtLeastOnePart: boolean },
): string[] {
  const hasInspectTools = inspectTools !== undefined && inspectTools.length > 0;

  if (!hasInspectTools) {
    return language === 'ja'
      ? ['- ツールは使用しない']
      : ['- Do not use any tool'];
  }

  const guidance = language === 'ja'
    ? [
        '- 読み取り専用 inspection tools は、タスク仕様・過去レポート・ファイル構成の確認にのみ使用してよい',
        '- ファイルを編集しない',
        '- コマンドを実行しない',
        '- 実装しない',
      ]
    : [
        '- You may use read-only inspection tools only to inspect the task spec, prior reports, and file layout',
        '- Do not edit files',
        '- Do not run commands',
        '- Do not execute the implementation',
      ];

  if (!options.requireAtLeastOnePart) {
    return guidance;
  }

  return language === 'ja'
    ? [
        ...guidance,
        '- 作業を分割しない場合も、元タスクを引き継ぐ少なくとも1つの part を返す',
      ]
    : [
        ...guidance,
        '- Return at least one part. If the work should not be split, return one part carrying the original task forward',
      ];
}

function buildDecomposeBasePrompt(
  instruction: string,
  maxTotalParts: number,
  language?: Language,
  inspectTools?: readonly string[],
): string {
  if (language === 'ja') {
    return [
      '以下はタスク分解専用の指示です。タスクを実行せず、分解だけを行ってください。',
      ...buildInspectToolGuidance(language, inspectTools, { requireAtLeastOnePart: true }),
      `- 返してよい総 parts 数は 1 以上 ${maxTotalParts} 以下`,
      '- この上限は同時実行数ではない',
      '- 上限内で、同じバッチ内の part は互いに独立させる',
      '- まず並行可能な責務境界を探す',
      '- 「実装と検証」のような巨大な単一 part を避ける',
      '- 検証が必要なら、実装結果がそろった後の後続 batch で追加する',
      '- npm test / npm run test:e2e:mock を各実装 part に重複して持たせない',
      '- 共有契約が必要な作業は、依存 part に分けず1つの part にまとめる',
      '- parts.length === 1 になる場合も、独立に実行できる責務境界がないか先に検討する',
      '',
      '## 元タスク',
      instruction,
    ].join('\n');
  }

  return [
    'This is decomposition-only planning. Do not execute the task.',
    ...buildInspectToolGuidance(language, inspectTools, { requireAtLeastOnePart: true }),
    `- Produce a total number of parts between 1 and ${maxTotalParts}`,
    '- This limit is not a concurrency limit',
    '- Within this limit, keep parts in the same batch independently executable',
    '- Keep each part self-contained',
    '- First look for parallelizable responsibility boundaries',
    '- Avoid oversized single parts such as "implementation and verification"',
    '- Every part in the same batch must be independently executable',
    '- Add verification only in a later batch after the implementation results are complete',
    '- Do not duplicate npm test / npm run test:e2e:mock in each implementation part',
    '- Keep work with shared contracts in one part instead of creating dependent parts',
    '- When parts.length === 1, first consider whether independent responsibility boundaries are available',
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
    result.content,
  ].join('\n')).join('\n\n');

  if (language === 'ja') {
    return [
      '以下の実行結果を見て、追加のサブタスクが必要か判断してください。',
      ...buildInspectToolGuidance(language, undefined, { requireAtLeastOnePart: false }),
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
      '- 既存差分を破壊しない',
      '- 未完了作業だけを追加 part に切り出す',
      '- 同じバッチ内の part は互いに依存させない',
      '- 実装結果がそろった後にのみ、後続 batch で検証 part を追加する',
      `- 既存IDは再利用しない: ${existingIds.join(', ') || '(なし)'}`,
      `- 追加できる最大数: ${maxAdditionalParts}`,
    ].join('\n');
  }

  return [
    'Review completed part results and decide whether additional parts are needed.',
    ...buildInspectToolGuidance(language, undefined, { requireAtLeastOnePart: false }),
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
    '- Preserve existing changes',
    '- Put only unfinished work into additional parts',
    '- Do not create parts that depend on another unfinished part',
    '- Add a verification part only after its implementation results are complete',
    `- Do not reuse existing IDs: ${existingIds.join(', ') || '(none)'}`,
    `- Maximum additional parts: ${maxAdditionalParts}`,
  ].join('\n');
}

export function buildDecomposePrompt(
  instruction: string,
  maxTotalParts: number,
  language?: Language,
  inspectTools?: readonly string[],
): string {
  return buildDecomposeBasePrompt(instruction, maxTotalParts, language, inspectTools);
}

export function buildPromptBasedDecomposePrompt(
  instruction: string,
  maxTotalParts: number,
  language?: Language,
  inspectTools?: readonly string[],
): string {
  const outputInstruction = language === 'ja'
    ? [
        '',
        '出力形式:',
        '- ```json ... ``` ブロックのみを返す',
        '- JSON は配列にする',
        '- 各要素は {"id","title","instruction"} を持つ',
      ]
    : [
        '',
        'Output format:',
        '- Return only one ```json ... ``` block',
        '- The JSON must be an array',
        '- Each item must include {"id","title","instruction"}',
      ];

  return `${buildDecomposeBasePrompt(
    instruction,
    maxTotalParts,
    language,
    inspectTools,
  )}\n${outputInstruction.join('\n')}`;
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
