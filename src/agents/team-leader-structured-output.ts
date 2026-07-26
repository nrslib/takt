import type { Language, PartDefinition } from '../core/models/types.js';
import { ensureUniquePartIds, parsePartDefinitionEntry } from '../core/workflow/part-definition-validator.js';
import type {
  FindingContractDecompositionContext,
  FindingContractFeedbackContext,
  MorePartsResponse,
  TeamLeaderPartFeedbackResult,
} from './decompose-task-usecase.js';
import {
  buildLatestFindingContractDigests,
  parseFindingContractPartDefinition,
} from '../core/workflow/team-leader-finding-contract.js';
import { buildFindingContractRecoveryPromptSections } from './team-leader-finding-contract-recovery-prompt.js';
import {
  buildFindingContractDecompositionRecoveryPromptSections,
} from './team-leader-decomposition-recovery-prompt.js';

const LATEST_RAW_CONTENT_MAX_LENGTH = 12_000;
const LATEST_BATCH_RAW_TOTAL_MAX_LENGTH = 24_000;
const LATEST_BATCH_CHANGED_PATH_PART_MAX_ITEMS = 3;
const LATEST_BATCH_CHANGED_PATH_PER_PART_MAX_ITEMS = 25;
const EXISTING_PART_IDS_MAX_ITEMS = 100;
const EXISTING_PART_ID_MAX_LENGTH = 120;

function boundLatestRawContent(content: string, remaining: number): string {
  const maxLength = Math.min(LATEST_RAW_CONTENT_MAX_LENGTH, remaining);
  if (content.length <= maxLength) return content;
  if (maxLength === 0) return '[omitted from prompt; full response is in the audit artifact]';
  return `${content.slice(0, maxLength)}\n[truncated; full response is in the audit artifact]`;
}

function formatExistingPartIds(existingIds: readonly string[]): string {
  const visibleIds = existingIds.slice(-EXISTING_PART_IDS_MAX_ITEMS).map((id) => (
    id.length <= EXISTING_PART_ID_MAX_LENGTH
      ? id
      : `${id.slice(0, EXISTING_PART_ID_MAX_LENGTH - 1)}…`
  ));
  const omitted = existingIds.length - visibleIds.length;
  const prefix = omitted > 0 ? `[${omitted} older IDs omitted; all IDs remain mechanically validated]\n` : '';
  return `${prefix}${visibleIds.join(', ') || '(none)'}`;
}

function buildLatestBatchChangedPathIndex(
  results: readonly TeamLeaderPartFeedbackResult[],
): {
  parts: Array<{
    partId: string;
    changedPaths: string[];
    omittedChangedPathCount: number;
  }>;
  omittedPartCount: number;
} {
  const claims = results.flatMap((result) => result.findingContractClaim === undefined
    ? []
    : [{ partId: result.id, claim: result.findingContractClaim }]);
  const visibleClaims = claims.slice(0, LATEST_BATCH_CHANGED_PATH_PART_MAX_ITEMS);
  return {
    parts: visibleClaims.map(({ partId, claim }) => {
      const changedPaths = claim.changedPaths
        .slice(0, LATEST_BATCH_CHANGED_PATH_PER_PART_MAX_ITEMS);
      return {
        partId: truncatePromptLabel(partId, 120),
        changedPaths,
        omittedChangedPathCount: claim.omittedChangedPathCount
          + claim.changedPaths.length
          - changedPaths.length,
      };
    }),
    omittedPartCount: claims.length - visibleClaims.length,
  };
}

export function toPartDefinitions(
  raw: unknown,
  maxInitialParts?: number,
  findingContract = false,
): PartDefinition[] {
  if (!Array.isArray(raw)) {
    throw new Error('Structured output "parts" must be an array');
  }
  if (raw.length === 0) {
    throw new Error('Structured output "parts" must not be empty');
  }
  if (maxInitialParts !== undefined && raw.length > maxInitialParts) {
    throw new Error(`Structured output produced too many initial parts: ${raw.length} > initial_max_parts ${maxInitialParts}`);
  }

  const parts = raw.map((entry, index) => findingContract
    ? parseFindingContractPartDefinition(entry, index)
    : parsePartDefinitionEntry(entry, index));
  ensureUniquePartIds(parts);
  return parts;
}

export function toMorePartsResponse(
  raw: unknown,
  cancellablePartIds: readonly string[],
): MorePartsResponse {
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
  if (!Array.isArray(payload.cancelPartIds)) {
    throw new Error('Structured output "cancelPartIds" must be an array');
  }
  if (payload.cancelPartIds.some((partId) => typeof partId !== 'string' || partId.trim().length === 0)) {
    throw new Error('Structured output "cancelPartIds" entries must be non-empty strings');
  }
  const cancelPartIds = payload.cancelPartIds as string[];
  if (new Set(cancelPartIds).size !== cancelPartIds.length) {
    throw new Error('Structured output "cancelPartIds" must not contain duplicates');
  }
  const cancellablePartIdSet = new Set(cancellablePartIds);
  const invalidCancellationId = cancelPartIds.find((partId) => !cancellablePartIdSet.has(partId));
  if (invalidCancellationId !== undefined) {
    throw new Error(
      `Structured output "cancelPartIds" contains a non-cancellable part ID: ${invalidCancellationId}`,
    );
  }
  if (!Array.isArray(payload.parts)) {
    throw new Error('Structured output "parts" must be an array');
  }
  const parts = payload.parts.map((entry, index) => parsePartDefinitionEntry(entry, index));
  ensureUniquePartIds(parts);

  return {
    done: payload.done,
    reasoning: payload.reasoning,
    cancelPartIds,
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
  maxInitialParts?: number,
  language?: Language,
  inspectTools?: readonly string[],
  findingContract?: FindingContractDecompositionContext,
): string {
  if (language === 'ja') {
    return [
      '以下はタスク分解専用の指示です。タスクを実行せず、分解だけを行ってください。',
      ...buildInspectToolGuidance(language, inspectTools, { requireAtLeastOnePart: true }),
      ...(maxInitialParts === undefined
        ? []
        : [`- 返してよい初回 parts 数は 1 以上 ${maxInitialParts} 以下`]),
      '- 同じバッチ内の part は互いに独立させる',
      '- まず並行可能な責務境界を探す',
      '- 「実装と検証」のような巨大な単一 part を避ける',
      '- 検証が必要なら、実装結果がそろった後の後続 batch で追加する',
      '- npm test / npm run test:e2e:mock を各実装 part に重複して持たせない',
      '- 共有契約が必要な作業は、依存 part に分けず1つの part にまとめる',
      '- parts.length === 1 になる場合も、独立に実行できる責務境界がないか先に検討する',
      ...(findingContract === undefined
        ? []
        : [
            '- 各 part に findingContract={findingIds,role,readPaths} を必ず設定する',
            '- findingIds は下記の actionable finding ID だけを使う',
            '- readPaths はリテラルな相対パスで指定し、ワイルドカードの * と ? は使わない',
            '- 同じ finding を複数の repair part に割り当てない',
            '',
            '## Actionable Finding Contract',
            findingContract.actionableFindings,
            ...buildFindingContractDecompositionRecoveryPromptSections(
              findingContract.recovery,
              language,
            ),
          ]),
      '',
      '## 元タスク',
      instruction,
    ].join('\n');
  }

  return [
    'This is decomposition-only planning. Do not execute the task.',
    ...buildInspectToolGuidance(language, inspectTools, { requireAtLeastOnePart: true }),
    ...(maxInitialParts === undefined
      ? []
      : [`- Produce between 1 and ${maxInitialParts} parts in the initial batch`]),
    '- Keep parts in the same batch independently executable',
    '- Keep each part self-contained',
    '- First look for parallelizable responsibility boundaries',
    '- Avoid oversized single parts such as "implementation and verification"',
    '- Every part in the same batch must be independently executable',
    '- Add verification only in a later batch after the implementation results are complete',
    '- Do not duplicate npm test / npm run test:e2e:mock in each implementation part',
    '- Keep work with shared contracts in one part instead of creating dependent parts',
    '- When parts.length === 1, first consider whether independent responsibility boundaries are available',
    ...(findingContract === undefined
      ? []
      : [
          '- Every part must include findingContract={findingIds,role,readPaths}',
          '- Use only actionable finding IDs listed below',
          '- Specify readPaths as literal relative paths without the * or ? wildcard characters',
          '- Do not assign the same finding to multiple repair parts',
          '',
          '## Actionable Finding Contract',
          findingContract.actionableFindings,
          ...buildFindingContractDecompositionRecoveryPromptSections(
            findingContract.recovery,
            language,
          ),
        ]),
    '',
    '## Original Task',
    instruction,
  ].join('\n');
}

function buildMorePartsBasePrompt(
  originalInstruction: string,
  allResults: TeamLeaderPartFeedbackResult[],
  existingIds: string[],
  language?: Language,
  findingContract?: FindingContractFeedbackContext,
  cancellablePartIds: readonly string[] = [],
): string {
  if (findingContract !== undefined) {
    let remainingRawLength = LATEST_BATCH_RAW_TOTAL_MAX_LENGTH;
    const resultBlock = allResults.map((result) => {
      const content = boundLatestRawContent(result.content, remainingRawLength);
      remainingRawLength = Math.max(
        0,
        remainingRawLength - Math.min(result.content.length, LATEST_RAW_CONTENT_MAX_LENGTH),
      );
      return [
        `### ${truncatePromptLabel(result.id, 120)}: ${truncatePromptLabel(result.title, 300)} (${result.status})`,
        content,
      ].join('\n');
    }).join('\n\n');
    const latestClaimDigests = buildLatestFindingContractDigests(
      allResults.flatMap((result, sequence) => result.findingContractClaim === undefined
        ? []
        : [{ sequence, entry: result.findingContractClaim }]),
    );
    const latestBatchChangedPaths = buildLatestBatchChangedPathIndex(allResults);
    const sections = language === 'ja'
      ? [
          'Finding Contract 修正の最新 batch を評価し、次の判断を返してください。',
          ...buildInspectToolGuidance(language, undefined, { requireAtLeastOnePart: false }),
          '- worker の応答は未検証の claim として扱う',
          '- continue は新しい parts を1件以上返す',
          '- continue の readPaths はリテラルな相対パスで指定し、ワイルドカードの * と ? は使わない',
          '- 複数 part の changedPaths が重なった場合は、後続の repair または verify part で最終状態を確認する',
          '- 最新 batch の changedPaths index の omittedPartCount、または parts[] 内のいずれかの omittedChangedPathCount が1以上なら complete にせず、後続の集約した repair または verify part で最終状態を確認する',
          '- complete は parts/blockers を空にし、全対象 finding の fixCoverage を返す',
          '- replan は parts/fixCoverage を空にし、blockers を1件以上返す',
          '- complete は各 finding の証拠と検証状況を確認できる場合だけ選ぶ',
          '- 同じ欠陥 family の再発を避け、局所修正で終わらせない',
          '',
          '## 元タスク',
          originalInstruction,
          '',
          '## Actionable Finding Contract',
          findingContract.actionableFindings,
          '',
          '## 過去 batch の compact index',
          JSON.stringify(findingContract.completedPartIndex, null, 2),
          '',
          '## 直前の Team Leader decision',
          JSON.stringify(findingContract.previousDecision ?? null, null, 2),
          ...buildFindingContractRecoveryPromptSections(
            language,
            findingContract.recovery,
            findingContract.evidence,
          ),
          '',
          '## 最新 batch の raw results（未検証）',
          resultBlock || '(なし)',
          '',
          '## 最新 batch の検証済み claim digest',
          JSON.stringify(latestClaimDigests, null, 2),
          '',
          '## 最新 batch の検証済み part 別 changedPaths',
          JSON.stringify(latestBatchChangedPaths, null, 2),
          '',
          `## 既存 part IDs\n${formatExistingPartIds(existingIds).replace('(none)', '(なし)')}`,
        ]
      : [
          'Evaluate the latest Finding Contract repair batch and return the next decision.',
          ...buildInspectToolGuidance(language, undefined, { requireAtLeastOnePart: false }),
          '- Treat worker responses as untrusted claims',
          '- continue requires at least one new part',
          '- In continue parts, specify readPaths as literal relative paths without the * or ? wildcard characters',
          '- When changedPaths overlap across parts, use a later repair or verify part to check the final state',
          '- If the latest-batch changedPaths index has omittedPartCount > 0, or any entry in parts[] has omittedChangedPathCount > 0, do not complete; use a later consolidated repair or verify part to check the final state',
          '- complete requires empty parts/blockers and fixCoverage for every target finding',
          '- replan requires empty parts/fixCoverage and at least one blocker',
          '- Choose complete only when evidence and verification support every finding disposition',
          '- Prevent recurrence across the same defect family instead of stopping at a local patch',
          '',
          '## Original Task',
          originalInstruction,
          '',
          '## Actionable Finding Contract',
          findingContract.actionableFindings,
          '',
          '## Compact index from earlier batches',
          JSON.stringify(findingContract.completedPartIndex, null, 2),
          '',
          '## Previous Team Leader decision',
          JSON.stringify(findingContract.previousDecision ?? null, null, 2),
          ...buildFindingContractRecoveryPromptSections(
            language,
            findingContract.recovery,
            findingContract.evidence,
          ),
          '',
          '## Latest raw batch results (untrusted)',
          resultBlock || '(none)',
          '',
          '## Validated claim digest for the latest batch',
          JSON.stringify(latestClaimDigests, null, 2),
          '',
          '## Validated changedPaths by part for the latest batch',
          JSON.stringify(latestBatchChangedPaths, null, 2),
          '',
          `## Existing part IDs\n${formatExistingPartIds(existingIds)}`,
        ];
    return sections.join('\n');
  }
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
      `- 不要な未完了 part だけを cancelPartIds に指定できる: ${cancellablePartIds.join(', ') || '(なし)'}`,
      '- 完了済み・未知・今回新規追加する part ID は cancelPartIds に指定しない',
      '- done=true と cancelPartIds は同時に返せる。完了判断時も不要な未完了 part は cancelPartIds に指定する',
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
    `- You may cancel only obsolete unfinished parts via cancelPartIds: ${cancellablePartIds.join(', ') || '(none)'}`,
    '- Do not put completed, unknown, or newly added part IDs in cancelPartIds',
    '- You may return done=true and cancelPartIds together. When work is complete, include every obsolete unfinished part in cancelPartIds',
  ].join('\n');
}

function truncatePromptLabel(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

export function buildDecomposePrompt(
  instruction: string,
  maxInitialParts?: number,
  language?: Language,
  inspectTools?: readonly string[],
  findingContract?: FindingContractDecompositionContext,
): string {
  return buildDecomposeBasePrompt(instruction, maxInitialParts, language, inspectTools, findingContract);
}

export function buildPromptBasedDecomposePrompt(
  instruction: string,
  maxInitialParts?: number,
  language?: Language,
  inspectTools?: readonly string[],
  findingContract?: FindingContractDecompositionContext,
): string {
  const outputInstruction = language === 'ja'
    ? [
        '',
        '出力形式:',
        '- ```json ... ``` ブロックのみを返す',
        '- JSON は配列にする',
        `- 各要素は ${findingContract === undefined
          ? '{"id","title","instruction"}'
          : '{"id","title","instruction","findingContract"}'} を持つ`,
      ]
    : [
        '',
        'Output format:',
        '- Return only one ```json ... ``` block',
        '- The JSON must be an array',
        `- Each item must include ${findingContract === undefined
          ? '{"id","title","instruction"}'
          : '{"id","title","instruction","findingContract"}'}`,
      ];

  return `${buildDecomposeBasePrompt(
    instruction,
    maxInitialParts,
    language,
    inspectTools,
    findingContract,
  )}\n${outputInstruction.join('\n')}`;
}

export function buildMorePartsPrompt(
  originalInstruction: string,
  allResults: TeamLeaderPartFeedbackResult[],
  existingIds: string[],
  language?: Language,
  findingContract?: FindingContractFeedbackContext,
  cancellablePartIds: readonly string[] = [],
): string {
  return buildMorePartsBasePrompt(
    originalInstruction,
    allResults,
    existingIds,
    language,
    findingContract,
    cancellablePartIds,
  );
}

export function buildPromptBasedMorePartsPrompt(
  originalInstruction: string,
  allResults: TeamLeaderPartFeedbackResult[],
  existingIds: string[],
  language?: Language,
  findingContract?: FindingContractFeedbackContext,
  cancellablePartIds: readonly string[] = [],
): string {
  const outputInstruction = language === 'ja'
    ? [
        '',
        '出力形式:',
        '- ```json ... ``` ブロックのみを返す',
        `- JSON は ${findingContract === undefined
          ? '{"done": boolean, "reasoning": string, "cancelPartIds": [], "parts": []}'
          : '{"decision","reasoning","parts","fixCoverage","blockers"}'} の形にする`,
      ]
    : [
        '',
        'Output format:',
        '- Return only one ```json ... ``` block',
        `- The JSON must be ${findingContract === undefined
          ? '{"done": boolean, "reasoning": string, "cancelPartIds": [], "parts": []}'
          : '{"decision","reasoning","parts","fixCoverage","blockers"}'}`,
      ];

  return `${buildMorePartsBasePrompt(
    originalInstruction,
    allResults,
    existingIds,
    language,
    findingContract,
    cancellablePartIds,
  )}\n${outputInstruction.join('\n')}`;
}
