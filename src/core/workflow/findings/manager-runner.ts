/**
 * Finding Contract の取り込み実行（v2 梯子設計・実装単位8）。
 *
 * v2 パイプライン:
 *
 * 1. reviewer structured output → envelope 検査（件数 / byte / フィールド長。
 *    超過 reviewer は全量を単一 overflow provisional に置換）→ 寛容な candidate
 *    parse → canonicalizeReviewerRawFinding（唯一の canonical 生成関数）。
 *    1件の不正 raw が配列全体の Zod parse 失敗として run を殺す経路は無い。
 * 2. clean（ambiguity origin 無し）の coherent raw: 従来どおり機械分類 +
 *    decisions manager。ただし semantic retry は 0 回 — 不採用・欠落・unsupported
 *    の decision は provisional へ着地する（強制 new 化・監査のみの drop は廃止）。
 * 3. tainted（ambiguity origin あり）の raw: ambiguous ladder。エンジンが
 *    決定的に処理できるもの（SameProof / 無衝突の additive new）はコードで確定し、
 *    残りは WAL + 予算つきの manager 解釈（提案のみ）→ capability 検証 → 適用。
 * 4. 保存: updateLedger の排他区間で最新台帳へ再照合し、全 confirmation（および
 *    reopen / invalidate / supersede）に CAS を適用。stale は conflict / provisional
 *    へ着地し、黙って消えない。provisional は stable key で upsert。
 *
 * LLM 呼び出しは updateLedger の排他区間の外で行う（store.ts の契約）。
 */

import { executeAgent } from '../../../agents/agent-usecases.js';
import type { AgentResponse, AgentWorkflowStep, FindingContractConfig, WorkflowConfig, WorkflowStep } from '../../models/types.js';
import {
  RawFindingsOutputJsonSchema,
  RawFindingsOutputValidationJsonSchema,
  parseAmbiguousInterpretations,
  parseFindingManagerDecisions,
} from './schemas.js';
import { buildFindingInterpretationStep, buildFindingManagerStep } from './manager-step.js';
import { applyProvisionalFindingSpecsToLedger, reconcileFindingLedger, type ProvisionalFindingSpec } from './reconciler.js';
import { classifyRawFindingsMechanically } from './mechanical-classification.js';
import {
  assembleManagerOutput,
  flattenManagerOutputToDecisions,
  type AssembleManagerOutputResult,
} from './decision-assembly.js';
import { classifyLocationAdmissionNormalization, validateLocationAdmission } from './admission-validation.js';
import type { ReviewerRelationClarification } from './relation-coherence.js';
import { normalizeFindingText, parseFindingLocation } from './location.js';
import {
  canonicalizeReviewerRawFinding,
  computeInterpretationKey,
  computeLineageKey,
  computeOverflowStableKey,
  computeProvisionalStableKey,
  computeReviewerStableKey,
  createOverflowRawCandidate,
  createReviewerRawFindingCandidates,
  detectRawFindingAmbiguities,
  extractLenientRawFields,
  toLedgerRawFinding,
  type ReviewerRawIntakeContext,
} from './raw-canonicalization.js';
import {
  MANAGER_INTERPRETATION_LIMITS,
  RAW_FINDING_LIMITS,
  checkReviewerEnvelope,
  estimateTokens,
  findRawFieldLimitViolation,
} from './raw-finding-limits.js';
import {
  issueDeterministicSameProofs,
  validateAmbiguousInterpretations,
  verifySameProofAgainstLedger,
} from './raw-capabilities.js';
import {
  captureFindingPreconditions,
  checkFindingPrecondition,
  type CapturedFindingPrecondition,
} from './finding-preconditions.js';
import {
  beginInterpretations,
  completeInterpretations,
  countInterpretationEpochs,
  markInterpretationsApplied,
  type NewInterpretationInput,
} from './interpretation-wal.js';
import type {
  FindingLedgerStore,
  FindingManagerValidationAttemptReport,
  InterpretationStatsReport,
  ProvisionalLandingReport,
  RawAdmissionRejectionReport,
  RawNormalizationAuditRecord,
  ReviewerOutputOverflowReport,
  UnsupportedRawFindingReport,
} from './store.js';
import type {
  AmbiguousInterpretation,
  CanonicalRawFinding,
  DeterministicSameProof,
  FindingLedger,
  FindingLedgerEntry,
  FindingManagerConflict,
  FindingManagerDecisions,
  FindingManagerOutput,
  FindingObservation,
  InterpretationApplicationResult,
  RawFinding,
} from './types.js';
import {
  hasDisputeClaimsHeading,
  validateFindingManagerOutput,
} from './manager-output-validation.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import type { StepProviderInfo } from '../types.js';
import { renderFencedJsonBlock } from '../instruction/fenced-json.js';
import { loadTemplate } from '../../../shared/prompts/index.js';
import { isWorkflowCallStep } from '../step-kind.js';
import { createLogger } from '../../../shared/utils/index.js';

const log = createLogger('finding-manager-runner');

export interface FindingManagerSubStepResult {
  subStep: WorkflowStep;
  response: AgentResponse;
  /**
   * レビュア1回突き返し（relation-coherence.ts）の実施記録。エンジンが作る
   * engine-to-engine メタデータ — correction で形式が整った raw にも taint
   * （priorAmbiguityCodes）を復元するために使う。LLM の出力からは受け取らない。
   */
  relationClarification?: ReviewerRelationClarification;
}

interface RunFindingManagerForStepInput {
  contract: FindingContractConfig;
  /**
   * Working directory the reviewed code lives in. Used for the deterministic
   * "raw admission validation": a raw finding's / existing finding's `location`
   * is only trusted if it resolves to a real file under this directory.
   */
  cwd: string;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  ledgerStore: FindingLedgerStore;
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput'>;
  parentStep: WorkflowStep;
  stepIteration: number;
  subResults: FindingManagerSubStepResult[];
  workflowName: string;
  runId: string;
  /** raw finding id 衝突対策の呼び出し名前空間。トップレベルでは空文字列。 */
  callNamespace: string;
  timestamp: string;
  ledgerCopyPath?: string;
  /** Response text of the step that ran before the reviewers (usually the coder's fix report, which may contain dispute claims). */
  priorStepResponseText?: string;
}

export const RAW_FINDINGS_SCHEMA_REF = 'takt.findings.raw.v1';
export { FINDING_MANAGER_SCHEMA_REF } from './manager-step.js';
export const RawFindingsStructuredOutput = {
  schemaRef: RAW_FINDINGS_SCHEMA_REF,
  /** provider-facing（strict 様式・kind 無し）。native structured output の生成拘束用。 */
  schema: RawFindingsOutputJsonSchema,
  /** post-hoc 検証用の寛容版（legacy kind を optional で受理）。provider へは渡さない。 */
  validationSchema: RawFindingsOutputValidationJsonSchema,
} as const;

/**
 * v2: run-level の invalid_manager_output は存在しない。manager の壊れた応答・
 * 予算超過・解釈不能はすべて provisional として台帳へ着地し、run は継続する
 * （final gate は provisional が閉じ続ける）。
 */
export type FindingManagerRunResult = {
  status: 'updated';
  ledgerPath: string;
  providerInfo: StepProviderInfo;
  ledger: FindingLedger;
};

// ---------------------------------------------------------------------------
// intake（candidate → canonical）
// ---------------------------------------------------------------------------

interface CanonicalIntakeItem {
  canonical: CanonicalRawFinding;
  wire: RawFinding;
}

interface ReviewerIntakeResult {
  items: CanonicalIntakeItem[];
  /** overflow event として作られた system canonical の rawFindingId。 */
  overflowRawFindingIds: Set<string>;
  overflowSpecs: ProvisionalFindingSpec[];
  overflowReports: ReviewerOutputOverflowReport[];
  clarifications: Array<{ reviewer: string; flaggedRawFindingIds: string[] }>;
  /**
   * canonicalization が主張を正規化した raw の監査記録（codex 2巡目ブロッカー
   * 対応）。元の relation / targetFindingId / ambiguity codes は wire の identity
   * 構成フィールドには載せない（B1/B2 の完全 identity 照合を壊さない）ため、
   * この専用メタデータだけが正規化前の主張を復元できる。
   */
  rawNormalizations: RawNormalizationAuditRecord[];
}

function intakeReviewerOutputs(input: {
  subResults: readonly FindingManagerSubStepResult[];
  previousLedger: FindingLedger;
  workflowName: string;
  callNamespace: string;
  parentStepName: string;
  stepIteration: number;
  runId: string;
}): ReviewerIntakeResult {
  const result: ReviewerIntakeResult = {
    items: [],
    overflowRawFindingIds: new Set(),
    overflowSpecs: [],
    overflowReports: [],
    clarifications: [],
    rawNormalizations: [],
  };
  let admittedCount = 0;
  let admittedBytes = 0;

  for (const subResult of input.subResults) {
    // workflow_call サブステップは raw findings を返さない（子ワークフロー側で
    // 取り込み済み）ため除外する。
    if (isWorkflowCallStep(subResult.subStep)) {
      continue;
    }
    const structuredOutput = subResult.response.structuredOutput;
    // raw findings は Finding Contract の契約入力。構造化出力自体の欠落は raw の
    // 意味矛盾ではなく provider / contract 障害なので従来どおり fail-fast する。
    if (structuredOutput === undefined) {
      throw new Error(
        `Finding contract reviewer "${subResult.subStep.name}" returned no structured output; raw findings are required`,
      );
    }
    if (!Array.isArray(structuredOutput.rawFindings)) {
      throw new Error(
        `Finding contract reviewer "${subResult.subStep.name}" returned structured output without a rawFindings array`,
      );
    }
    const items = structuredOutput.rawFindings as unknown[];
    const context: ReviewerRawIntakeContext = {
      workflowName: input.workflowName,
      callNamespace: input.callNamespace,
      parentStepName: input.parentStepName,
      stepIteration: input.stepIteration,
      runId: input.runId,
      reviewerStepName: subResult.subStep.name,
      reviewerPersonaKey: (subResult.subStep as { persona?: string }).persona ?? subResult.subStep.name,
    };
    if (subResult.relationClarification !== undefined) {
      result.clarifications.push({
        reviewer: subResult.subStep.name,
        flaggedRawFindingIds: subResult.relationClarification.flaggedRawFindingIds,
      });
    }

    // envelope 検査は Zod parse の前（設計書 §10: 65件目を読んだ時点で打ち切る）。
    const jsonBytes = Buffer.byteLength(JSON.stringify(items), 'utf-8');
    const envelopeViolation = checkReviewerEnvelope({ itemCount: items.length, jsonBytes });
    const fieldViolation = envelopeViolation === undefined
      ? items.map((item) => findRawFieldLimitViolation(extractLenientRawFields(item))).find((violation) => violation !== undefined)
      : undefined;
    const wouldExceedStep = envelopeViolation === undefined && fieldViolation === undefined
      && (admittedCount + items.length > RAW_FINDING_LIMITS.maxRawFindingsPerStep
        || admittedBytes + jsonBytes > RAW_FINDING_LIMITS.maxStepRawFindingsJsonBytes);
    const overflowReason = envelopeViolation?.reason
      ?? (fieldViolation !== undefined ? `a raw finding field exceeded its limit: ${fieldViolation}` : undefined)
      ?? (wouldExceedStep
        ? `admitting this reviewer's ${items.length} raw findings (${jsonBytes} bytes) would exceed the per-step limits (${RAW_FINDING_LIMITS.maxRawFindingsPerStep} findings / ${RAW_FINDING_LIMITS.maxStepRawFindingsJsonBytes} bytes)`
        : undefined);

    if (overflowReason !== undefined) {
      // 部分採用しない: この reviewer の全 raw を単一 overflow provisional に置換。
      const candidate = createOverflowRawCandidate({
        context,
        reason: `Reviewer "${subResult.subStep.name}" output exceeded Finding Contract limits: ${overflowReason}`,
      });
      const canonicalized = canonicalizeReviewerRawFinding(candidate, { ledger: input.previousLedger });
      const canonical = canonicalized.canonical;
      const wire = toLedgerRawFinding(canonical);
      result.items.push({ canonical, wire });
      result.overflowRawFindingIds.add(canonical.rawFindingId);
      result.overflowReports.push({ reviewer: subResult.subStep.name, reason: overflowReason });
      result.overflowSpecs.push({
        kind: 'reviewer-output-overflow',
        stableKey: computeOverflowStableKey(canonical.reviewerStableKey),
        lineageKey: canonical.lineageKey,
        sourceRawFindingIds: [canonical.rawFindingId],
        reason: wire.description,
        title: 'Reviewer output exceeded Finding Contract limits',
        severity: 'high',
        description: wire.description,
        reviewers: [subResult.subStep.name],
        addInterpretationEpochs: 0,
      });
      log.warn('Reviewer output exceeded Finding Contract limits; replaced with a single overflow provisional', {
        reviewer: subResult.subStep.name,
        reason: overflowReason,
      });
      continue;
    }

    admittedCount += items.length;
    admittedBytes += jsonBytes;
    const candidates = createReviewerRawFindingCandidates(items, context);
    const clarification = subResult.relationClarification;
    for (const candidate of candidates) {
      const priorCodes = clarification !== undefined && candidate.reviewerRawFindingId !== undefined
        ? clarification.priorAmbiguityCodesByRawId[candidate.reviewerRawFindingId]
        : undefined;
      const canonicalized = canonicalizeReviewerRawFinding(candidate, {
        ledger: input.previousLedger,
        ...(clarification !== undefined ? { clarificationAttempted: true } : {}),
        ...(priorCodes !== undefined ? { priorAmbiguityCodes: priorCodes } : {}),
      });
      const canonical = canonicalized.canonical;
      const wire = toLedgerRawFinding(canonical);
      result.items.push({ canonical, wire });

      // 正規化監査（変換が起きた raw のみ）: 元の主張は candidate 側にしか無く、
      // wire は identity を汚さないために正規化後の整合ペアだけを持つ。
      const normalizations: RawNormalizationAuditRecord['normalizations'] = [];
      if (candidate.relation !== canonical.relation) {
        normalizations.push('relation-normalized');
      }
      // A-2: location の機械正規化（行範囲解釈 / N/A → locationless）の適用事実。
      const locationNormalization = classifyLocationAdmissionNormalization(candidate.location);
      if (locationNormalization !== undefined) {
        normalizations.push(locationNormalization);
      }
      if (candidate.targetFindingId !== undefined && wire.targetFindingId === undefined) {
        normalizations.push('target-dropped-from-wire');
      }
      if (candidate.title === undefined || candidate.description === undefined
        || candidate.severity === undefined || candidate.familyTag === undefined) {
        normalizations.push('required-fields-missing');
      }
      if (normalizations.length > 0 || canonical.provenance.ambiguityCodes.length > 0) {
        result.rawNormalizations.push({
          rawFindingId: canonical.rawFindingId,
          reviewer: canonical.reviewer,
          ...(candidate.relation !== undefined ? { claimedRelation: candidate.relation } : {}),
          ...(candidate.targetFindingId !== undefined ? { claimedTargetFindingId: candidate.targetFindingId } : {}),
          ...(candidate.legacyKind !== undefined ? { claimedKind: candidate.legacyKind } : {}),
          normalizedRelation: canonical.relation,
          ...(wire.targetFindingId !== undefined ? { wireTargetFindingId: wire.targetFindingId } : {}),
          ambiguityCodes: [...canonical.provenance.ambiguityCodes],
          normalizations,
        });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// clean 経路（既存の機械分類 + decisions manager。semantic retry 0回）
// ---------------------------------------------------------------------------

function computeInvalidLocationCandidates(
  cwd: string,
  findings: readonly FindingLedgerEntry[],
): Map<string, string> {
  const candidates = new Map<string, string>();
  for (const finding of findings) {
    if (finding.status !== 'open' || finding.location === undefined) {
      continue;
    }
    // provisional は location の成立とは独立した「解釈不能観測」の blocker であり、
    // invalidate 候補にしない（decision-assembly 側でも拒否する二重防御）。
    if (finding.provisional !== undefined) {
      continue;
    }
    const result = validateLocationAdmission(cwd, finding.location);
    if (!result.ok) {
      candidates.set(finding.id, result.reason ?? 'invalid location');
    }
  }
  return candidates;
}

/**
 * manager へ渡す台帳ビュー（従来どおり）。解消済み・免除済みは照合キーだけの
 * スタブに落とし、open と参照対象だけ全文を載せる。
 */
function buildManagerInputLedger(ledger: FindingLedger, fullDetailFindingIds?: ReadonlySet<string>): unknown {
  const rawFindingsById = new Map(ledger.rawFindings.map((rawFinding) => [rawFinding.rawFindingId, rawFinding]));
  const needsFullDetail = (finding: FindingLedger['findings'][number]): boolean =>
    finding.status === 'open'
    || fullDetailFindingIds === undefined
    || fullDetailFindingIds.has(finding.id);
  return {
    version: ledger.version,
    workflowName: ledger.workflowName,
    nextId: ledger.nextId,
    updatedAt: ledger.updatedAt,
    findings: ledger.findings.map((finding) => (needsFullDetail(finding)
      ? {
        id: finding.id,
        status: finding.status,
        lifecycle: finding.lifecycle,
        severity: finding.severity,
        title: finding.title,
        location: finding.location,
        description: finding.description,
        suggestion: finding.suggestion,
        reviewers: finding.reviewers,
        rawFindingIds: finding.rawFindingIds,
        rawFindings: finding.rawFindingIds
          .map((rawFindingId) => rawFindingsById.get(rawFindingId))
          .filter((rawFinding): rawFinding is RawFinding => rawFinding !== undefined),
        firstSeen: finding.firstSeen,
        lastSeen: finding.lastSeen,
        waivers: finding.waivers,
        disputes: finding.disputes,
        ...(finding.provisional !== undefined
          ? { provisional: { kind: finding.provisional.kind, reason: finding.provisional.reason } }
          : {}),
      }
      : {
        id: finding.id,
        status: finding.status,
        lifecycle: finding.lifecycle,
        severity: finding.severity,
        title: finding.title,
        location: finding.location,
        lastSeen: finding.lastSeen,
      })),
    conflicts: ledger.conflicts.map((conflict) => ({
      id: conflict.id,
      status: conflict.status,
      findingIds: conflict.findingIds,
      rawFindingIds: conflict.rawFindingIds,
      description: conflict.description,
      firstSeen: conflict.firstSeen,
      lastSeen: conflict.lastSeen,
    })),
  };
}

/** 内容中の backtick 連長より長いフェンスで text ブロック化する（フェンス破り注入対策）。 */
function renderFencedTextBlock(content: string): string {
  const longestRun = content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = '`'.repeat(Math.max(longestRun + 1, 5));
  return [`${fence}text`, content, fence].join('\n');
}

/** Backtick-quoted spans and dotted/camelCase/snake_case identifiers — a conservative proxy for "code symbol". Used only to widen the manager's candidate set; never used to auto-merge. */
function extractSymbols(text: string | undefined): Set<string> {
  const symbols = new Set<string>();
  if (text === undefined) {
    return symbols;
  }
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const token = match[1]?.trim();
    if (token) {
      symbols.add(token);
    }
  }
  for (const match of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/g)) {
    symbols.add(match[0]);
  }
  for (const match of text.matchAll(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g)) {
    symbols.add(match[0]);
  }
  for (const match of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*\b/g)) {
    symbols.add(match[0]);
  }
  return symbols;
}

function collectFullDetailFindingIds(ledger: FindingLedger, residualRawFindings: readonly RawFinding[]): Set<string> {
  const ids = new Set<string>();
  for (const conflict of ledger.conflicts) {
    if (conflict.status !== 'active') {
      continue;
    }
    for (const findingId of conflict.findingIds) {
      ids.add(findingId);
    }
  }
  const openFindings = ledger.findings.filter((finding) => finding.status === 'open');
  for (const raw of residualRawFindings) {
    if (raw.targetFindingId !== undefined) {
      ids.add(raw.targetFindingId);
    }
    const rawPath = parseFindingLocation(raw.location)?.path;
    const rawTitle = normalizeFindingText(raw.title).toLowerCase();
    const rawSymbols = new Set([...extractSymbols(raw.title), ...extractSymbols(raw.description)]);
    for (const finding of openFindings) {
      const findingPath = parseFindingLocation(finding.location)?.path;
      if (rawPath !== undefined && findingPath !== undefined && rawPath === findingPath) {
        ids.add(finding.id);
        continue;
      }
      if (normalizeFindingText(finding.title).toLowerCase() === rawTitle) {
        ids.add(finding.id);
        continue;
      }
      const findingSymbols = new Set([...extractSymbols(finding.title), ...extractSymbols(finding.description)]);
      if ([...rawSymbols].some((symbol) => findingSymbols.has(symbol))) {
        ids.add(finding.id);
      }
    }
  }
  return ids;
}

function buildManagerInstruction(input: {
  contract: FindingContractConfig;
  previousLedger: FindingLedger;
  ledgerCopyPath: string;
  rawFindingsPath: string;
  residualRawFindings: RawFinding[];
  mechanicallyClassifiedCount: number;
  priorStepResponseText?: string;
  invalidLocationCandidates: Map<string, string>;
}): string {
  const managerInputLedger = buildManagerInputLedger(
    input.previousLedger,
    collectFullDetailFindingIds(input.previousLedger, input.residualRawFindings),
  );
  const mechanicalNote = input.mechanicallyClassifiedCount > 0
    ? [
      input.contract.manager.instruction,
      '',
      `NOTE: ${input.mechanicallyClassifiedCount} raw findings (exact duplicates, explicit persists/reopened references, and exact resolution confirmations) were already classified mechanically by the engine and are NOT shown below. Classify only the raw findings listed below. Do not reference raw finding ids that are not listed.`,
    ].join('\n')
    : input.contract.manager.instruction;
  const invalidateCandidatesBlock = [...input.invalidLocationCandidates.entries()]
    .map(([findingId, reason]) => `- ${findingId}: ${reason}`)
    .join('\n');
  return loadTemplate('finding_manager_instruction', 'en', {
    managerInstruction: mechanicalNote,
    outputContract: input.contract.manager.outputContract,
    ledgerCopyPath: input.ledgerCopyPath,
    managerInputLedger: renderFencedJsonBlock(managerInputLedger),
    rawFindingsPath: input.rawFindingsPath,
    rawFindings: renderFencedJsonBlock(input.residualRawFindings),
    hasInvalidateCandidates: input.invalidLocationCandidates.size > 0,
    invalidateCandidatesBlock,
    coderResponse: renderFencedTextBlock(input.priorStepResponseText ?? '(no prior step response)'),
  });
}

function parseManagerDecisions(response: AgentResponse): FindingManagerDecisions {
  if (response.status !== 'done') {
    const detail = response.error ?? response.content;
    throw new Error(`Finding manager failed with status "${response.status}": ${detail}`);
  }
  const output = response.structuredOutput;
  if (typeof output !== 'object' || output == null || Array.isArray(output)) {
    throw new Error('Finding manager output must be an object');
  }
  return parseFindingManagerDecisions(output);
}

function buildManagerAgentOptions(
  optionsBuilder: OptionsBuilder,
  managerStep: AgentWorkflowStep,
): ReturnType<OptionsBuilder['buildAgentOptions']> {
  const options = optionsBuilder.buildAgentOptions(managerStep);
  return {
    ...options,
    sessionId: undefined,
    permissionMode: 'readonly',
    allowedTools: [],
  };
}

async function runManagerAttempt(input: {
  managerStep: AgentWorkflowStep;
  instruction: string;
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput'>;
}): Promise<AgentResponse> {
  const phase1Instruction = input.stepExecutor.buildPhase1Instruction(input.instruction, input.managerStep);
  const agentOptions = buildManagerAgentOptions(input.optionsBuilder, input.managerStep);
  const rawResponse = await executeAgent(input.managerStep.persona, phase1Instruction, agentOptions);
  return input.stepExecutor.normalizeStructuredOutput(input.managerStep, rawResponse);
}

function describeRejections(assembly: AssembleManagerOutputResult): string[] {
  return [
    ...assembly.rejectedRawDecisions.map((r) => (
      `rawDecisions: raw finding "${r.rawFindingId}" (${r.decision}) rejected: ${r.reason}`
    )),
    ...assembly.rejectedDisputeDecisions.map((r) => (
      `disputeDecisions: finding "${r.findingId}" (${r.decision}) rejected: ${r.reason}`
    )),
    ...assembly.rejectedConflictDecisions.map((r) => (
      `conflictDecisions: conflict "${r.conflictId}" (${r.decision}) rejected: ${r.reason}`
    )),
    ...assembly.rejectedCarriedConflicts.map((r) => (
      `carriedConflicts: conflict "${r.conflictId}" (findings: ${r.findingIds.join(', ')}) rejected: ${r.reason}`
    )),
    ...assembly.rejectedInvalidateDecisions.map((r) => (
      `invalidateDecisions: finding "${r.findingId}" rejected: ${r.reason}`
    )),
    ...assembly.rejectedDuplicateDecisions.map((r) => (
      `duplicateDecisions: canonical "${r.canonicalFindingId}" (duplicates: ${r.duplicateFindingIds.join(', ')}) rejected: ${r.reason}`
    )),
  ];
}

// ---------------------------------------------------------------------------
// provisional spec builders
// ---------------------------------------------------------------------------

function provisionalSpecForRaw(input: {
  wire: RawFinding;
  canonical: Pick<CanonicalRawFinding, 'reviewerStableKey' | 'lineageKey'>;
  reason: string;
  addInterpretationEpochs?: number;
}): ProvisionalFindingSpec {
  return {
    kind: 'raw-meaning-ambiguous',
    stableKey: computeProvisionalStableKey({
      reviewerStableKey: input.canonical.reviewerStableKey,
      lineageKey: input.canonical.lineageKey,
      provisionalKind: 'raw-meaning-ambiguous',
    }),
    lineageKey: input.canonical.lineageKey,
    sourceRawFindingIds: [input.wire.rawFindingId],
    reason: input.reason,
    title: input.wire.title,
    severity: input.wire.severity,
    ...(input.wire.location !== undefined ? { location: input.wire.location } : {}),
    description: input.wire.description,
    ...(input.wire.suggestion !== undefined ? { suggestion: input.wire.suggestion } : {}),
    reviewers: [input.wire.reviewer],
    addInterpretationEpochs: input.addInterpretationEpochs ?? 0,
  };
}

function stalePreconditionSpec(input: {
  workflowName: string;
  callNamespace: string;
  parentStepName: string;
  targetFindingId: string;
  targetTitle: string;
  targetLocation?: string;
  sourceRawFindingIds: string[];
  reason: string;
}): ProvisionalFindingSpec {
  const reviewerStableKey = computeReviewerStableKey({
    workflowName: input.workflowName,
    callNamespace: input.callNamespace,
    parentStepName: input.parentStepName,
    reviewerPersonaKey: 'findings-manager',
  });
  const lineageKey = computeLineageKey({
    targetFindingId: input.targetFindingId,
    ...(input.targetLocation !== undefined ? { location: input.targetLocation } : {}),
    title: input.targetTitle,
  });
  return {
    kind: 'stale-precondition',
    stableKey: computeProvisionalStableKey({ reviewerStableKey, lineageKey, provisionalKind: 'stale-precondition' }),
    lineageKey,
    sourceRawFindingIds: input.sourceRawFindingIds,
    reason: input.reason,
    title: `Stale precondition on finding ${input.targetFindingId}`,
    severity: 'high',
    description: input.reason,
    reviewers: ['findings-manager'],
    addInterpretationEpochs: 0,
  };
}

// ---------------------------------------------------------------------------
// ambiguous ladder（tainted raw の解釈）
// ---------------------------------------------------------------------------

interface LadderTarget {
  canonical: CanonicalRawFinding;
  wire: RawFinding;
  interpretationKey: string;
}

interface LadderResult {
  /** interpretation 由来の追加出力（保存時に fresh 検証してから統合する）。 */
  pendingSameWithProof: Array<{ target: LadderTarget; proof: DeterministicSameProof; viaInterpretationKey?: string }>;
  pendingIndependentNew: Array<{ wire: RawFinding; viaInterpretationKey?: string }>;
  pendingConflicts: Array<{ target: LadderTarget; targetFindingId: string; viaInterpretationKey?: string }>;
  provisionalSpecs: ProvisionalFindingSpec[];
  /** interpretationKey → provisional spec（applicationResult 記録用）。 */
  provisionalByInterpretationKey: Map<string, ProvisionalFindingSpec>;
  /**
   * ledger_applied 済み解釈（created / matched）の同一 evidence 再来。前回の
   * 着地先（既存 open finding）へ exact identity で帰属させる（新規作成しない
   * — codex B1）。保存時に fresh ledger で一意照合し、見つからなければ
   * provisional へ落とす（gate 安全側）。
   */
  pendingAppliedReattach: Array<{ target: LadderTarget }>;
  stats: InterpretationStatsReport;
}

function buildInterpretationInstruction(input: {
  contract: FindingContractConfig;
  previousLedger: FindingLedger;
  batch: readonly LadderTarget[];
  proofsByRawId: ReadonlyMap<string, DeterministicSameProof>;
}): string {
  const detailIds = new Set<string>();
  for (const target of input.batch) {
    if (target.canonical.targetFindingId !== undefined) {
      detailIds.add(target.canonical.targetFindingId);
    }
  }
  const ledgerView = buildManagerInputLedger(input.previousLedger, detailIds);
  const batchView = input.batch.map((target) => ({
    rawFindingId: target.canonical.rawFindingId,
    reviewer: target.canonical.reviewer,
    claimedRelation: target.canonical.relation,
    targetFindingId: target.canonical.targetFindingId ?? null,
    ambiguityCodes: target.canonical.provenance.ambiguityCodes,
    title: target.wire.title,
    location: target.wire.location ?? null,
    severity: target.wire.severity,
    description: target.wire.description,
    availableSameProofId: input.proofsByRawId.get(target.canonical.rawFindingId)?.proofId ?? null,
    availableSameProofTarget: input.proofsByRawId.get(target.canonical.rawFindingId)?.targetFindingId ?? null,
  }));
  return [
    input.contract.manager.instruction,
    '',
    '## Ambiguous raw finding interpretation',
    'The raw findings below arrived with contradictory or incomplete labeling against the finding ledger, and one reviewer clarification round did not settle them. For EACH raw finding, return exactly one interpretation PROPOSAL. You have no authority over the ledger: the engine validates every proposal against the capabilities it granted, and anything outside them becomes a gate-blocking provisional finding.',
    '',
    'Allowed decisions:',
    '- create_independent: the observation is a real, independent problem. A NEW open finding is created. Existing findings are never touched.',
    '- same_with_proof: ONLY if availableSameProofId is non-null for that raw finding — echo that proofId. You cannot mint proof ids, and textual similarity is never proof.',
    '- open_conflict: the observation relates to an existing OPEN finding but you cannot determine identity. An active conflict is recorded; the finding is not closed.',
    '- provisional: you cannot determine the meaning. The observation is kept as a gate-blocking provisional finding (state the reason).',
    '',
    'You can NEVER resolve, waive, invalidate, supersede, or reopen a finding from here, and a raw finding whose claimed relation is resolution_confirmation can only land as open_conflict or provisional.',
    '',
    '## Current ledger',
    renderFencedJsonBlock(ledgerView),
    '',
    '## Ambiguous raw findings',
    renderFencedJsonBlock(batchView),
  ].join('\n');
}

async function runAmbiguousLadder(input: {
  tainted: readonly CanonicalIntakeItem[];
  previousLedger: FindingLedger;
  ledgerStore: FindingLedgerStore;
  contract: FindingContractConfig;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput'>;
  observation: FindingObservation;
  workflowName: string;
  callNamespace: string;
  parentStepName: string;
}): Promise<LadderResult> {
  const result: LadderResult = {
    pendingSameWithProof: [],
    pendingIndependentNew: [],
    pendingConflicts: [],
    provisionalSpecs: [],
    provisionalByInterpretationKey: new Map(),
    pendingAppliedReattach: [],
    stats: {
      ambiguousRawCount: input.tainted.length,
      managerCalls: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      reusedCompletedDecisions: 0,
      interruptedInterpretations: 0,
      budgetExhaustedLineages: 0,
    },
  };
  if (input.tainted.length === 0) {
    return result;
  }

  // エンジン発行の決定的 SameProof（設計書 §4.2）。
  const proofsByRawId = issueDeterministicSameProofs({
    ledger: input.previousLedger,
    ambiguousRawFindings: input.tainted.map((item) => item.canonical),
  });

  const needsInterpretation: LadderTarget[] = [];
  for (const item of input.tainted) {
    const { canonical, wire } = item;
    const target: LadderTarget = {
      canonical,
      wire,
      interpretationKey: computeInterpretationKey({
        reviewerStableKey: canonical.reviewerStableKey,
        lineageKey: canonical.lineageKey,
        candidateEvidenceHash: canonical.evidenceHash,
      }),
    };

    // 機械段: 決定的 SameProof が成立するなら manager を呼ばない（§5 規則1）。
    const proof = proofsByRawId.get(canonical.rawFindingId);
    if (proof !== undefined) {
      result.pendingSameWithProof.push({ target, proof });
      continue;
    }
    // 機械段: correction 後に形式が整った additive new（現時点でも衝突しない）は
    // コードで確定する（既存状態を弱めない追加のみの操作 — §4.1 で ambiguous にも可）。
    if (canonical.coherence === 'coherent' && canonical.relation === 'new') {
      const currentDetection = detectRawFindingAmbiguities(canonical, input.previousLedger);
      if (currentDetection.codes.length === 0) {
        result.pendingIndependentNew.push({ wire });
        continue;
      }
    }
    // 解釈 epoch 上限（lineage あたり2回）。超過は provisional 更新のみで
    // manager を再呼び出さない（攻撃5対策）。
    if (countInterpretationEpochs(input.previousLedger, canonical.lineageKey)
      >= MANAGER_INTERPRETATION_LIMITS.maxInterpretationEpochsPerLineage) {
      result.provisionalSpecs.push(provisionalSpecForRaw({
        wire,
        canonical,
        reason: `Ambiguous raw finding reached the automatic interpretation limit (${MANAGER_INTERPRETATION_LIMITS.maxInterpretationEpochsPerLineage} epochs per lineage); kept provisional without re-interpreting`,
      }));
      continue;
    }
    needsInterpretation.push(target);
  }

  // step あたりの解釈対象上限。残余は単一の budget provisional（§10）。
  const interpretationTargets = needsInterpretation.slice(0, MANAGER_INTERPRETATION_LIMITS.maxInterpretationTargetsPerStep);
  let leftover = needsInterpretation.slice(MANAGER_INTERPRETATION_LIMITS.maxInterpretationTargetsPerStep);

  // WAL begin（1回の updateLedger）。resume 分類はここで決まる。
  const begin = await beginInterpretations(
    input.ledgerStore,
    interpretationTargets.map((target): NewInterpretationInput => ({
      interpretationKey: target.interpretationKey,
      reviewerStableKey: target.canonical.reviewerStableKey,
      lineageKey: target.canonical.lineageKey,
      candidateEvidenceHash: target.canonical.evidenceHash,
      promptPreconditions: [],
    })),
    input.observation,
  );

  const toCall: LadderTarget[] = [];
  const decidedByKey = new Map<string, AmbiguousInterpretation>();
  for (const target of interpretationTargets) {
    if (begin.appliedByKey.has(target.interpretationKey)) {
      // 既に適用済み（前回 run で ledger_applied）の同一 evidence 再来。
      // no-op で放置すると reconciler の fallback へ流れ、別キーの provisional が
      // 増殖する（codex B1）。前回の着地種別に応じて既存エントリへ帰属させる。
      const priorResult = begin.appliedByKey.get(target.interpretationKey);
      if (priorResult === 'created' || priorResult === 'matched_with_proof') {
        // 前回 confirmed finding として着地済み → その finding へ raw を添付。
        result.pendingAppliedReattach.push({ target });
      } else {
        // 前回 provisional / conflict として着地済み → 同じ stableKey の
        // provisional へ upsert（新規 ID は作らない。lastObserved / raw 添付のみ）。
        result.provisionalSpecs.push(provisionalSpecForRaw({
          wire: target.wire,
          canonical: target.canonical,
          reason: 'Same-evidence observation reappeared after its interpretation was already applied; attached to the existing provisional without re-interpreting',
        }));
      }
      continue;
    }
    const completed = begin.completedByKey.get(target.interpretationKey);
    if (completed !== undefined) {
      // WAL の completed decision を再利用（再問い合わせしない — 設計書 §9）。
      decidedByKey.set(target.interpretationKey, completed);
      result.stats.reusedCompletedDecisions += 1;
      continue;
    }
    if (begin.interruptedKeys.has(target.interpretationKey)) {
      // started のみで中断されていた: manager を再呼び出さず provisional（§9 resume 表）。
      const spec: ProvisionalFindingSpec = {
        ...provisionalSpecForRaw({
          wire: target.wire,
          canonical: target.canonical,
          reason: 'Interpretation was interrupted before the manager decision was recorded; kept provisional without re-interpreting',
        }),
        kind: 'interpretation-interrupted',
        stableKey: computeProvisionalStableKey({
          reviewerStableKey: target.canonical.reviewerStableKey,
          lineageKey: target.canonical.lineageKey,
          provisionalKind: 'interpretation-interrupted',
        }),
      };
      result.provisionalSpecs.push(spec);
      result.provisionalByInterpretationKey.set(target.interpretationKey, spec);
      result.stats.interruptedInterpretations += 1;
      continue;
    }
    toCall.push(target);
  }

  // batch 実行（16件/batch・4 call/step・token 予算 — 設計書 §10 の表の値）。
  const ambiguousByRawId = new Map(input.tainted.map((item) => [item.canonical.rawFindingId, item.canonical]));
  const targetsByRawId = new Map(interpretationTargets.map((target) => [target.canonical.rawFindingId, target]));
  let callCount = 0;
  let queue = [...toCall];
  while (queue.length > 0) {
    if (callCount >= MANAGER_INTERPRETATION_LIMITS.maxManagerCallsPerStep
      || result.stats.estimatedInputTokens >= MANAGER_INTERPRETATION_LIMITS.maxInputTokensPerStep
      || result.stats.estimatedOutputTokens >= MANAGER_INTERPRETATION_LIMITS.maxOutputTokensPerStep) {
      leftover = [...leftover, ...queue];
      queue = [];
      break;
    }
    let batch = queue.slice(0, MANAGER_INTERPRETATION_LIMITS.maxAmbiguousCandidatesPerBatch);
    let instruction = buildInterpretationInstruction({
      contract: input.contract,
      previousLedger: input.previousLedger,
      batch,
      proofsByRawId,
    });
    // per-call input 予算: 超える場合は batch を半分に縮めて作り直す。
    while (batch.length > 1 && estimateTokens(instruction) > MANAGER_INTERPRETATION_LIMITS.maxInputTokensPerCall) {
      batch = batch.slice(0, Math.max(1, Math.floor(batch.length / 2)));
      instruction = buildInterpretationInstruction({
        contract: input.contract,
        previousLedger: input.previousLedger,
        batch,
        proofsByRawId,
      });
    }
    const inputTokens = estimateTokens(instruction);
    if (inputTokens > MANAGER_INTERPRETATION_LIMITS.maxInputTokensPerCall
      || result.stats.estimatedInputTokens + inputTokens > MANAGER_INTERPRETATION_LIMITS.maxInputTokensPerStep) {
      leftover = [...leftover, ...queue];
      queue = [];
      break;
    }
    queue = queue.slice(batch.length);
    callCount += 1;
    result.stats.managerCalls = callCount;
    result.stats.estimatedInputTokens += inputTokens;

    const interpretationStep = buildFindingInterpretationStep({
      contract: input.contract,
      workflowProvider: input.workflowProvider,
      workflowModel: input.workflowModel,
    });
    let batchDecisions = new Map<string, AmbiguousInterpretation>();
    try {
      const response = await runManagerAttempt({
        managerStep: interpretationStep,
        instruction,
        optionsBuilder: input.optionsBuilder,
        stepExecutor: input.stepExecutor,
      });
      if (response.status !== 'done') {
        throw new Error(`Finding interpreter failed with status "${response.status}": ${response.error ?? response.content}`);
      }
      const outputTokens = estimateTokens(JSON.stringify(response.structuredOutput ?? {}));
      result.stats.estimatedOutputTokens += outputTokens;
      if (outputTokens > MANAGER_INTERPRETATION_LIMITS.maxOutputTokensPerCall) {
        throw new Error(`Finding interpreter output exceeded the per-call budget (${outputTokens} estimated tokens)`);
      }
      const parsed = parseAmbiguousInterpretations(response.structuredOutput ?? {});
      const batchRawIds = new Set(batch.map((target) => target.canonical.rawFindingId));
      const validation = validateAmbiguousInterpretations({
        parsed: parsed.filter((proposal) => batchRawIds.has(proposal.rawFindingId)),
        ambiguousByRawId,
        issuedProofsByRawId: proofsByRawId,
        ledger: input.previousLedger,
      });
      for (const item of validation.validated) {
        if (item.outcome === 'accepted') {
          // resolution_confirmation の主張を持つ raw は issue 証拠になれない
          // （確認は問題の観測ではない）。open_conflict / provisional に限定する。
          const raw = ambiguousByRawId.get(item.interpretation.rawFindingId)!;
          if (raw.relation === 'resolution_confirmation'
            && (item.interpretation.decision === 'create_independent' || item.interpretation.decision === 'same_with_proof')) {
            batchDecisions.set(
              targetsByRawId.get(item.interpretation.rawFindingId)!.interpretationKey,
              {
                decision: 'provisional',
                rawFindingId: item.interpretation.rawFindingId,
                reason: `Interpretation "${item.interpretation.decision}" is not allowed for a resolution_confirmation claim; kept provisional`,
              },
            );
            continue;
          }
          batchDecisions.set(
            targetsByRawId.get(item.interpretation.rawFindingId)!.interpretationKey,
            item.interpretation,
          );
        } else {
          batchDecisions.set(
            targetsByRawId.get(item.rawFindingId)!.interpretationKey,
            { decision: 'provisional', rawFindingId: item.rawFindingId, reason: item.reason },
          );
        }
      }
      // 決定が返らなかった raw も provisional decision として completed に記録する
      // （同じ evidence への再問い合わせはしない — semantic retry 0回）。
      for (const target of batch) {
        if (!batchDecisions.has(target.interpretationKey)) {
          batchDecisions.set(target.interpretationKey, {
            decision: 'provisional',
            rawFindingId: target.canonical.rawFindingId,
            reason: 'Manager returned no interpretation for this raw finding',
          });
        }
      }
    } catch (error) {
      // manager の壊れた応答で run を殺さない: batch 全員を provisional decision に。
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Finding interpretation call failed; landing the batch as provisional', { error: message });
      batchDecisions = new Map(batch.map((target) => [
        target.interpretationKey,
        {
          decision: 'provisional' as const,
          rawFindingId: target.canonical.rawFindingId,
          reason: `Manager interpretation failed: ${message}`,
        },
      ]));
    }
    await completeInterpretations(input.ledgerStore, batchDecisions, input.observation);
    for (const [key, decision] of batchDecisions) {
      decidedByKey.set(key, decision);
    }
  }

  // 予算切れの残余: 次 run へ無理に持ち越さず単一の budget provisional（§10）。
  if (leftover.length > 0) {
    result.stats.budgetExhaustedLineages = leftover.length;
    const reviewerStableKey = computeReviewerStableKey({
      workflowName: input.workflowName,
      callNamespace: input.callNamespace,
      parentStepName: input.parentStepName,
      reviewerPersonaKey: 'findings-manager',
    });
    const lineageKey = computeLineageKey({ title: 'Finding manager interpretation budget exhausted' });
    result.provisionalSpecs.push({
      kind: 'manager-budget-exhausted',
      stableKey: computeProvisionalStableKey({ reviewerStableKey, lineageKey, provisionalKind: 'manager-budget-exhausted' }),
      lineageKey,
      sourceRawFindingIds: leftover.map((target) => target.wire.rawFindingId),
      reason: `Manager interpretation budget was exhausted before ${leftover.length} ambiguous raw finding(s) could be interpreted. Affected lineages: ${leftover.map((target) => target.canonical.lineageKey.slice(0, 12)).join(', ')}`,
      title: 'Finding manager interpretation budget exhausted',
      severity: 'high',
      description: `Uninterpreted ambiguous observations remain (${leftover.length}); they block the final gate until a later round interprets or settles them.`,
      reviewers: ['findings-manager'],
      addInterpretationEpochs: 0,
    });
  }

  // 検証済み decision を pending 適用へ変換する（fresh 検証は保存時）。
  for (const [key, decision] of decidedByKey) {
    const target = interpretationTargets.find((candidate) => candidate.interpretationKey === key);
    if (target === undefined) {
      continue;
    }
    switch (decision.decision) {
      case 'create_independent':
        result.pendingIndependentNew.push({ wire: target.wire, viaInterpretationKey: key });
        break;
      case 'same_with_proof': {
        const proof = proofsByRawId.get(decision.rawFindingId);
        if (proof !== undefined && proof.proofId === decision.proofId) {
          result.pendingSameWithProof.push({ target, proof, viaInterpretationKey: key });
        } else {
          const spec = provisionalSpecForRaw({
            wire: target.wire,
            canonical: target.canonical,
            reason: 'Stored same_with_proof decision no longer matches an engine-issued proof; kept provisional',
            addInterpretationEpochs: 1,
          });
          result.provisionalSpecs.push(spec);
          result.provisionalByInterpretationKey.set(key, spec);
        }
        break;
      }
      case 'open_conflict':
        result.pendingConflicts.push({ target, targetFindingId: decision.targetFindingId, viaInterpretationKey: key });
        break;
      case 'provisional': {
        const spec = provisionalSpecForRaw({
          wire: target.wire,
          canonical: target.canonical,
          reason: decision.reason,
          addInterpretationEpochs: 1,
        });
        result.provisionalSpecs.push(spec);
        result.provisionalByInterpretationKey.set(key, spec);
        break;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 実行本体
// ---------------------------------------------------------------------------

export async function runFindingManagerForStep(
  input: RunFindingManagerForStepInput,
): Promise<FindingManagerRunResult> {
  const previousLedger = input.ledgerStore.loadLedger();
  const ledgerCopyPath = input.ledgerCopyPath ?? input.ledgerStore.createRunCopy();
  const observation: FindingObservation = {
    runId: input.runId,
    stepName: input.parentStep.name,
    timestamp: input.timestamp,
  };

  // 1. intake: envelope → candidate → canonical（例外で死ぬ経路は無い）。
  const intake = intakeReviewerOutputs({
    subResults: input.subResults,
    previousLedger,
    workflowName: input.workflowName,
    callNamespace: input.callNamespace,
    parentStepName: input.parentStep.name,
    stepIteration: input.stepIteration,
    runId: input.runId,
  });

  // 監査用に全量を保存（overflow の synthetic raw を含む）。
  const rawFindingsPath = input.ledgerStore.saveRawFindings(
    input.runId,
    input.parentStep.name,
    intake.items.map((item) => item.wire),
  );

  // 正規化監査の write-ahead 永続化（codex 3巡目ブロッカー対応）: intake 直後・
  // manager 呼び出し / WAL / updateLedger より前にディスクへ載せる。以降の区間で
  // 例外が起きても「正規化前の元の主張」は失われない。run が正常完了した場合は
  // 末尾の最終レポート保存（同一ファイル名。writeReportFile が旧版を backup して
  // 上書き）が同じ rawNormalizations を包含するため、二重管理にはならない。
  if (intake.rawNormalizations.length > 0
    || intake.overflowReports.length > 0
    || intake.clarifications.length > 0) {
    input.ledgerStore.saveManagerValidationReport({
      version: 1,
      runId: input.runId,
      stepName: input.parentStep.name,
      retryCount: 0,
      // まだ台帳更新前の先行保存であることを示す（最終保存が true で上書きする）。
      ledgerUpdated: false,
      finalErrors: [],
      attempts: [],
      ...(intake.overflowReports.length > 0 ? { reviewerOutputOverflows: intake.overflowReports } : {}),
      ...(intake.rawNormalizations.length > 0 ? { rawNormalizations: intake.rawNormalizations } : {}),
      ...(intake.clarifications.length > 0 ? { relationClarifications: intake.clarifications } : {}),
    });
  }

  const managerStep = buildFindingManagerStep({
    contract: input.contract,
    workflowProvider: input.workflowProvider,
    workflowModel: input.workflowModel,
  });
  const providerInfo = input.optionsBuilder.resolveStepProviderModel(managerStep);

  // 2. 分割: overflow / clean / tainted。
  const nonOverflow = intake.items.filter((item) => !intake.overflowRawFindingIds.has(item.canonical.rawFindingId));
  const clean = nonOverflow.filter((item) => item.canonical.coherence === 'coherent' && !item.canonical.provenance.ambiguityOrigin);
  const tainted = nonOverflow.filter((item) => item.canonical.provenance.ambiguityOrigin);

  // 3. raw admission validation（location の決定的検証）。着地規則は clean /
  //    tainted で共通の1つのハンドラに集約する（A-1: 二重ループの非対称が
  //    tainted 側の confirmation 除外漏れ — 実台帳 F-0015/16/17 — を生んだ）:
  //    - confirmation: 証拠不採用のみ（provisional を作らない。監査保存のみ）
  //    - persists → 実在する open target: target への監査添付（A-3。target が
  //      既に gate を塞いでいるため独立 provisional を作らない。provisional
  //      target ならその観測履歴に添付され、新規 blocker は増えない）
  //    - それ以外: invalid-location-evidence provisional（B3 — 決定的に証明
  //      できるのは location 証拠の不成立だけで、欠陥の虚偽は証明できない）
  const admissionRejections: RawAdmissionRejectionReport[] = [];
  const admissionProvisionalSpecs: ProvisionalFindingSpec[] = [];
  const admissionRejectedItems: CanonicalIntakeItem[] = [];
  const pendingRejectedObservations: Array<{ item: CanonicalIntakeItem; targetFindingId: string; reason: string }> = [];
  const cleanAdmitted: CanonicalIntakeItem[] = [];
  const taintedAdmitted: CanonicalIntakeItem[] = [];
  const ladderProvisionalSpecs: ProvisionalFindingSpec[] = [];
  const previousFindingsById = new Map(previousLedger.findings.map((finding) => [finding.id, finding]));

  const handleRejectedLocation = (item: CanonicalIntakeItem, reason: string, pool: 'clean' | 'tainted'): void => {
    admissionRejections.push({
      rawFindingId: item.wire.rawFindingId,
      location: item.wire.location ?? '',
      reason,
    });
    // A-1（clean/tainted 共通）: 解消確認は問題の観測ではないため、location
    // 証拠の不成立でも provisional を作らない（証拠不採用 + 監査保存のみ。
    // target も resolve しない）。
    if (item.wire.kind === 'resolution_confirmation') {
      return;
    }
    if (pool === 'clean') {
      // tainted は reconcileRawFindings に全量入るため、二重計上しない。
      admissionRejectedItems.push(item);
    }
    // A-3: persists が実在する open target を指すなら、target への監査添付に
    // する（独立 provisional を作らない）。target が terminal または不明なら
    // 従来どおり provisional（B3 維持）。
    const targetFindingId = item.wire.targetFindingId;
    const target = targetFindingId !== undefined ? previousFindingsById.get(targetFindingId) : undefined;
    if (item.canonical.relation === 'persists' && target !== undefined && target.status === 'open') {
      pendingRejectedObservations.push({
        item,
        targetFindingId: targetFindingId!,
        reason: `Location evidence "${item.wire.location ?? ''}" failed deterministic admission (${reason}); recorded as a rejected re-observation of the open target`,
      });
      return;
    }
    const spec: ProvisionalFindingSpec = {
      ...provisionalSpecForRaw({
        wire: item.wire,
        canonical: item.canonical,
        reason: `Location evidence "${item.wire.location ?? ''}" failed deterministic admission (${reason}); the observation is kept provisional because the location's failure does not prove the finding itself is false`,
      }),
      kind: 'invalid-location-evidence',
      stableKey: computeProvisionalStableKey({
        reviewerStableKey: item.canonical.reviewerStableKey,
        lineageKey: item.canonical.lineageKey,
        provisionalKind: 'invalid-location-evidence',
      }),
    };
    (pool === 'clean' ? admissionProvisionalSpecs : ladderProvisionalSpecs).push(spec);
  };

  for (const item of clean) {
    const location = item.wire.location;
    const admission = location === undefined ? { ok: true as const } : validateLocationAdmission(input.cwd, location);
    if (admission.ok) {
      cleanAdmitted.push(item);
    } else {
      handleRejectedLocation(item, admission.reason ?? 'invalid location', 'clean');
    }
  }
  for (const item of tainted) {
    const location = item.wire.location;
    const admission = location === undefined ? { ok: true as const } : validateLocationAdmission(input.cwd, location);
    if (admission.ok) {
      taintedAdmitted.push(item);
    } else {
      handleRejectedLocation(item, admission.reason ?? 'invalid location', 'tainted');
    }
  }

  const cleanWire = cleanAdmitted.map((item) => item.wire);

  // 4. clean 経路: 機械分類 + decisions manager（semantic retry 0回）。
  const invalidLocationCandidates = computeInvalidLocationCandidates(input.cwd, previousLedger.findings);
  const invalidLocationCandidateFindingIds = new Set(invalidLocationCandidates.keys());
  const mechanical = classifyRawFindingsMechanically({ previousLedger, rawFindings: cleanWire });
  const hasDisputeClaims = hasDisputeClaimsHeading(input.priorStepResponseText);
  const hasActiveConflict = previousLedger.conflicts.some((conflict) => conflict.status === 'active');
  const needsAgent = mechanical.residualRawFindings.length > 0
    || hasDisputeClaims
    || hasActiveConflict
    || invalidLocationCandidateFindingIds.size > 0;

  const invalidAttempts: FindingManagerValidationAttemptReport[] = [];
  const cleanProvisionalSpecs: ProvisionalFindingSpec[] = [];
  const unsupportedRawFindingReports: UnsupportedRawFindingReport[] = [];
  const cleanWireById = new Map(cleanWire.map((wire) => [wire.rawFindingId, wire]));
  const cleanCanonicalById = new Map(cleanAdmitted.map((item) => [item.wire.rawFindingId, item.canonical]));

  const landRawAsProvisional = (rawFindingId: string, reason: string): void => {
    const wire = cleanWireById.get(rawFindingId);
    const canonical = cleanCanonicalById.get(rawFindingId);
    if (wire === undefined || canonical === undefined) {
      return;
    }
    // 解消確認は問題の観測ではないため provisional にしない（適用されなかった
    // confirmation の競合は CAS 経路が conflict / stale-precondition で扱う）。
    if (wire.kind === 'resolution_confirmation') {
      return;
    }
    cleanProvisionalSpecs.push(provisionalSpecForRaw({ wire, canonical, reason }));
  };

  let managerOutput: FindingManagerOutput;
  if (needsAgent) {
    const instruction = buildManagerInstruction({
      contract: input.contract,
      previousLedger,
      ledgerCopyPath,
      rawFindingsPath,
      residualRawFindings: mechanical.residualRawFindings,
      mechanicallyClassifiedCount: cleanWire.length - mechanical.residualRawFindings.length,
      priorStepResponseText: input.priorStepResponseText,
      invalidLocationCandidates,
    });
    let decisions: FindingManagerDecisions;
    try {
      const response = await runManagerAttempt({
        managerStep,
        instruction,
        optionsBuilder: input.optionsBuilder,
        stepExecutor: input.stepExecutor,
      });
      decisions = parseManagerDecisions(response);
    } catch (error) {
      // manager の壊れた応答で run を殺さない（v2 の中核不変条件）。残余 raw は
      // 全て provisional へ着地し、機械分類の確定分だけを適用する。
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Finding manager decisions call failed; landing residual raws as provisional', { error: message });
      decisions = { rawDecisions: [], disputeDecisions: [], conflictDecisions: [], invalidateDecisions: [], duplicateDecisions: [] };
      invalidAttempts.push({ attempt: 1, managerOutput: { error: message }, validationErrors: [message] });
    }
    const assembly = assembleManagerOutput({
      previousLedger,
      residualRawFindings: mechanical.residualRawFindings,
      decisions,
      priorStepResponseText: input.priorStepResponseText,
      checkMissingDecisions: true,
      mechanicalOutput: mechanical.output,
      invalidLocationCandidateFindingIds,
    });
    // v2: semantic retry は 0 回。不採用・欠落の raw decision は provisional へ。
    // ただし同じ raw の別 decision が採用済み（重複 decision の2件目拒否など）
    // なら、その raw は既に行き先を持つため provisional に二重着地させない。
    const landedRawIds = collectLandedRawIds(assembly.output);
    for (const rejected of assembly.rejectedRawDecisions) {
      if (landedRawIds.has(rejected.rawFindingId)) {
        continue;
      }
      landRawAsProvisional(
        rejected.rawFindingId,
        `Manager decision (${rejected.decision}) was rejected: ${rejected.reason}`,
      );
    }
    // unsupported も監査のみで消さず provisional へ（「no-op / drop / unsupported
    // のみ → 必ず provisional へ変換」）。
    for (const unsupported of assembly.unsupportedRawDecisions) {
      unsupportedRawFindingReports.push(unsupported);
      landRawAsProvisional(
        unsupported.rawFindingId,
        `Manager decided "unsupported" against finding "${unsupported.targetFindingId}": ${unsupported.evidence}`,
      );
    }
    if (describeRejections(assembly).length > 0) {
      invalidAttempts.push({ attempt: invalidAttempts.length + 1, managerOutput: decisions, validationErrors: describeRejections(assembly) });
    }
    managerOutput = assembly.output;
  } else {
    managerOutput = mechanical.output;
  }

  // 最終防衛線: assembly を通った出力が台帳不変条件に反するなら、出力を捨てて
  // 全 clean raw を provisional に落とす（run は殺さない。gate は閉じたまま）。
  const finalValidation = validateFindingManagerOutput({
    previousLedger,
    rawFindings: cleanWire,
    managerOutput,
    priorStepResponseText: input.priorStepResponseText,
  });
  if (!finalValidation.ok) {
    invalidAttempts.push({ attempt: invalidAttempts.length + 1, managerOutput, validationErrors: finalValidation.errors });
    for (const wire of cleanWire) {
      landRawAsProvisional(
        wire.rawFindingId,
        'Manager output violated ledger invariants and was discarded; raw finding kept provisional',
      );
    }
    managerOutput = emptyManagerOutput();
  }

  // 5. ambiguous ladder（tainted raw）。
  // A-1（完全版・codex ブロッカー1）: tainted な confirmation（relation が
  // resolution_confirmation に解決される raw）は admission の成否にかかわらず
  // ladder に載せず、provisional 着地から除外する。曖昧起源の confirmation は
  // capability 格子上 resolve 権限を持たず（mayResolve: false）、provisional 化は
  // 「解消確認」を blocker に変換する誤着地（実台帳 F-0015/16/17 — 実 location は
  // 行範囲で、A-2 の正規化により admission を通過して ladder へ入っていた）。
  // 正しい着地は「解消証拠としては不採用、監査保存のみ」— blocker も作らず
  // target も触らない。clean 側の規則（location 不成立 confirmation の監査のみ /
  // 不採用 decision の confirmation 非 provisional 化）と対称。
  const taintedConfirmations = taintedAdmitted.filter(
    (item) => item.canonical.relation === 'resolution_confirmation',
  );
  for (const item of taintedConfirmations) {
    unsupportedRawFindingReports.push({
      rawFindingId: item.wire.rawFindingId,
      targetFindingId: item.wire.targetFindingId ?? item.canonical.targetFindingId ?? '(none)',
      evidence: 'Ambiguity-tainted resolution confirmation cannot serve as resolution evidence (no resolve capability); recorded for audit only — no finding was created or changed',
    });
  }
  const ladderTainted = taintedAdmitted.filter(
    (item) => item.canonical.relation !== 'resolution_confirmation',
  );
  const ladder = await runAmbiguousLadder({
    tainted: ladderTainted,
    previousLedger,
    ledgerStore: input.ledgerStore,
    contract: input.contract,
    workflowProvider: input.workflowProvider,
    workflowModel: input.workflowModel,
    optionsBuilder: input.optionsBuilder,
    stepExecutor: input.stepExecutor,
    observation,
    workflowName: input.workflowName,
    callNamespace: input.callNamespace,
    parentStepName: input.parentStep.name,
  });

  // 6. 保存: 排他区間で最新台帳へ再照合し、CAS を適用して反映する。
  //    LLM 呼び出しはここまでで全て完了している（mutator は同期処理のみ）。
  const capturedPreconditions = captureFindingPreconditions(previousLedger);
  const reconcileRawFindings = [
    ...cleanWire,
    ...admissionRejectedItems.map((item) => item.wire),
    ...tainted.map((item) => item.wire),
    ...intake.items.filter((item) => intake.overflowRawFindingIds.has(item.canonical.rawFindingId)).map((item) => item.wire),
  ];
  // B1-b: reconciler の defense-in-depth fallback が別の reviewerStableKey を
  // 導出しないよう、canonical の provenance（stable key / lineage）を伝搬する。
  const rawProvenanceByRawFindingId = new Map(
    intake.items.map((item) => [item.canonical.rawFindingId, {
      reviewerStableKey: item.canonical.reviewerStableKey,
      lineageKey: item.canonical.lineageKey,
    }]),
  );
  let staleRejections: string[] = [];
  const interpretationResults = new Map<string, InterpretationApplicationResult>();
  const provisionalLandings: ProvisionalLandingReport[] = [];

  const nextLedger = await input.ledgerStore.updateLedger((freshLedger) => {
    staleRejections = [];
    interpretationResults.clear();
    provisionalLandings.length = 0;
    const specs: ProvisionalFindingSpec[] = [
      ...intake.overflowSpecs,
      ...admissionProvisionalSpecs,
      ...ladderProvisionalSpecs,
      ...cleanProvisionalSpecs,
      ...ladder.provisionalSpecs,
    ];

    for (const [key, spec] of ladder.provisionalByInterpretationKey) {
      const existsOpen = freshLedger.findings.some(
        (finding) => finding.status === 'open' && finding.provisional?.stableKey === spec.stableKey,
      );
      interpretationResults.set(key, existsOpen ? 'provisional_updated' : 'provisional_created');
    }

    // clean 決定を最新台帳へ再照合（既存の lost-update 対策）。
    const { decisions, carriedFindingOnlyConflicts } = flattenManagerOutputToDecisions(managerOutput);
    const freshAssembly = assembleManagerOutput({
      previousLedger: freshLedger,
      residualRawFindings: cleanWire,
      decisions,
      carriedFindingOnlyConflicts,
      priorStepResponseText: input.priorStepResponseText,
      invalidLocationCandidateFindingIds: new Set(
        computeInvalidLocationCandidates(input.cwd, freshLedger.findings).keys(),
      ),
    });
    staleRejections = describeRejections(freshAssembly);
    // 再照合で項目単位不採用になった raw も provisional へ着地させる（黙って捨てない）。
    const freshLandedRawIds = collectLandedRawIds(freshAssembly.output);
    for (const rejected of freshAssembly.rejectedRawDecisions) {
      if (freshLandedRawIds.has(rejected.rawFindingId)) {
        continue;
      }
      const wire = cleanWireById.get(rejected.rawFindingId);
      const canonical = cleanCanonicalById.get(rejected.rawFindingId);
      if (wire !== undefined && canonical !== undefined && wire.kind !== 'resolution_confirmation') {
        specs.push(provisionalSpecForRaw({
          wire,
          canonical,
          reason: `Decision (${rejected.decision}) became stale against the freshly reloaded ledger: ${rejected.reason}`,
        }));
      }
    }
    let output = freshAssembly.output;

    // CAS（設計書 §6）: 全 confirmation と reopen / waive / invalidate / supersede に適用。
    const cas = applyPreconditionChecks({
      output,
      captured: capturedPreconditions,
      freshLedger,
      workflowName: input.workflowName,
      callNamespace: input.callNamespace,
      parentStepName: input.parentStep.name,
    });
    output = cas.output;
    specs.push(...cas.provisionalSpecs);
    staleRejections = [...staleRejections, ...cas.staleDetails];

    // ladder の pending 適用（fresh 検証つき）。
    const ladderOutput = emptyManagerOutput();
    for (const pending of ladder.pendingSameWithProof) {
      const verification = verifySameProofAgainstLedger(pending.proof, freshLedger);
      if (verification.ok) {
        ladderOutput.matches.push({
          findingId: pending.proof.targetFindingId,
          rawFindingIds: [pending.target.wire.rawFindingId],
          evidence: `Deterministic same proof ${pending.proof.proofId.slice(0, 12)} (exact normalized identity match)`,
        });
        if (pending.viaInterpretationKey !== undefined) {
          interpretationResults.set(pending.viaInterpretationKey, 'matched_with_proof');
        }
      } else {
        specs.push(provisionalSpecForRaw({
          wire: pending.target.wire,
          canonical: pending.target.canonical,
          reason: `Deterministic same proof became stale before save: ${verification.reason}`,
        }));
        if (pending.viaInterpretationKey !== undefined) {
          interpretationResults.set(pending.viaInterpretationKey, 'stale_precondition');
        }
      }
    }
    for (const pending of ladder.pendingIndependentNew) {
      ladderOutput.newFindings.push({
        rawFindingIds: [pending.wire.rawFindingId],
        title: pending.wire.title,
        severity: pending.wire.severity,
      });
      if (pending.viaInterpretationKey !== undefined) {
        interpretationResults.set(pending.viaInterpretationKey, 'created');
      }
    }
    for (const pending of ladder.pendingConflicts) {
      const target = freshLedger.findings.find((finding) => finding.id === pending.targetFindingId);
      if (target !== undefined && target.status === 'open') {
        ladderOutput.conflicts.push({
          findingIds: [pending.targetFindingId],
          rawFindingIds: [pending.target.wire.rawFindingId],
          description: `Ambiguous observation "${pending.target.wire.title}" relates to finding "${pending.targetFindingId}" but its identity could not be determined`,
        });
        // §5 規則3: conflict と併せて観測自体も provisional として保持する。
        specs.push(provisionalSpecForRaw({
          wire: pending.target.wire,
          canonical: pending.target.canonical,
          reason: `Held as provisional while an active conflict against finding "${pending.targetFindingId}" is adjudicated`,
          addInterpretationEpochs: 1,
        }));
        if (pending.viaInterpretationKey !== undefined) {
          interpretationResults.set(pending.viaInterpretationKey, 'conflict_created');
        }
      } else {
        specs.push(provisionalSpecForRaw({
          wire: pending.target.wire,
          canonical: pending.target.canonical,
          reason: `Conflict target "${pending.targetFindingId}" is no longer open; observation kept provisional`,
          addInterpretationEpochs: 1,
        }));
        if (pending.viaInterpretationKey !== undefined) {
          interpretationResults.set(pending.viaInterpretationKey, 'provisional_created');
        }
      }
    }

    // B1: ledger_applied 済み（created / matched）解釈の同一 evidence 再来を
    // 前回の着地先へ帰属させる。fresh ledger で完全 identity（正規化
    // path+title+description）が一意に一致する open finding に raw を添付し、
    // 見つからなければ provisional へ落とす（新規 finding は作らない）。
    for (const pending of ladder.pendingAppliedReattach) {
      const identity = fullIdentityKeyOf(pending.target.wire.location, pending.target.wire.title, pending.target.wire.description);
      const freshRawsById = new Map(freshLedger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
      const candidates = freshLedger.findings.filter((finding) => {
        if (finding.status !== 'open') {
          return false;
        }
        if (fullIdentityKeyOf(finding.location, finding.title, finding.description) === identity) {
          return true;
        }
        return finding.rawFindingIds.some((rawFindingId) => {
          const raw = freshRawsById.get(rawFindingId);
          return raw !== undefined && fullIdentityKeyOf(raw.location, raw.title, raw.description) === identity;
        });
      });
      if (candidates.length === 1) {
        ladderOutput.matches.push({
          findingId: candidates[0]!.id,
          rawFindingIds: [pending.target.wire.rawFindingId],
          evidence: 'Same-evidence observation reattached to its previously applied finding (exact identity)',
        });
      } else {
        specs.push(provisionalSpecForRaw({
          wire: pending.target.wire,
          canonical: pending.target.canonical,
          reason: 'Same-evidence observation reappeared after its interpretation was applied, but its previously created finding could not be uniquely re-identified; kept provisional',
        }));
      }
    }

    // clean 出力 + ladder 出力を統合し、clean 証拠による provisional の
    // 確定・解消（§8）を決定的に適用する。
    let merged = mergeOutputs(output, ladderOutput);
    const settlement = settleProvisionalsWithCleanEvidence({
      output: merged,
      cleanRawIds: new Set(cleanWire.map((wire) => wire.rawFindingId)),
      wireById: new Map(reconcileRawFindings.map((wire) => [wire.rawFindingId, wire])),
      freshLedger,
    });
    merged = settlement.output;

    for (const spec of specs) {
      provisionalLandings.push({
        kind: spec.kind,
        stableKey: spec.stableKey,
        reason: spec.reason,
        sourceRawFindingIds: spec.sourceRawFindingIds,
      });
    }

    const reconciled = reconcileFindingLedger({
      priorStepResponseText: input.priorStepResponseText,
      previousLedger: freshLedger,
      rawFindings: reconcileRawFindings,
      managerOutput: merged,
      provisionalFindings: specs,
      rawProvenanceByRawFindingId,
      // A-3 の証跡不成立 persists は reconcile 後に添付 or provisional として
      // 着地する（下記）— fallback で二重着地させない。
      excludedFromUnmentionedFallbackRawFindingIds: new Set(
        pendingRejectedObservations.map((pending) => pending.item.wire.rawFindingId),
      ),
      context: {
        workflowName: input.workflowName,
        stepName: input.parentStep.name,
        runId: input.runId,
        timestamp: input.timestamp,
      },
    });
    const settled = applyProvisionalSettlement(reconciled, settlement, input.timestamp);

    // A-3（codex ブロッカー2）: 添付判断は reconcile 後の台帳（= 保存結果）に
    // 対して open を再確認する。reconcile 前の fresh ledger で判定すると、同一
    // ラウンドの有効な confirmation が target を閉じた後に rejected observation が
    // resolved target へ添付され、既存 blocker が消えて代替 blocker も立たない
    // （gate 減少 — codex が直接実行で再現）。閉じていた場合は B3 の provisional へ
    // フォールバックする（矛盾する観測が同時に来ている保守側の着地）。
    const rejectedObservationAttachments: Array<{ targetFindingId: string; rawFindingId: string; reason: string }> = [];
    const rejectedObservationFallbackSpecs: ProvisionalFindingSpec[] = [];
    for (const pending of pendingRejectedObservations) {
      const reconciledTarget = settled.findings.find((finding) => finding.id === pending.targetFindingId);
      if (reconciledTarget !== undefined && reconciledTarget.status === 'open') {
        rejectedObservationAttachments.push({
          targetFindingId: pending.targetFindingId,
          rawFindingId: pending.item.wire.rawFindingId,
          reason: pending.reason,
        });
      } else {
        rejectedObservationFallbackSpecs.push({
          ...provisionalSpecForRaw({
            wire: pending.item.wire,
            canonical: pending.item.canonical,
            reason: `${pending.reason}; the target is no longer open after this round, so the observation is kept provisional instead`,
          }),
          kind: 'invalid-location-evidence',
          stableKey: computeProvisionalStableKey({
            reviewerStableKey: pending.item.canonical.reviewerStableKey,
            lineageKey: pending.item.canonical.lineageKey,
            provisionalKind: 'invalid-location-evidence',
          }),
        });
      }
    }
    for (const spec of rejectedObservationFallbackSpecs) {
      provisionalLandings.push({
        kind: spec.kind,
        stableKey: spec.stableKey,
        reason: spec.reason,
        sourceRawFindingIds: spec.sourceRawFindingIds,
      });
    }
    const withRejectedObservations = applyRejectedObservationAttachments(
      applyProvisionalFindingSpecsToLedger(settled, rejectedObservationFallbackSpecs, {
        workflowName: input.workflowName,
        stepName: input.parentStep.name,
        runId: input.runId,
        timestamp: input.timestamp,
      }),
      rejectedObservationAttachments,
      observation,
    );
    return markInterpretationsApplied(withRejectedObservations, interpretationResults, observation);
  });

  const reportNeeded = invalidAttempts.length > 0
    || staleRejections.length > 0
    || admissionRejections.length > 0
    || unsupportedRawFindingReports.length > 0
    || intake.overflowReports.length > 0
    || provisionalLandings.length > 0
    || intake.clarifications.length > 0
    || intake.rawNormalizations.length > 0;
  if (reportNeeded) {
    input.ledgerStore.saveManagerValidationReport({
      version: 1,
      runId: input.runId,
      stepName: input.parentStep.name,
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      ...(admissionRejections.length > 0 ? { rawAdmissionRejections: admissionRejections } : {}),
      ...(unsupportedRawFindingReports.length > 0 ? { unsupportedRawFindings: unsupportedRawFindingReports } : {}),
      ...(intake.overflowReports.length > 0 ? { reviewerOutputOverflows: intake.overflowReports } : {}),
      ...(provisionalLandings.length > 0 ? { provisionalLandings } : {}),
      ...(intake.rawNormalizations.length > 0 ? { rawNormalizations: intake.rawNormalizations } : {}),
      ...(intake.clarifications.length > 0 ? { relationClarifications: intake.clarifications } : {}),
      interpretationStats: ladder.stats,
      attempts: staleRejections.length > 0
        ? [
          ...invalidAttempts,
          {
            attempt: invalidAttempts.length + 1,
            managerOutput,
            validationErrors: staleRejections,
          },
        ]
        : invalidAttempts,
    });
  }
  log.info('Finding contract intake completed', {
    step: input.parentStep.name,
    rawFindings: intake.items.length,
    ambiguous: ladder.stats.ambiguousRawCount,
    managerCalls: ladder.stats.managerCalls,
    provisionalLandings: provisionalLandings.length,
    overflowReviewers: intake.overflowReports.length,
    staleConfirmations: staleRejections.length,
  });
  return {
    status: 'updated',
    ledgerPath: ledgerCopyPath,
    providerInfo,
    ledger: nextLedger,
  };
}

function emptyManagerOutput(): FindingManagerOutput {
  return {
    matches: [], newFindings: [], resolvedFindings: [], reopenedFindings: [],
    conflicts: [], resolvedConflicts: [], waivedFindings: [], disputeNotes: [],
    invalidatedFindings: [], duplicateFindings: [],
  };
}

/**
 * 出力のどこかに着地した raw finding id。重複 decision の不採用（1件目採用・
 * 2件目 "Duplicate decision" 拒否）で、既に着地済みの raw まで provisional に
 * 二重着地させないためのガード。
 */
function collectLandedRawIds(output: FindingManagerOutput): Set<string> {
  return new Set([
    ...output.matches.flatMap((match) => match.rawFindingIds),
    ...output.newFindings.flatMap((finding) => finding.rawFindingIds),
    ...output.resolvedFindings.flatMap((resolved) => resolved.rawFindingIds),
    ...output.reopenedFindings.flatMap((reopened) => reopened.rawFindingIds),
    ...output.conflicts.flatMap((conflict) => conflict.rawFindingIds),
  ]);
}

/** matches を findingId 単位で合併しつつ2出力を束ねる（ladder 出力は matches / newFindings / conflicts のみ）。 */
function mergeOutputs(base: FindingManagerOutput, extra: FindingManagerOutput): FindingManagerOutput {
  const matchesByFindingId = new Map(base.matches.map((match) => [match.findingId, { ...match, rawFindingIds: [...match.rawFindingIds] }]));
  for (const match of extra.matches) {
    const existing = matchesByFindingId.get(match.findingId);
    if (existing === undefined) {
      matchesByFindingId.set(match.findingId, { ...match, rawFindingIds: [...match.rawFindingIds] });
      continue;
    }
    for (const rawFindingId of match.rawFindingIds) {
      if (!existing.rawFindingIds.includes(rawFindingId)) {
        existing.rawFindingIds.push(rawFindingId);
      }
    }
  }
  return {
    ...base,
    matches: [...matchesByFindingId.values()],
    newFindings: [...base.newFindings, ...extra.newFindings],
    conflicts: [...base.conflicts, ...extra.conflicts],
  };
}

// ---------------------------------------------------------------------------
// CAS 適用（設計書 §6）
// ---------------------------------------------------------------------------

function applyPreconditionChecks(input: {
  output: FindingManagerOutput;
  captured: Map<string, CapturedFindingPrecondition>;
  freshLedger: FindingLedger;
  workflowName: string;
  callNamespace: string;
  parentStepName: string;
}): { output: FindingManagerOutput; provisionalSpecs: ProvisionalFindingSpec[]; staleDetails: string[] } {
  const provisionalSpecs: ProvisionalFindingSpec[] = [];
  const staleDetails: string[] = [];
  const extraConflicts: FindingManagerConflict[] = [];

  const specFor = (findingId: string, sourceRawFindingIds: string[], reason: string): void => {
    const fresh = input.freshLedger.findings.find((finding) => finding.id === findingId);
    provisionalSpecs.push(stalePreconditionSpec({
      workflowName: input.workflowName,
      callNamespace: input.callNamespace,
      parentStepName: input.parentStepName,
      targetFindingId: findingId,
      targetTitle: fresh?.title ?? findingId,
      ...(fresh?.location !== undefined ? { targetLocation: fresh.location } : {}),
      sourceRawFindingIds,
      reason,
    }));
    staleDetails.push(reason);
  };

  const resolvedFindings = input.output.resolvedFindings.filter((resolved) => {
    const captured = input.captured.get(resolved.findingId);
    if (captured === undefined) {
      // prompt 時に存在しなかった finding への確認は成立し得ない（stale 扱い）。
      specFor(resolved.findingId, [...resolved.rawFindingIds], `Confirmation targets finding "${resolved.findingId}" that did not exist when the prompt snapshot was taken`);
      return false;
    }
    const check = checkFindingPrecondition({
      captured,
      freshLedger: input.freshLedger,
      expectedStatuses: ['open'],
      idempotentResolvedEvidence: resolved.evidence,
    });
    switch (check.outcome) {
      case 'ok':
        return true;
      case 'idempotent-resolved':
        // 既に同じ evidence で resolved 済み → 冪等成功として黙って外す。
        return false;
      case 'post-prompt-persists':
        // prompt 後の persists 観測: target は open のまま、confirmation と
        // persists を参照する active conflict + provisional（§6 保存時規則）。
        extraConflicts.push({
          findingIds: [resolved.findingId],
          rawFindingIds: [...resolved.rawFindingIds],
          description: `Resolution confirmation for "${resolved.findingId}" conflicts with a persists observation saved after the confirmation was prompted`,
        });
        specFor(resolved.findingId, [...resolved.rawFindingIds], `Confirmation for "${resolved.findingId}" was not applied: ${check.detail}`);
        return false;
      case 'stale':
        specFor(resolved.findingId, [...resolved.rawFindingIds], `Confirmation for "${resolved.findingId}" was not applied (stale precondition): ${check.detail}`);
        return false;
    }
  });

  const checkClosingDecision = (
    findingId: string,
    sourceRawFindingIds: string[],
    expectedStatuses: ReadonlyArray<FindingLedgerEntry['status']>,
    action: string,
  ): boolean => {
    const captured = input.captured.get(findingId);
    if (captured === undefined) {
      specFor(findingId, sourceRawFindingIds, `${action} targets finding "${findingId}" that did not exist when the prompt snapshot was taken`);
      return false;
    }
    const check = checkFindingPrecondition({ captured, freshLedger: input.freshLedger, expectedStatuses });
    if (check.outcome === 'ok') {
      return true;
    }
    if (check.outcome === 'idempotent-resolved') {
      return false;
    }
    specFor(findingId, sourceRawFindingIds, `${action} for "${findingId}" was not applied (${check.outcome}): ${check.detail}`);
    return false;
  };

  const reopenedFindings = input.output.reopenedFindings.filter((reopened) => (
    checkClosingDecision(reopened.findingId, [...reopened.rawFindingIds], ['resolved', 'waived'], 'Reopen')
  ));
  const invalidatedFindings = input.output.invalidatedFindings.filter((invalidated) => (
    checkClosingDecision(invalidated.findingId, [], ['open'], 'Invalidate')
  ));
  const waivedFindings = input.output.waivedFindings.filter((waived) => (
    checkClosingDecision(waived.findingId, [], ['open'], 'Waive')
  ));
  const duplicateFindings = input.output.duplicateFindings.filter((duplicate) => {
    const allIds = [duplicate.canonicalFindingId, ...duplicate.duplicateFindingIds];
    return allIds.every((findingId) => (
      checkClosingDecision(findingId, [], ['open'], 'Supersede')
    ));
  });

  return {
    output: {
      ...input.output,
      resolvedFindings,
      reopenedFindings,
      invalidatedFindings,
      waivedFindings,
      duplicateFindings,
      conflicts: [...input.output.conflicts, ...extraConflicts],
    },
    provisionalSpecs,
    staleDetails,
  };
}

// ---------------------------------------------------------------------------
// clean 証拠による provisional の確定・解消（設計書 §8）
// ---------------------------------------------------------------------------

interface ProvisionalSettlement {
  output: FindingManagerOutput;
  /** clean new 証拠で confirmed へ昇格させる provisional finding id。 */
  promotedFindingIds: Set<string>;
  /** clean な決定的 same により解消する provisional finding id → 対応 target。 */
  resolvedByMapping: Map<string, string>;
}

/**
 * 完全 identity（正規化 path + title + description）。SameProof と同格の決定的
 * 同一性で、provisional の確定・解消の唯一の照合キー（codex B2: path+title だけの
 * 照合は別問題の provisional を誤確定できる）。
 */
function fullIdentityKeyOf(location: string | undefined, title: string | undefined, description: string | undefined): string {
  return JSON.stringify([
    parseFindingLocation(location)?.path ?? '',
    title === undefined ? '' : normalizeFindingText(title).toLowerCase(),
    description === undefined ? '' : normalizeFindingText(description).toLowerCase(),
  ]);
}

/**
 * clean な後続 raw だけが provisional を確定・解消できる（設計書 §8）。
 *
 * 確定・解消の根拠は次のどちらかに限る（codex B2）:
 * (a) 完全 identity（正規化 path+title+description）の一致 — SameProof と同格
 * (b) 保存済み lineageKey との一致（claim 形の再計算）
 * どちらも「対応が一意」の場合のみ採用する。複数候補・非一意は確定しない
 * （保守側 — provisional は開いたままで gate は閉じ続ける）。manager の意味判断
 * による match は決定的根拠にならない。
 *
 * 適用:
 * - clean new group が (a)/(b) で open provisional と一意対応 → 新規 finding を
 *   作らず provisional へ match として集約し、metadata を外す（昇格）。
 * - match 先が open provisional 自身で、その match に (a) を満たす clean raw が
 *   含まれる → metadata を外して通常 open へ昇格（外さないと同一観測の再来の
 *   たびに match だけ積まれて永久 provisional になる — codex B2）。
 * - clean raw が既存 target T へ完全 identity で一致し、同じ identity の open
 *   provisional P（P ≠ T、一意）がある → P を resolved にする（T を記録）。
 */
function settleProvisionalsWithCleanEvidence(input: {
  output: FindingManagerOutput;
  cleanRawIds: ReadonlySet<string>;
  wireById: ReadonlyMap<string, RawFinding>;
  freshLedger: FindingLedger;
}): ProvisionalSettlement {
  const openProvisionals = input.freshLedger.findings.filter(
    (finding) => finding.status === 'open' && finding.provisional !== undefined,
  );
  if (openProvisionals.length === 0) {
    return { output: input.output, promotedFindingIds: new Set(), resolvedByMapping: new Map() };
  }
  const provisionalById = new Map(openProvisionals.map((finding) => [finding.id, finding]));

  // 一意な identity / lineage だけを索引に載せる（重複 identity は候補から除外）。
  const identityCounts = new Map<string, number>();
  for (const finding of openProvisionals) {
    const key = fullIdentityKeyOf(finding.location, finding.title, finding.description);
    identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
  }
  const byUniqueIdentity = new Map<string, FindingLedgerEntry>();
  for (const finding of openProvisionals) {
    const key = fullIdentityKeyOf(finding.location, finding.title, finding.description);
    if (identityCounts.get(key) === 1) {
      byUniqueIdentity.set(key, finding);
    }
  }
  const lineageCounts = new Map<string, number>();
  for (const finding of openProvisionals) {
    const key = finding.provisional!.lineageKey;
    lineageCounts.set(key, (lineageCounts.get(key) ?? 0) + 1);
  }
  const byUniqueLineage = new Map<string, FindingLedgerEntry>();
  for (const finding of openProvisionals) {
    const key = finding.provisional!.lineageKey;
    if (lineageCounts.get(key) === 1) {
      byUniqueLineage.set(key, finding);
    }
  }

  const findProvisionalForCleanRaw = (wire: RawFinding): FindingLedgerEntry | undefined => {
    // (a) 完全 identity。
    const byIdentity = byUniqueIdentity.get(fullIdentityKeyOf(wire.location, wire.title, wire.description));
    if (byIdentity !== undefined) {
      return byIdentity;
    }
    // (b) 保存済み lineage（claim 形の再計算）。
    const claimLineage = computeLineageKey({
      ...(wire.location !== undefined ? { location: wire.location } : {}),
      title: wire.title,
      familyTag: wire.familyTag,
    });
    return byUniqueLineage.get(claimLineage);
  };

  // T 側の完全 identity 検査用（T 自身のフィールド + T に紐づく raw）。
  const freshRawsById = new Map(input.freshLedger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  const targetHasExactIdentity = (targetId: string, identity: string): boolean => {
    const target = input.freshLedger.findings.find((finding) => finding.id === targetId);
    if (target === undefined) {
      return false;
    }
    if (fullIdentityKeyOf(target.location, target.title, target.description) === identity) {
      return true;
    }
    return target.rawFindingIds.some((rawFindingId) => {
      const raw = freshRawsById.get(rawFindingId);
      return raw !== undefined && fullIdentityKeyOf(raw.location, raw.title, raw.description) === identity;
    });
  };

  const promotedFindingIds = new Set<string>();
  const resolvedByMapping = new Map<string, string>();
  const matches = input.output.matches.map((match) => ({ ...match, rawFindingIds: [...match.rawFindingIds] }));

  // 1) clean new group → provisional の一意対応を先に集計する（provisional 1件に
  //    複数 group が対応する非一意ケースは確定しない）。
  const groupCandidates = new Map<string, { provisional: FindingLedgerEntry; groups: Array<FindingManagerOutput['newFindings'][number]> }>();
  const unmatchedGroups: FindingManagerOutput['newFindings'] = [];
  for (const group of input.output.newFindings) {
    const cleanRawId = group.rawFindingIds.find((rawFindingId) => input.cleanRawIds.has(rawFindingId));
    const wire = cleanRawId !== undefined ? input.wireById.get(cleanRawId) : undefined;
    const provisional = wire !== undefined ? findProvisionalForCleanRaw(wire) : undefined;
    if (provisional === undefined) {
      unmatchedGroups.push(group);
      continue;
    }
    const entry = groupCandidates.get(provisional.id) ?? { provisional, groups: [] };
    entry.groups.push(group);
    groupCandidates.set(provisional.id, entry);
  }
  const newFindings: FindingManagerOutput['newFindings'] = [...unmatchedGroups];
  for (const { provisional, groups } of groupCandidates.values()) {
    if (groups.length !== 1) {
      // 非一意対応: 確定しない（group は通常の new として立ち、provisional は
      // 開いたまま — 誤確定よりも二重 blocker を選ぶ保守側）。
      newFindings.push(...groups);
      continue;
    }
    const group = groups[0]!;
    promotedFindingIds.add(provisional.id);
    const existing = matches.find((match) => match.findingId === provisional.id);
    if (existing !== undefined) {
      for (const rawFindingId of group.rawFindingIds) {
        if (!existing.rawFindingIds.includes(rawFindingId)) {
          existing.rawFindingIds.push(rawFindingId);
        }
      }
    } else {
      matches.push({
        findingId: provisional.id,
        rawFindingIds: [...group.rawFindingIds],
        evidence: 'Clean review evidence deterministically confirmed the provisional observation as a real finding',
      });
    }
  }

  // 2) match 先が provisional 自身: 完全 identity の clean raw を含むなら昇格。
  for (const match of matches) {
    const provisional = provisionalById.get(match.findingId);
    if (provisional === undefined || promotedFindingIds.has(provisional.id)) {
      continue;
    }
    const provisionalIdentity = fullIdentityKeyOf(provisional.location, provisional.title, provisional.description);
    const hasExactCleanRaw = match.rawFindingIds.some((rawFindingId) => {
      if (!input.cleanRawIds.has(rawFindingId)) {
        return false;
      }
      const wire = input.wireById.get(rawFindingId);
      return wire !== undefined
        && fullIdentityKeyOf(wire.location, wire.title, wire.description) === provisionalIdentity;
    });
    if (hasExactCleanRaw) {
      promotedFindingIds.add(provisional.id);
    }
  }

  // 3) clean raw が別 target T へ完全 identity で一致した場合のみ、同 identity の
  //    provisional を resolved にする（manager の意味 match は根拠にしない）。
  for (const match of matches) {
    if (provisionalById.has(match.findingId)) {
      continue;
    }
    for (const rawFindingId of match.rawFindingIds) {
      if (!input.cleanRawIds.has(rawFindingId)) {
        continue;
      }
      const wire = input.wireById.get(rawFindingId);
      if (wire === undefined) {
        continue;
      }
      const identity = fullIdentityKeyOf(wire.location, wire.title, wire.description);
      const provisional = byUniqueIdentity.get(identity);
      if (provisional === undefined || provisional.id === match.findingId || promotedFindingIds.has(provisional.id)) {
        continue;
      }
      if (targetHasExactIdentity(match.findingId, identity)) {
        resolvedByMapping.set(provisional.id, match.findingId);
      }
    }
  }

  return {
    output: { ...input.output, newFindings, matches },
    promotedFindingIds,
    resolvedByMapping,
  };
}

/**
 * A-3: 証跡不成立の persists 再観測を open target の rejectedObservations へ
 * 監査添付する。canonical evidence / rawFindingIds / revision / status には
 * 一切触れない（evidence hash の入力にも含まれない — 攻撃4の再開口禁止）。
 * target が既に gate を塞いでいるため、観測は消えずゲートも開かない。
 */
function applyRejectedObservationAttachments(
  ledger: FindingLedger,
  attachments: ReadonlyArray<{ targetFindingId: string; rawFindingId: string; reason: string }>,
  observation: FindingObservation,
): FindingLedger {
  if (attachments.length === 0) {
    return ledger;
  }
  const byTarget = new Map<string, Array<{ rawFindingId: string; reason: string }>>();
  for (const attachment of attachments) {
    const list = byTarget.get(attachment.targetFindingId) ?? [];
    list.push({ rawFindingId: attachment.rawFindingId, reason: attachment.reason });
    byTarget.set(attachment.targetFindingId, list);
  }
  return {
    ...ledger,
    findings: ledger.findings.map((finding) => {
      const additions = byTarget.get(finding.id);
      if (additions === undefined) {
        return finding;
      }
      const existing = finding.rejectedObservations ?? [];
      const seen = new Set(existing.map((entry) => entry.rawFindingId));
      const appended = additions
        .filter((entry) => !seen.has(entry.rawFindingId))
        .map((entry) => ({ rawFindingId: entry.rawFindingId, reason: entry.reason, observedAt: observation }));
      if (appended.length === 0) {
        return finding;
      }
      return { ...finding, rejectedObservations: [...existing, ...appended] };
    }),
  };
}

/** reconcile 後の台帳へ provisional の昇格（metadata 除去）と解消を反映する。 */
function applyProvisionalSettlement(
  ledger: FindingLedger,
  settlement: ProvisionalSettlement,
  timestamp: string,
): FindingLedger {
  if (settlement.promotedFindingIds.size === 0 && settlement.resolvedByMapping.size === 0) {
    return ledger;
  }
  return {
    ...ledger,
    findings: ledger.findings.map((finding) => {
      if (settlement.promotedFindingIds.has(finding.id) && finding.provisional !== undefined) {
        const promoted = { ...finding };
        delete promoted.provisional;
        return promoted;
      }
      const mappedTarget = settlement.resolvedByMapping.get(finding.id);
      if (mappedTarget !== undefined && finding.status === 'open' && finding.provisional !== undefined) {
        return {
          ...finding,
          status: 'resolved' as const,
          lifecycle: 'resolved' as const,
          resolvedAt: timestamp,
          resolvedEvidence: `Deterministically mapped to finding "${mappedTarget}" by clean review evidence`,
          revision: (finding.revision ?? 1) + 1,
        };
      }
      return finding;
    }),
  };
}
