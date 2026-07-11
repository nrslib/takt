import { executeAgent } from '../../../agents/agent-usecases.js';
import type { AgentResponse, AgentWorkflowStep, FindingContractConfig, WorkflowConfig, WorkflowStep } from '../../models/types.js';
import {
  RawFindingsOutputJsonSchema,
  parseFindingManagerDecisions,
  parseReviewerRawFindings,
} from './schemas.js';
import { buildFindingManagerStep } from './manager-step.js';
import { reconcileFindingLedger } from './reconciler.js';
import { classifyRawFindingsMechanically, effectiveRawFindingRelation } from './mechanical-classification.js';
import {
  assembleManagerOutput,
  flattenManagerOutputToDecisions,
  type AssembleManagerOutputResult,
  type RejectedConflictDecision,
  type RejectedDisputeDecision,
  type RejectedDuplicateDecision,
  type RejectedInvalidateDecision,
  type RejectedRawDecision,
  type UnsupportedRawDecision,
} from './decision-assembly.js';
import { validateLocationAdmission } from './admission-validation.js';
import { partitionRelationCoherentRawFindings } from './relation-coherence.js';
import { normalizeFindingText, parseFindingLocation } from './location.js';
import type {
  DroppedExplicitReferenceRawFindingReport as DroppedExplicitReferenceRawFinding,
  FindingLedgerStore,
  FindingManagerValidationAttemptReport,
  RawAdmissionRejectionReport,
  UnsupportedRawFindingReport,
} from './store.js';
import type { FindingLedger, FindingLedgerEntry, FindingManagerDecisions, FindingManagerOutput, RawFinding } from './types.js';
import {
  hasDisputeClaimsHeading,
  validateFindingManagerOutput,
  type FindingManagerValidationResult,
} from './manager-output-validation.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import type { StepProviderInfo } from '../types.js';
import { renderFencedJsonBlock } from '../instruction/fenced-json.js';
import { loadTemplate } from '../../../shared/prompts/index.js';
import { isWorkflowCallStep } from '../step-kind.js';

export interface FindingManagerSubStepResult {
  subStep: WorkflowStep;
  response: AgentResponse;
}

interface RunFindingManagerForStepInput {
  contract: FindingContractConfig;
  /**
   * Working directory the reviewed code lives in. Used for the deterministic
   * "raw admission validation" (item 1 of the convergence design): a raw
   * finding's / existing finding's `location` is only trusted if it resolves
   * to a real file (and, when a line is given, a line within range) under this
   * directory. Threaded in here (rather than resolved from FindingLedgerStore's
   * projectCwd) because the store's base is the repo root for ledger file
   * placement, while the reviewed code — and thus the paths raw findings cite —
   * lives under the step's actual cwd (which differs from projectCwd inside a
   * worktree-isolated task).
   */
  cwd: string;
  /**
   * manager の provider/model 未指定時の fallback。優先順位は
   * finding_contract.manager の直接指定 → workflow provider/model →
   * provider_routing.personas / persona_providers（buildFindingManagerStep 参照）。
   */
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  ledgerStore: FindingLedgerStore;
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput'>;
  parentStep: WorkflowStep;
  stepIteration: number;
  /**
   * レビュアー1件ごとの結果。並列ステップでは複数要素、単独ステップでは
   * 要素1件（そのステップ自身）を渡す。extractStructuredRawFindings はどちらも
   * 同じ形で扱う。
   */
  subResults: FindingManagerSubStepResult[];
  workflowName: string;
  runId: string;
  /**
   * raw finding id 衝突対策の呼び出し名前空間。workflow_call の子エンジンは
   * runId（= 親の runPaths.slug）をそのまま継承するため、親の parallel から
   * 同じ子ワークフローを複数同時に呼ぶと2子の runId が一致してしまう。
   * トップレベルの走行では空文字列（既存の raw finding id の形を変えない）。
   */
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
  schema: RawFindingsOutputJsonSchema,
} as const;
const FINDING_MANAGER_MAX_SEMANTIC_RETRIES = 1;

export type FindingManagerRunResult =
  | { status: 'updated'; ledgerPath: string; providerInfo: StepProviderInfo; ledger: FindingLedger }
  | {
    status: 'invalid_manager_output';
    ledgerPath: string;
    providerInfo: StepProviderInfo;
    reportPath: string;
    errors: string[];
    retryCount: number;
  };

interface ValidatedManagerOutputRun {
  managerOutput: FindingManagerOutput;
  validation: FindingManagerValidationResult;
  invalidAttempts: FindingManagerValidationAttemptReport[];
  /** Raw findings decided 'unsupported' this round (see UnsupportedRawDecision). Excluded from the "unmentioned raw -> new finding" fallback at save time. */
  unsupportedRawDecisions: UnsupportedRawDecision[];
  /** Explicit-reference raws (relation persists/reopened) whose rejected decisions were dropped instead of forced to new (see forceUnresolvedRawDecisionsAsNew). Also excluded from the unmentioned fallback. */
  droppedExplicitReferenceRaws: DroppedExplicitReferenceRawFinding[];
}

function normalizeRawFindingId(input: {
  runId: string;
  stepIteration: number;
  parentStepName: string;
  subStepName: string;
  rawFindingId: string;
  callNamespace: string;
}): string {
  return [
    input.runId,
    // callNamespace は workflow_call の呼び出し元ステップ名を積み上げた文字列。
    // 親の parallel から同じ子ワークフローを複数同時に呼ぶと、子ごとの
    // runId/parentStepName/stepIteration/subStepName/rawFindingId が全て
    // 一致し得るため、呼び出し元を区別するこの要素が無いと衝突する
    // （実測: WorkflowCallExecutor が子へ reportDirName=親の runPaths.slug を
    // 渡すため、2子の runId は常に同一）。トップレベルの走行では空文字列
    // なので、この要素は join から除外され、既存の id 形式のまま。
    ...(input.callNamespace ? [input.callNamespace] : []),
    input.parentStepName,
    String(input.stepIteration),
    input.subStepName,
    input.rawFindingId,
  ].join(':');
}

function extractStructuredRawFindings(input: {
  subResults: readonly FindingManagerSubStepResult[];
  runId: string;
  stepIteration: number;
  parentStepName: string;
  callNamespace: string;
}): RawFinding[] {
  return input.subResults
    // workflow_call サブステップは raw findings を返さない（AgentResponse に
    // structuredOutput を持たない）。子ワークフローが自前の Finding Contract
    // （継承 or 自前）を持つ場合、指摘は子の中で既に台帳へ取り込まれている
    // 前提のため、ここでは "取り込み済み" として除外する。除外しないと
    // 「raw findings が無い」という別の欠落と区別できず、fail-fast エラーに
    // なってしまう（現状の builtin ワークフローに該当構成は無いが、将来
    // parallel の子に workflow_call を混ぜても壊れないようにする）。
    .filter((result) => !isWorkflowCallStep(result.subStep))
    .flatMap((result) => {
      const structuredOutput = result.response.structuredOutput;
      // raw findings は Finding Contract の契約入力。欠落や不正 shape を
      // 空扱いすると台帳に指摘が残らず findings.open.count == 0 のゲートが
      // 誤って通るため、黙って捨てず fail-fast する。
      if (structuredOutput === undefined) {
        throw new Error(
          `Finding contract reviewer "${result.subStep.name}" returned no structured output; raw findings are required`,
        );
      }
      if (!Array.isArray(structuredOutput.rawFindings)) {
        throw new Error(
          `Finding contract reviewer "${result.subStep.name}" returned structured output without a rawFindings array`,
        );
      }
      return parseReviewerRawFindings(structuredOutput.rawFindings).map((rawFinding) => ({
        ...rawFinding,
        reviewer: result.subStep.name,
        rawFindingId: normalizeRawFindingId({
          runId: input.runId,
          parentStepName: input.parentStepName,
          stepIteration: input.stepIteration,
          subStepName: result.subStep.name,
          rawFindingId: rawFinding.rawFindingId,
          callNamespace: input.callNamespace,
        }),
        stepName: result.subStep.name,
      }));
    });
}

/**
 * raw finding admission validation（item 1 of the convergence design）。
 * cwd を持つこの経路（manager-runner.ts の raw 受け入れ経路。契約上 cwd に
 * アクセスできるのはここだけ — mechanical classification / decision-assembly /
 * manager-output-validation は fs アクセスの無い純粋関数として保つ設計）で、
 * location を伴う raw finding だけを対象に決定的検証を行う。落ちた raw は
 * ここで完全に除外し、以降の一切の処理（機械分類・manager 判断・reconcile の
 * 「未言及 raw → new finding」フォールバック）に混入させない。location の無い
 * raw finding（該当なし）は無条件で通す。
 */
function partitionAdmissibleRawFindings(input: {
  cwd: string;
  rawFindings: readonly RawFinding[];
}): { admitted: RawFinding[]; rejected: RawAdmissionRejectionReport[] } {
  const admitted: RawFinding[] = [];
  const rejected: RawAdmissionRejectionReport[] = [];
  for (const raw of input.rawFindings) {
    if (raw.location === undefined) {
      admitted.push(raw);
      continue;
    }
    const result = validateLocationAdmission(input.cwd, raw.location);
    if (result.ok) {
      admitted.push(raw);
    } else {
      rejected.push({ rawFindingId: raw.rawFindingId, location: raw.location, reason: result.reason ?? 'invalid location' });
    }
  }
  return { admitted, rejected };
}

/**
 * 既存台帳の open finding のうち、自身の location が決定的検証に落ちるものを
 * invalidate 候補として洗い出す。manager の invalidateDecisions は必ずこの
 * 集合からしか選べない（decision-assembly.ts の assembleInvalidateDecisions
 * 参照）。LLM の主張だけで invalidate を成立させない、という設計上の要求は
 * 「候補集合そのものを engine が決める」ことで満たす。
 */
function computeInvalidLocationCandidates(
  cwd: string,
  findings: readonly FindingLedgerEntry[],
): Map<string, string> {
  const candidates = new Map<string, string>();
  for (const finding of findings) {
    if (finding.status !== 'open' || finding.location === undefined) {
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
 * manager へ渡す台帳ビューを構築する。
 * 解消済み・免除済みの指摘は照合キー（id / status / title / location）だけの
 * スタブに落とし、本文と raw findings 全文は open な指摘と、residual raws が
 * 参照する指摘（reopen 候補）だけに載せる。台帳肥大による manager の
 * トークン消費を抑えるため。
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

/** Backtick-quoted spans and dotted/camelCase/snake_case identifiers — a conservative proxy for "code symbol" without a real parser. Used only to widen the manager's candidate set (item 5); never used to auto-merge. */
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

/**
 * フル詳細候補の選定。familyTag と行番号は識別の根拠にしない設計（item 2）に
 * 合わせ、次の集合だけを候補にする: 明示 targetFindingId の対象 / 正規化 path が
 * 同じ open finding / 正規化 title が同じ open finding / raw のタイトル・
 * 説明から抽出できる symbol を共有する open finding / active conflict が
 * 参照する finding。familyTag 一致だけの候補提示は行わない（同一性の最終判断は
 * manager の意味判断へ）。
 */
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

/**
 * 不採用になった決定だけを列挙し、その項目だけの再判断を求める。全体を作り直させると
 * 「最終結果を自力で組み立てる」問題に逆戻りするため、対象を不採用分に絞る。
 */
function buildManagerRetryInstruction(input: {
  originalInstruction: string;
  residualRawFindings: readonly RawFinding[];
  rejectedRawDecisions: readonly RejectedRawDecision[];
  rejectedDisputeDecisions: readonly RejectedDisputeDecision[];
  rejectedConflictDecisions: readonly RejectedConflictDecision[];
  rejectedInvalidateDecisions: readonly RejectedInvalidateDecision[];
  rejectedDuplicateDecisions: readonly RejectedDuplicateDecision[];
}): string {
  const rawById = new Map(input.residualRawFindings.map((raw) => [raw.rawFindingId, raw]));
  const rejectedRawBlock = input.rejectedRawDecisions.map((rejected) => [
    `- rawFindingId: ${rejected.rawFindingId}`,
    `  previous decision: ${rejected.decision}`,
    `  rejected because: ${rejected.reason}`,
    `  raw finding: ${JSON.stringify(rawById.get(rejected.rawFindingId))}`,
  ].join('\n'));
  const rejectedDisputeBlock = input.rejectedDisputeDecisions.map((rejected) => [
    `- findingId: ${rejected.findingId}`,
    `  previous decision: ${rejected.decision}`,
    `  rejected because: ${rejected.reason}`,
  ].join('\n'));
  const rejectedConflictBlock = input.rejectedConflictDecisions.map((rejected) => [
    `- conflictId: ${rejected.conflictId}`,
    `  previous decision: ${rejected.decision}`,
    `  rejected because: ${rejected.reason}`,
  ].join('\n'));
  const rejectedInvalidateBlock = input.rejectedInvalidateDecisions.map((rejected) => [
    `- findingId: ${rejected.findingId}`,
    `  rejected because: ${rejected.reason}`,
  ].join('\n'));
  const rejectedDuplicateBlock = input.rejectedDuplicateDecisions.map((rejected) => [
    `- canonicalFindingId: ${rejected.canonicalFindingId}`,
    `  duplicateFindingIds: ${rejected.duplicateFindingIds.join(', ')}`,
    `  rejected because: ${rejected.reason}`,
  ].join('\n'));

  return [
    input.originalInstruction,
    '',
    '## Some previous decisions were rejected',
    'The engine rejected the decisions listed below because they violated ledger invariants. Return decisions ONLY for these items (same rawDecisions/disputeDecisions/conflictDecisions/invalidateDecisions/duplicateDecisions shape as before). Do not repeat decisions for items not listed here; those were already accepted.',
    ...(rejectedRawBlock.length > 0 ? ['', '### Rejected raw decisions', ...rejectedRawBlock] : []),
    ...(rejectedDisputeBlock.length > 0 ? ['', '### Rejected dispute decisions', ...rejectedDisputeBlock] : []),
    ...(rejectedConflictBlock.length > 0 ? ['', '### Rejected conflict decisions', ...rejectedConflictBlock] : []),
    ...(rejectedInvalidateBlock.length > 0 ? ['', '### Rejected invalidate decisions', ...rejectedInvalidateBlock] : []),
    ...(rejectedDuplicateBlock.length > 0 ? ['', '### Rejected duplicate decisions', ...rejectedDuplicateBlock] : []),
  ].join('\n');
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
}): Promise<FindingManagerDecisions> {
  const phase1Instruction = input.stepExecutor.buildPhase1Instruction(input.instruction, input.managerStep);
  const agentOptions = buildManagerAgentOptions(input.optionsBuilder, input.managerStep);
  const rawResponse = await executeAgent(input.managerStep.persona, phase1Instruction, agentOptions);
  const response = input.stepExecutor.normalizeStructuredOutput(input.managerStep, rawResponse);
  return parseManagerDecisions(response);
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

function hasAnyRejection(assembly: AssembleManagerOutputResult): boolean {
  // rejectedCarriedConflicts を含めても再問い合わせの発火条件は変わらない:
  // carriedFindingOnlyConflicts を渡すのは保存直前の freshAssembly だけで、
  // そこは retry しない経路（staleRejections として検証レポートに残すだけ）。
  // 初回組み立て（firstAssembly / secondAssembly）は carried を渡さないため、
  // この項が true になることはない。
  return assembly.rejectedRawDecisions.length > 0
    || assembly.rejectedDisputeDecisions.length > 0
    || assembly.rejectedConflictDecisions.length > 0
    || assembly.rejectedCarriedConflicts.length > 0
    || assembly.rejectedInvalidateDecisions.length > 0
    || assembly.rejectedDuplicateDecisions.length > 0;
}

/** ラウンド1の採用分（不採用でなかった決定）だけを残す。ラウンド2の再問い合わせ結果と合成するために使う。 */
function keepAcceptedDecisions(
  decisions: FindingManagerDecisions,
  assembly: AssembleManagerOutputResult,
): FindingManagerDecisions {
  const rejectedRawIds = new Set(assembly.rejectedRawDecisions.map((r) => r.rawFindingId));
  const rejectedDisputeIds = new Set(assembly.rejectedDisputeDecisions.map((r) => r.findingId));
  const rejectedConflictIds = new Set(assembly.rejectedConflictDecisions.map((r) => r.conflictId));
  const rejectedInvalidateIds = new Set(assembly.rejectedInvalidateDecisions.map((r) => r.findingId));
  const rejectedDuplicateCanonicalIds = new Set(assembly.rejectedDuplicateDecisions.map((r) => r.canonicalFindingId));
  return {
    rawDecisions: decisions.rawDecisions.filter((d) => !rejectedRawIds.has(d.rawFindingId)),
    disputeDecisions: decisions.disputeDecisions.filter((d) => !rejectedDisputeIds.has(d.findingId)),
    conflictDecisions: decisions.conflictDecisions.filter((d) => !rejectedConflictIds.has(d.conflictId)),
    invalidateDecisions: decisions.invalidateDecisions.filter((d) => !rejectedInvalidateIds.has(d.findingId)),
    duplicateDecisions: decisions.duplicateDecisions.filter((d) => !rejectedDuplicateCanonicalIds.has(d.canonicalFindingId)),
  };
}

/**
 * 再問い合わせ後もなお不採用の raw decision は、情報を捨てないため new finding として
 * 扱う（機械分類・reconciler の「未言及 raw は new」フォールバックと同じ思想）。
 * dispute/conflict の不採用分は、対象が既存の台帳エントリ（対象は変化しない）なので
 * 単に反映しない（何もしない = 現状維持）。
 *
 * ただし次の2種類は new に倒せない:
 * - kind が resolution_confirmation の raw。manager-output-validation.ts の
 *   validateConfirmationRefsOnlyInResolutions が「Resolution confirmation ...
 *   cannot be cited as issue evidence」で newFindings への混入を拒否するため、
 *   ここで forcedNewFindings に含めると最終検証で invalid_manager_output に落ち、
 *   再問い合わせで直った他の決定まで道連れで台帳に反映されなくなる。
 * - relation が persists/reopened の raw（既存 finding への明示参照）。強制 new
 *   化すると、根拠不成立の再報告が新規 finding として台帳に混入する
 *   （codex 再現ブロッカー B2 — assembleRawDecisions が manager の 'new' 判断を
 *   reject するのと同じ理由で、エンジンのフォールバックにも new は許されない）。
 *
 * どちらも採用せず、droppedExplicitReferenceRaws として呼び出し元へ返す
 * （監査記録: saveManagerValidationReport の droppedExplicitReferenceRawFindings、
 * および reconciler の「未言及 raw → new」フォールバックからの除外に使う）。
 */
function forceUnresolvedRawDecisionsAsNew(
  assembly: AssembleManagerOutputResult,
  residualRawFindings: readonly RawFinding[],
): { output: FindingManagerOutput; droppedExplicitReferenceRaws: DroppedExplicitReferenceRawFinding[] } {
  const rawById = new Map(residualRawFindings.map((raw) => [raw.rawFindingId, raw]));
  const forcedNewFindings: FindingManagerOutput['newFindings'] = [];
  const droppedExplicitReferenceRaws: DroppedExplicitReferenceRawFinding[] = [];
  for (const rejected of assembly.rejectedRawDecisions) {
    const raw = rawById.get(rejected.rawFindingId);
    if (raw === undefined || raw.kind === 'resolution_confirmation') {
      continue;
    }
    const relation = effectiveRawFindingRelation(raw);
    if (relation === 'persists' || relation === 'reopened') {
      droppedExplicitReferenceRaws.push({
        rawFindingId: raw.rawFindingId,
        relation,
        ...(raw.targetFindingId !== undefined ? { targetFindingId: raw.targetFindingId } : {}),
        reason: `Rejected decision (${rejected.decision}: ${rejected.reason}) was not forced to a new finding because the raw finding explicitly references an existing finding`,
      });
      continue;
    }
    forcedNewFindings.push({ rawFindingIds: [raw.rawFindingId], title: raw.title, severity: raw.severity });
  }
  return {
    output: {
      ...assembly.output,
      newFindings: [...assembly.output.newFindings, ...forcedNewFindings],
    },
    droppedExplicitReferenceRaws,
  };
}

async function runManagerWithSemanticRetry(input: {
  previousLedger: FindingLedger;
  rawFindings: RawFinding[];
  residualRawFindings: RawFinding[];
  mechanicalOutput: FindingManagerOutput;
  invalidLocationCandidateFindingIds: ReadonlySet<string>;
  managerStep: AgentWorkflowStep;
  instruction: string;
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput'>;
  priorStepResponseText?: string;
}): Promise<ValidatedManagerOutputRun> {
  const firstDecisions = await runManagerAttempt({
    managerStep: input.managerStep,
    instruction: input.instruction,
    optionsBuilder: input.optionsBuilder,
    stepExecutor: input.stepExecutor,
  });
  const firstAssembly = assembleManagerOutput({
    previousLedger: input.previousLedger,
    residualRawFindings: input.residualRawFindings,
    decisions: firstDecisions,
    priorStepResponseText: input.priorStepResponseText,
    // manager の応答そのものの検証: 残余 raw finding のうち decision が
    // 1件も無いものを rejection にする（manager が rawDecisions: [] を返す等、
    // 契約を守らなかったケースを再問い合わせに乗せるため）。
    checkMissingDecisions: true,
    // mechanicalOutput を渡し、merge → canonicalize 済みの出力を材料に
    // waive/note・conflict の裁定まで assembleManagerOutput の中で完結させる
    // （呼び出し元で別途 mergeFindingManagerOutputs するとその裁定が
    // 機械分類の resolvedFindings を知らないまま行われてしまう）。
    mechanicalOutput: input.mechanicalOutput,
    invalidLocationCandidateFindingIds: input.invalidLocationCandidateFindingIds,
  });

  const finalizeValidation = (managerOutput: FindingManagerOutput): FindingManagerValidationResult => (
    // 組み立て時の不変条件チェックを通過していれば通常はここも通る。ここは
    // decision-assembly でカバーしきれない残余ケースのための最終防衛線。
    validateFindingManagerOutput({
      previousLedger: input.previousLedger,
      rawFindings: input.rawFindings,
      managerOutput,
      priorStepResponseText: input.priorStepResponseText,
    })
  );

  if (!hasAnyRejection(firstAssembly)) {
    const managerOutput = firstAssembly.output;
    return {
      managerOutput,
      validation: finalizeValidation(managerOutput),
      invalidAttempts: [],
      unsupportedRawDecisions: firstAssembly.unsupportedRawDecisions,
      droppedExplicitReferenceRaws: [],
    };
  }

  const firstAttempt: FindingManagerValidationAttemptReport = {
    attempt: 1,
    managerOutput: firstDecisions,
    validationErrors: describeRejections(firstAssembly),
  };

  const retryDecisions = await runManagerAttempt({
    managerStep: input.managerStep,
    instruction: buildManagerRetryInstruction({
      originalInstruction: input.instruction,
      residualRawFindings: input.residualRawFindings,
      rejectedRawDecisions: firstAssembly.rejectedRawDecisions,
      rejectedDisputeDecisions: firstAssembly.rejectedDisputeDecisions,
      rejectedConflictDecisions: firstAssembly.rejectedConflictDecisions,
      rejectedInvalidateDecisions: firstAssembly.rejectedInvalidateDecisions,
      rejectedDuplicateDecisions: firstAssembly.rejectedDuplicateDecisions,
    }),
    optionsBuilder: input.optionsBuilder,
    stepExecutor: input.stepExecutor,
  });
  const acceptedFirstDecisions = keepAcceptedDecisions(firstDecisions, firstAssembly);
  const combinedDecisions: FindingManagerDecisions = {
    rawDecisions: [...acceptedFirstDecisions.rawDecisions, ...retryDecisions.rawDecisions],
    disputeDecisions: [...acceptedFirstDecisions.disputeDecisions, ...retryDecisions.disputeDecisions],
    conflictDecisions: [...acceptedFirstDecisions.conflictDecisions, ...retryDecisions.conflictDecisions],
    invalidateDecisions: [...acceptedFirstDecisions.invalidateDecisions, ...retryDecisions.invalidateDecisions],
    duplicateDecisions: [...acceptedFirstDecisions.duplicateDecisions, ...retryDecisions.duplicateDecisions],
  };
  const secondAssembly = assembleManagerOutput({
    previousLedger: input.previousLedger,
    residualRawFindings: input.residualRawFindings,
    decisions: combinedDecisions,
    priorStepResponseText: input.priorStepResponseText,
    // 再問い合わせ後もなお欠落したままの raw を rejection として検出する
    // （firstAssembly と同じ理由）。stillRejected → forceUnresolvedRawDecisionsAsNew
    // の既存経路に自然に乗る。
    checkMissingDecisions: true,
    mechanicalOutput: input.mechanicalOutput,
    invalidLocationCandidateFindingIds: input.invalidLocationCandidateFindingIds,
  });

  const stillRejected = hasAnyRejection(secondAssembly);
  const forced = stillRejected
    ? forceUnresolvedRawDecisionsAsNew(secondAssembly, input.residualRawFindings)
    : { output: secondAssembly.output, droppedExplicitReferenceRaws: [] };
  const managerOutput = forced.output;

  return {
    managerOutput,
    validation: finalizeValidation(managerOutput),
    invalidAttempts: stillRejected
      ? [
        firstAttempt,
        {
          attempt: 1 + FINDING_MANAGER_MAX_SEMANTIC_RETRIES,
          managerOutput: retryDecisions,
          validationErrors: describeRejections(secondAssembly),
        },
      ]
      : [firstAttempt],
    unsupportedRawDecisions: secondAssembly.unsupportedRawDecisions,
    droppedExplicitReferenceRaws: forced.droppedExplicitReferenceRaws,
  };
}

export async function runFindingManagerForStep(
  input: RunFindingManagerForStepInput,
): Promise<FindingManagerRunResult> {
  const previousLedger = input.ledgerStore.loadLedger();
  const ledgerCopyPath = input.ledgerCopyPath ?? input.ledgerStore.createRunCopy();
  const allRawFindings = extractStructuredRawFindings({
    subResults: input.subResults,
    runId: input.runId,
    stepIteration: input.stepIteration,
    parentStepName: input.parentStep.name,
    callNamespace: input.callNamespace,
  });
  // raw admission validation（item 1）: location を伴う raw finding のうち、
  // path が存在しない・行番号がファイル範囲外のものは以降の一切の処理から
  // 除外する（機械分類にも manager にも渡さない。新規 finding の根拠にも
  // 既存 finding への resolution_confirmation/persists の証拠にもできない）。
  // 監査目的で元の全量は saveRawFindings に、不採用理由は検証レポートに残す。
  const admission = partitionAdmissibleRawFindings({ cwd: input.cwd, rawFindings: allRawFindings });
  // relation coherence（設計項目3の残り）: relation=new なのに正規化 path+title が
  // 既存 open finding と一致する raw は、レビュア側の再生成（runner の
  // regenerateIncoherentNewRawRelationsOnce）を経てもなお不整合だったものなので、
  // new として採用しない。admission 落ちと同様に以降の一切の処理から除外し、
  // Phase A の unsupported 経路（UnsupportedRawFindingReport）で監査記録に残す。
  const relationCoherence = partitionRelationCoherentRawFindings({
    previousLedger,
    rawFindings: admission.admitted,
  });
  const rawFindings = relationCoherence.admitted;
  const rawFindingsPath = input.ledgerStore.saveRawFindings(input.runId, input.parentStep.name, allRawFindings);
  const managerStep = buildFindingManagerStep({
    contract: input.contract,
    workflowProvider: input.workflowProvider,
    workflowModel: input.workflowModel,
  });
  const providerInfo = input.optionsBuilder.resolveStepProviderModel(managerStep);

  // 既存台帳の open finding のうち、自身の location が決定的検証に落ちるものを
  // invalidate 候補として洗い出す。manager の invalidateDecisions はこの集合
  // からしか選べない（LLM の主張だけでは invalidate を成立させない）。
  const invalidLocationCandidates = computeInvalidLocationCandidates(input.cwd, previousLedger.findings);
  const invalidLocationCandidateFindingIds = new Set(invalidLocationCandidates.keys());

  // フィールド等価で確定する raw（完全同一・明示参照・解消確認）はコードで
  // 分類し、判断が必要な残りだけを LLM manager に渡す。LLM を呼ばないのは
  // 「残りゼロ・prior step response に異議申告（Disputed Findings 見出し）なし・
  // 裁定待ちの active conflict なし・invalidate 候補なし」が全て揃う場合だけ。
  // waiver は見出し配下の claim からしか成立しないため、見出しの無い応答は
  // 判断材料を含まない。
  const mechanical = classifyRawFindingsMechanically({ previousLedger, rawFindings });
  const hasDisputeClaims = hasDisputeClaimsHeading(input.priorStepResponseText);
  const hasActiveConflict = previousLedger.conflicts.some((conflict) => conflict.status === 'active');
  const needsAgent = mechanical.residualRawFindings.length > 0
    || hasDisputeClaims
    || hasActiveConflict
    || invalidLocationCandidateFindingIds.size > 0;

  let managerOutput: FindingManagerOutput;
  let validation: FindingManagerValidationResult;
  let invalidAttempts: FindingManagerValidationAttemptReport[];
  let unsupportedRawDecisions: UnsupportedRawDecision[];
  let droppedExplicitReferenceRaws: DroppedExplicitReferenceRawFinding[];
  if (needsAgent) {
    const instruction = buildManagerInstruction({
      contract: input.contract,
      previousLedger,
      ledgerCopyPath,
      rawFindingsPath,
      residualRawFindings: mechanical.residualRawFindings,
      mechanicallyClassifiedCount: rawFindings.length - mechanical.residualRawFindings.length,
      priorStepResponseText: input.priorStepResponseText,
      invalidLocationCandidates,
    });
    ({ managerOutput, validation, invalidAttempts, unsupportedRawDecisions, droppedExplicitReferenceRaws } = await runManagerWithSemanticRetry({
      previousLedger,
      rawFindings,
      residualRawFindings: mechanical.residualRawFindings,
      mechanicalOutput: mechanical.output,
      invalidLocationCandidateFindingIds,
      managerStep,
      instruction,
      optionsBuilder: input.optionsBuilder,
      stepExecutor: input.stepExecutor,
      priorStepResponseText: input.priorStepResponseText,
    }));
  } else {
    managerOutput = mechanical.output;
    validation = validateFindingManagerOutput({
      previousLedger,
      rawFindings,
      managerOutput,
      priorStepResponseText: input.priorStepResponseText,
    });
    invalidAttempts = validation.ok
      ? []
      : [{ attempt: 1, managerOutput, validationErrors: validation.errors }];
    unsupportedRawDecisions = [];
    droppedExplicitReferenceRaws = [];
  }

  if (!validation.ok) {
    const reportPath = input.ledgerStore.saveManagerValidationReport({
      version: 1,
      runId: input.runId,
      stepName: input.parentStep.name,
      retryCount: FINDING_MANAGER_MAX_SEMANTIC_RETRIES,
      ledgerUpdated: false,
      finalErrors: validation.errors,
      attempts: invalidAttempts,
      ...(admission.rejected.length > 0 ? { rawAdmissionRejections: admission.rejected } : {}),
      ...(relationCoherence.rejected.length > 0 ? { unsupportedRawFindings: relationCoherence.rejected } : {}),
    });
    return {
      status: 'invalid_manager_output',
      ledgerPath: ledgerCopyPath,
      providerInfo,
      reportPath,
      errors: validation.errors,
      retryCount: FINDING_MANAGER_MAX_SEMANTIC_RETRIES,
    };
  }

  // ここまでの LLM 呼び出し・組み立て・検証は previousLedger（この関数の
  // 冒頭で読んだスナップショット）を基準に行った。だが並列 workflow_call の
  // 子エンジンが同じ store（親から継承した台帳）を共有する場合、この間に
  // 別の子が台帳を更新している可能性がある。previousLedger のまま保存すると
  // 後勝ちで他方の更新を消してしまう（実測: 2子が同時に台帳更新→片方の
  // findings が消失）。updateLedger で「保存直前に再読込した台帳」に対して
  // 組み立てをもう一度行い、そのまま同じ排他区間で保存する。
  //
  // managerOutput（mechanical ∪ LLM 判断の組み立て済み8配列）を decisions へ
  // 逆変換して assembleManagerOutput をもう一度通すのは、raw finding と
  // finding id を指す判断そのものは再読込後の台帳に対しても意味を持つため。
  // 再読込後に前提が崩れた決定（例: 既に他の子が resolved にした finding への
  // same）は、既存の項目単位の不採用として扱う（ここでは再問い合わせしない。
  // 直列化区間の中で LLM を呼び直すと排他の意味が失われるため）。
  let staleRejections: string[] = [];
  // 直前ラウンドで 'unsupported' と裁定された raw と、強制 new 化から除外された
  // 明示参照 raw（relation persists/reopened、forceUnresolvedRawDecisionsAsNew
  // 参照）は、finalized managerOutput のどの配列にも現れない（監査専用の
  // 記録のため）。flatten でそのまま往復させると decisions に何も残らず、
  // reconciler の「未言及 raw → new finding」フォールバックに紛れ込んで不採用の
  // 意味が消える（新規 finding として台帳に混入する）。ここで明示的に除外集合へ
  // 加える。
  const unsupportedRawFindingIds = new Set([
    ...unsupportedRawDecisions.map((u) => u.rawFindingId),
    ...droppedExplicitReferenceRaws.map((d) => d.rawFindingId),
  ]);
  const nextLedger = await input.ledgerStore.updateLedger((freshLedger) => {
    // waive 変換由来の conflict（rawFindingIds: []）は raw decisions へ復元できない
    // ため、flatten が持ち越し分として返す。渡し忘れると初回組み立てで作った
    // conflict がこの往復で消える。
    const { decisions, carriedFindingOnlyConflicts } = flattenManagerOutputToDecisions(managerOutput);
    const freshAssembly = assembleManagerOutput({
      previousLedger: freshLedger,
      residualRawFindings: rawFindings,
      decisions,
      carriedFindingOnlyConflicts,
      priorStepResponseText: input.priorStepResponseText,
      // invalidate 候補は保存直前の台帳・現時点の cwd で再計算する。初回判断の
      // 時点では location が無効（ファイル不在等）でも、判断と保存の間に
      // ファイルが生まれて location が有効になっていることがある（並列子の
      // 生成物や fix ステップの成果物）。初回確認済みの id 集合をそのまま
      // 流すと、もはや成立しない invalidate が最新台帳に適用されてしまう。
      // 再計算で候補から外れた stale な invalidate は assembleInvalidateDecisions
      // が不採用にし、staleRejections として検証レポートに残る。
      invalidLocationCandidateFindingIds: new Set(
        computeInvalidLocationCandidates(input.cwd, freshLedger.findings).keys(),
      ),
    });
    staleRejections = describeRejections(freshAssembly);
    // 最新台帳との再照合で項目単位で不採用になった raw は、reconciler の
    // 「決定で言及されなかった raw finding は新規 finding にする」フォールバック
    // にも回さない。回すと不採用の意味が消え、この raw が結局 new finding として
    // 台帳に紛れ込む（reconcileFindingLedger 側のコメント参照）。unsupported と
    // 裁定された raw も同じ理由で除外する。
    const staleRejectedRawFindingIds = new Set([
      ...freshAssembly.rejectedRawDecisions.map((rejected) => rejected.rawFindingId),
      ...unsupportedRawFindingIds,
    ]);
    return reconcileFindingLedger({
      priorStepResponseText: input.priorStepResponseText,
      previousLedger: freshLedger,
      rawFindings,
      managerOutput: freshAssembly.output,
      excludedFromUnmentionedFallbackRawFindingIds: staleRejectedRawFindingIds,
      context: {
        workflowName: input.workflowName,
        stepName: input.parentStep.name,
        runId: input.runId,
        timestamp: input.timestamp,
      },
    });
  });
  const unsupportedRawFindingReports: UnsupportedRawFindingReport[] = [
    // relation coherence で intake 前に落とした raw（Phase A の unsupported 経路を
    // 監査記録として再利用。targetFindingId は衝突相手の open finding）。
    ...relationCoherence.rejected,
    ...unsupportedRawDecisions.map((u) => ({
      rawFindingId: u.rawFindingId,
      targetFindingId: u.targetFindingId,
      evidence: u.evidence,
    })),
  ];
  if (
    invalidAttempts.length > 0
    || staleRejections.length > 0
    || admission.rejected.length > 0
    || unsupportedRawFindingReports.length > 0
    || droppedExplicitReferenceRaws.length > 0
  ) {
    input.ledgerStore.saveManagerValidationReport({
      version: 1,
      runId: input.runId,
      stepName: input.parentStep.name,
      retryCount: FINDING_MANAGER_MAX_SEMANTIC_RETRIES,
      ledgerUpdated: true,
      finalErrors: [],
      ...(admission.rejected.length > 0 ? { rawAdmissionRejections: admission.rejected } : {}),
      ...(unsupportedRawFindingReports.length > 0 ? { unsupportedRawFindings: unsupportedRawFindingReports } : {}),
      ...(droppedExplicitReferenceRaws.length > 0 ? { droppedExplicitReferenceRawFindings: droppedExplicitReferenceRaws } : {}),
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
  return {
    status: 'updated',
    ledgerPath: ledgerCopyPath,
    providerInfo,
    ledger: nextLedger,
  };
}
