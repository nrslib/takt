/**
 * relation/target の意味矛盾をレビュアへ1回だけ突き返す。
 *
 * reviewer structured output のうち relation/target の意味矛盾がある raw
 * について、同一 reviewer session へ1回だけ明確化を求める。対象は 'new' 衝突
 * だけでなく、detectRawFindingAmbiguities（raw-canonicalization.ts と共有する
 * 唯一の検出実装）が返す全 ambiguity のうち、relation / targetFindingId の
 * 付け替えだけで直せる見込みのあるもの。
 *
 * 厳守事項:
 * - correction では raw 集合・本文・severity 等の変更を禁止する
 *   （findRegenerationContractViolation が決定的に検証し、違反は訂正全体を不採用）。
 * - correction 後も ambiguity-origin taint は保持する。訂正結果は manager の
 *   解釈材料には使えるが、既存 finding を閉じる権限の根拠にはならない —
 *   呼び出し元は返り値の clarification（engine が作るメタデータ。LLM 出力からは
 *   受け取らない）を intake（manager-runner.ts）へ渡し、canonicalization が
 *   priorAmbiguityCodes として taint を復元する。
 * - 失敗時（呼び出し失敗・契約違反・出力超過）は元 raw を drop せず、元の
 *   応答のまま manager 段へ渡す。correction は reviewer あたり1回のみ。
 */

import { executeAgent } from '../../../agents/agent-usecases.js';
import type { RunAgentOptions } from '../../../agents/runner.js';
import type { AgentResponse } from '../../models/types.js';
import { createLogger } from '../../../shared/utils/index.js';
import {
  detectRawFindingAmbiguities,
  extractLenientRawFields,
} from './raw-canonicalization.js';
import { RAW_FINDING_LIMITS, estimateTokens } from './raw-finding-limits.js';
import type { FindingLedger, RawAmbiguityCode } from './types.js';

const log = createLogger('finding-relation-coherence');

/**
 * relation/target の付け替えだけで解消し得る ambiguity。missing-required-field
 * は本文の追加（= 禁止された内容変更）が必要なため突き返し対象にしない —
 * そのまま ambiguous ladder（manager 解釈 / provisional）へ進む。
 */
const CLARIFIABLE_AMBIGUITY_CODES: ReadonlySet<RawAmbiguityCode> = new Set([
  'relation-target-mismatch',
  'persists-target-unknown',
  'persists-target-not-open',
  'reopened-target-open',
  'reopened-target-unknown',
  'confirmation-target-unknown',
  'confirmation-target-not-open',
  'new-collides-open-finding',
]);

export interface AmbiguousRawMismatch {
  rawFindingId: string;
  title?: string;
  location?: string;
  codes: RawAmbiguityCode[];
  targetFindingId?: string;
  collidingFindingId?: string;
  collidingFindingTitle?: string;
}

/**
 * 突き返し（correction）の実施記録。エンジンが作る engine-to-engine メタデータで、
 * LLM の出力フィールドからは決して受け取らない。intake はこれを使って
 * 「correction で形式が整った raw」にも taint（priorAmbiguityCodes）を復元する。
 */
export interface ReviewerRelationClarification {
  attempted: true;
  /** reviewer ローカルの rawFindingId（intake の名前空間化前）。 */
  flaggedRawFindingIds: string[];
  priorAmbiguityCodesByRawId: Record<string, RawAmbiguityCode[]>;
}

/**
 * 未検証の reviewer rawFindings 配列から、突き返しで直せる見込みのある意味矛盾を
 * 検出する。detection は raw-canonicalization.ts の唯一の実装へ委譲する。
 */
export function detectClarifiableRawMismatches(
  items: readonly unknown[],
  ledger: FindingLedger,
): AmbiguousRawMismatch[] {
  // 同一 ID が複数回現れる場合、その ID では項目を一意に相関できない
  // （訂正指示・regenerated 照合・intake の priorAmbiguityCodesByRawId 参照が
  // すべて素の ID キー）。intake 側は2回目以降を決定的サフィックスで別 ID に
  // するため、素の ID で束ねると別項目へ誤適用する。重複 ID は clarification
  // 対象から外し、そのまま ladder へ進める。
  const idCounts = new Map<string, number>();
  for (const item of items) {
    const rawFindingId = extractLenientRawFields(item).rawFindingId;
    if (rawFindingId !== undefined) {
      idCounts.set(rawFindingId, (idCounts.get(rawFindingId) ?? 0) + 1);
    }
  }
  const mismatches: AmbiguousRawMismatch[] = [];
  for (const item of items) {
    const fields = extractLenientRawFields(item);
    if (fields.rawFindingId === undefined) {
      // id の無い raw は訂正指示で参照できない。そのまま ladder へ。
      continue;
    }
    if ((idCounts.get(fields.rawFindingId) ?? 0) > 1) {
      continue;
    }
    const detection = detectRawFindingAmbiguities(fields, ledger);
    const clarifiable = detection.codes.filter((code) => CLARIFIABLE_AMBIGUITY_CODES.has(code));
    if (clarifiable.length === 0) {
      continue;
    }
    mismatches.push({
      rawFindingId: fields.rawFindingId,
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.location !== undefined ? { location: fields.location } : {}),
      codes: clarifiable,
      ...(fields.targetFindingId !== undefined ? { targetFindingId: fields.targetFindingId } : {}),
      ...(detection.collidingFindingId !== undefined ? { collidingFindingId: detection.collidingFindingId } : {}),
      ...(detection.collidingFindingTitle !== undefined ? { collidingFindingTitle: detection.collidingFindingTitle } : {}),
    });
  }
  return mismatches;
}

function describeMismatch(mismatch: AmbiguousRawMismatch): string {
  const parts: string[] = [];
  for (const code of mismatch.codes) {
    switch (code) {
      case 'relation-target-mismatch':
        parts.push('relation and targetFindingId contradict each other ("new" must have no target; every other relation requires one)');
        break;
      case 'persists-target-unknown':
        parts.push(`relation "persists" references target "${mismatch.targetFindingId ?? '?'}" which does not exist in the ledger`);
        break;
      case 'persists-target-not-open':
        parts.push(`relation "persists" references target "${mismatch.targetFindingId ?? '?'}" which is not open (if it reappeared after being resolved, use "reopened")`);
        break;
      case 'reopened-target-open':
        parts.push(`relation "reopened" references target "${mismatch.targetFindingId ?? '?'}" which is still open (if it simply still exists, use "persists")`);
        break;
      case 'reopened-target-unknown':
        parts.push(`relation "reopened" references target "${mismatch.targetFindingId ?? '?'}" which does not exist in the ledger`);
        break;
      case 'confirmation-target-unknown':
        parts.push(`relation "resolution_confirmation" references target "${mismatch.targetFindingId ?? '?'}" which does not exist in the ledger`);
        break;
      case 'confirmation-target-not-open':
        parts.push(`relation "resolution_confirmation" references target "${mismatch.targetFindingId ?? '?'}" which is not open`);
        break;
      case 'new-collides-open-finding':
        parts.push(`relation "new" but its normalized path and title match open finding ${mismatch.collidingFindingId ?? '?'} ("${mismatch.collidingFindingTitle ?? ''}"); use "persists"/"reopened" with that targetFindingId if it is the same issue, or keep "new" ONLY if it is genuinely a different problem`);
        break;
      case 'missing-required-field':
        break;
    }
  }
  return parts.join('; ');
}

/**
 * 1回だけの明確化指示。全 raw findings を含む構造化出力全体の再出力を求める
 * （部分再出力だと2つの配列のマージが必要になり、「最終結果を自力で組み立てる」
 * 失敗様式へ逆戻りする）。変更してよいのは指摘した raw の relation /
 * targetFindingId だけであることを明示する。
 */
export function buildRelationCoherenceRegenerationInstruction(
  mismatches: readonly AmbiguousRawMismatch[],
): string {
  const mismatchBlock = mismatches.map((mismatch) => [
    `- rawFindingId "${mismatch.rawFindingId}"${mismatch.title !== undefined ? ` ("${mismatch.title}"${mismatch.location !== undefined ? `, ${mismatch.location}` : ''})` : ''}`,
    `  problem: ${describeMismatch(mismatch)}`,
  ].join('\n'));
  return [
    'Some of your raw findings have contradictory relation/targetFindingId labeling against the current finding ledger:',
    ...mismatchBlock,
    '',
    'Fix ONLY the relation and targetFindingId fields of the raw findings listed above. Do NOT change any other field (title, description, severity, suggestion, familyTag, location), do NOT add or remove raw findings, and do NOT touch raw findings that are not listed.',
    'Re-emit ONLY the corrected structured output matching the schema, including ALL raw findings from your previous output (corrected where needed). Do not repeat the report text. Do not add commentary.',
  ].join('\n');
}

export interface ClarifyAmbiguousRawRelationsInput {
  stepName: string;
  persona: string | undefined;
  /** The reviewer's Phase 1 response with structured output (status 'done'). */
  response: AgentResponse;
  ledger: FindingLedger;
  /** The runner's Phase 1 agent options; tool permissions are narrowed here (readonly, no tools) since the re-query only re-emits JSON. */
  agentOptions: RunAgentOptions;
  normalize: (response: AgentResponse) => { response: AgentResponse; invalidDetail?: string };
}

export interface ClarifyAmbiguousRawRelationsResult {
  response: AgentResponse;
  /** 意味矛盾が1件でも検出された場合に付く。correction の成否に関わらず taint の根拠。 */
  clarification?: ReviewerRelationClarification;
}

/**
 * 同一 reviewer session へ1回だけ relation/target の明確化を求める。
 *
 * ステップを失敗させることは決して無い: 呼び出し失敗・出力不正・契約違反・
 * 出力超過のときは元の応答をそのまま返す（drop しない — v2 ではその raw は
 * ambiguous のまま manager 解釈 / provisional へ進む）。
 */
export async function clarifyAmbiguousRawRelationsOnce(
  input: ClarifyAmbiguousRawRelationsInput,
): Promise<ClarifyAmbiguousRawRelationsResult> {
  if (input.response.status !== 'done') {
    return { response: input.response };
  }
  const rawItems = input.response.structuredOutput?.rawFindings;
  if (!Array.isArray(rawItems)) {
    return { response: input.response };
  }
  const mismatches = detectClarifiableRawMismatches(rawItems, input.ledger);
  if (mismatches.length === 0) {
    return { response: input.response };
  }

  const clarification: ReviewerRelationClarification = {
    attempted: true,
    flaggedRawFindingIds: mismatches.map((mismatch) => mismatch.rawFindingId),
    priorAmbiguityCodesByRawId: Object.fromEntries(
      mismatches.map((mismatch) => [mismatch.rawFindingId, mismatch.codes]),
    ),
  };

  log.info('Raw findings have relation/target contradictions; requesting one clarification', {
    step: input.stepName,
    rawFindingIds: clarification.flaggedRawFindingIds,
  });
  const instruction = buildRelationCoherenceRegenerationInstruction(mismatches);
  let regenerated: AgentResponse;
  let renormalized: { response: AgentResponse; invalidDetail?: string };
  try {
    regenerated = await executeAgent(input.persona, instruction, {
      ...input.agentOptions,
      permissionMode: 'readonly',
      allowedTools: [],
      onPromptResolved: undefined,
      onStream: undefined,
      ...(input.response.sessionId !== undefined ? { sessionId: input.response.sessionId } : {}),
    });
    renormalized = input.normalize(regenerated);
  } catch (error) {
    log.warn('Relation clarification call failed; keeping the original raw findings', {
      step: input.stepName,
      error: error instanceof Error ? error.message : String(error),
    });
    return { response: input.response, clarification };
  }
  if (
    renormalized.invalidDetail !== undefined
    || renormalized.response.status !== 'done'
    || !Array.isArray(renormalized.response.structuredOutput?.rawFindings)
  ) {
    log.info('Relation clarification did not produce valid structured output; keeping the original raw findings', {
      step: input.stepName,
      detail: renormalized.invalidDetail ?? renormalized.response.error,
    });
    return { response: input.response, clarification };
  }
  // correction 出力の hard budget（2,048 output tokens 相当）。
  const outputTokens = estimateTokens(JSON.stringify(renormalized.response.structuredOutput ?? {}));
  if (outputTokens > RAW_FINDING_LIMITS.maxCorrectionOutputTokens) {
    log.warn('Relation clarification output exceeded the correction budget; keeping the original raw findings', {
      step: input.stepName,
      outputTokens,
    });
    return { response: input.response, clarification };
  }
  const regeneratedItems = renormalized.response.structuredOutput!.rawFindings as unknown[];
  const violation = findRegenerationContractViolation(rawItems, regeneratedItems, mismatches);
  if (violation !== undefined) {
    log.warn('Relation clarification violated the regeneration contract; keeping the original raw findings', {
      step: input.stepName,
      violation,
    });
    return { response: input.response, clarification };
  }
  return {
    response: {
      ...input.response,
      structuredOutput: renormalized.response.structuredOutput,
      ...(regenerated.sessionId !== undefined ? { sessionId: regenerated.sessionId } : {}),
    },
    clarification,
  };
}

/** Content identity for the regeneration contract. relation / targetFindingId は含めない（それらの付け替えが correction の目的）。 */
function rawContentKey(fields: ReturnType<typeof extractLenientRawFields>): string {
  return JSON.stringify([
    fields.title ?? '',
    fields.description ?? '',
    fields.location ?? '',
    fields.severity ?? '',
    fields.suggestion ?? '',
    fields.familyTag ?? '',
  ]);
}

/**
 * regeneration contract: reviewer は指摘された raw の relation /
 * targetFindingId だけを付け替えてよい。決定的に検証する:
 *
 * - rawFindingId の集合が元と完全一致（追加・削除・重複なし）
 * - 全 raw の内容（title/description/location/severity/suggestion/familyTag）不変
 * - 指摘されていない raw は relation / targetFindingId も不変
 *
 * 1件でも違反があれば訂正全体を不採用にし、元の出力を使う。
 */
export function findRegenerationContractViolation(
  original: readonly unknown[],
  regenerated: readonly unknown[],
  mismatches: readonly AmbiguousRawMismatch[],
): string | undefined {
  const flaggedIds = new Set(mismatches.map((mismatch) => mismatch.rawFindingId));
  const originalFields = original.map((item) => extractLenientRawFields(item));
  const originalById = new Map(
    originalFields
      .filter((fields) => fields.rawFindingId !== undefined)
      .map((fields) => [fields.rawFindingId!, fields]),
  );
  if (regenerated.length !== original.length) {
    return `raw finding count changed from ${original.length} to ${regenerated.length}`;
  }
  const seen = new Set<string>();
  for (const item of regenerated) {
    const fields = extractLenientRawFields(item);
    if (fields.rawFindingId === undefined) {
      return 'regenerated output contains a raw finding without rawFindingId';
    }
    if (seen.has(fields.rawFindingId)) {
      return `duplicate rawFindingId "${fields.rawFindingId}" in regenerated output`;
    }
    seen.add(fields.rawFindingId);
    const originalRaw = originalById.get(fields.rawFindingId);
    if (originalRaw === undefined) {
      return `regenerated output added rawFindingId "${fields.rawFindingId}"`;
    }
    if (rawContentKey(fields) !== rawContentKey(originalRaw)) {
      return `regenerated output changed the content of rawFindingId "${fields.rawFindingId}"`;
    }
    if (!flaggedIds.has(fields.rawFindingId)) {
      const relationChanged = fields.relation !== originalRaw.relation
        || fields.targetFindingId !== originalRaw.targetFindingId;
      if (relationChanged) {
        return `regenerated output changed relation/targetFindingId of non-flagged rawFindingId "${fields.rawFindingId}"`;
      }
    }
  }
  return undefined;
}
