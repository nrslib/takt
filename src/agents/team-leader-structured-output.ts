import type { Language, PartDefinition } from '../core/models/types.js';
import { ensureUniquePartIds, parsePartDefinitionEntry } from '../core/workflow/part-definition-validator.js';
import type { MorePartsResponse } from './decompose-task-usecase.js';

function summarizePartContent(content: string): string {
  const maxLength = 2000;
  if (content.length <= maxLength) {
    return content;
  }

  return `${content.slice(0, maxLength)}\n...[truncated]`;
}

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
      '- 上限遵守を、検証分離や責務分解より優先する',
      '- パートは互いに独立させる',
      '- まず並行可能な責務境界を探す',
      '- 「実装と検証」のような巨大な単一 part を避ける',
      '- 実装 part と検証 part を分ける',
      '- 重い Quality Gates は最終の検証 part に寄せる',
      '- npm test / npm run test:e2e:mock を各実装 part に重複して持たせない',
      '- 共有契約が必要なら、基盤 part から消費 part へ段階化する',
      '- parts.length === 1 になる場合も、検証分離や段階分けができないか先に検討する',
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
    '- Respecting this limit takes precedence over verification separation or responsibility boundaries',
    '- Keep each part self-contained',
    '- First look for parallelizable responsibility boundaries',
    '- Avoid oversized single parts such as "implementation and verification"',
    '- Separate implementation parts from verification parts',
    '- Put heavy Quality Gates in a final verification part',
    '- Do not duplicate npm test / npm run test:e2e:mock in each implementation part',
    '- When shared contracts are needed, stage foundation parts before consuming parts',
    '- When parts.length === 1, first consider whether verification separation or staged work is possible',
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
      '- 実装継続と検証 part を分け、重い検証を実装 part に重複して持たせない',
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
    '- Separate implementation continuations from a verification part',
    '- Do not duplicate heavy verification in implementation continuations',
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
