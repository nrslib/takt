import { executeAgent } from '../../../agents/agent-usecases.js';
import type { AgentResponse, AgentWorkflowStep, FindingContractConfig, WorkflowStep } from '../../models/types.js';
import {
  FindingManagerDecisionsJsonSchema,
  RawFindingsOutputJsonSchema,
  parseFindingManagerDecisions,
  parseReviewerRawFindings,
} from './schemas.js';
import { reconcileFindingLedger } from './reconciler.js';
import { classifyRawFindingsMechanically } from './mechanical-classification.js';
import {
  assembleManagerOutput,
  flattenManagerOutputToDecisions,
  type AssembleManagerOutputResult,
  type RejectedConflictDecision,
  type RejectedDisputeDecision,
  type RejectedRawDecision,
} from './decision-assembly.js';
import type { FindingLedgerStore, FindingManagerValidationAttemptReport } from './store.js';
import type { FindingLedger, FindingManagerDecisions, FindingManagerOutput, RawFinding } from './types.js';
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
// v2: LLM が返すのは 8 配列の最終結果ではなく、raw finding / disputed finding /
// conflict 1件ごとの「判断」だけ（FindingManagerDecisionsJsonSchema）。組み立てと
// 不変条件の強制は decision-assembly.ts が行う。
export const FINDING_MANAGER_SCHEMA_REF = 'takt.findings.manager.v2';
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

function buildManagerStep(contract: FindingContractConfig): AgentWorkflowStep {
  return {
    kind: 'agent',
    name: 'findings-manager',
    persona: contract.manager.persona,
    personaDisplayName: contract.manager.personaDisplayName ?? contract.manager.persona,
    personaPath: contract.manager.personaPath,
    instruction: contract.manager.instruction,
    session: 'refresh',
    edit: false,
    structuredOutput: {
      schemaRef: FINDING_MANAGER_SCHEMA_REF,
      schema: FindingManagerDecisionsJsonSchema,
    },
  };
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

/**
 * residual raws が参照する指摘（reopen・再確認の候補）と、active conflict が
 * 参照する指摘は台帳スタブ化から除外して全文を渡す。
 */
function collectFullDetailFindingIds(ledger: FindingLedger, residualRawFindings: readonly RawFinding[]): Set<string> {
  const rawFindingsById = new Map(ledger.rawFindings.map((rawFinding) => [rawFinding.rawFindingId, rawFinding]));
  const ids = new Set<string>();
  for (const conflict of ledger.conflicts) {
    if (conflict.status !== 'active') {
      continue;
    }
    for (const findingId of conflict.findingIds) {
      ids.add(findingId);
    }
  }
  for (const raw of residualRawFindings) {
    if (raw.targetFindingId !== undefined) {
      ids.add(raw.targetFindingId);
    }
    for (const finding of ledger.findings) {
      if (raw.location !== undefined && finding.location === raw.location) {
        ids.add(finding.id);
        continue;
      }
      const tagMatched = finding.rawFindingIds.some((id) => rawFindingsById.get(id)?.familyTag === raw.familyTag);
      if (tagMatched) {
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
}): string {
  const managerInputLedger = buildManagerInputLedger(
    input.previousLedger,
    collectFullDetailFindingIds(input.previousLedger, input.residualRawFindings),
  );
  const mechanicalNote = input.mechanicallyClassifiedCount > 0
    ? [
      input.contract.manager.instruction,
      '',
      `NOTE: ${input.mechanicallyClassifiedCount} raw findings (exact resolution confirmations and exact matches to open findings) were already classified mechanically by the engine and are NOT shown below. Classify only the raw findings listed below. Do not reference raw finding ids that are not listed.`,
    ].join('\n')
    : input.contract.manager.instruction;
  return loadTemplate('finding_manager_instruction', 'en', {
    managerInstruction: mechanicalNote,
    outputContract: input.contract.manager.outputContract,
    ledgerCopyPath: input.ledgerCopyPath,
    managerInputLedger: renderFencedJsonBlock(managerInputLedger),
    rawFindingsPath: input.rawFindingsPath,
    rawFindings: renderFencedJsonBlock(input.residualRawFindings),
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

  return [
    input.originalInstruction,
    '',
    '## Some previous decisions were rejected',
    'The engine rejected the decisions listed below because they violated ledger invariants. Return decisions ONLY for these items (same rawDecisions/disputeDecisions/conflictDecisions shape as before). Do not repeat decisions for items not listed here; those were already accepted.',
    ...(rejectedRawBlock.length > 0 ? ['', '### Rejected raw decisions', ...rejectedRawBlock] : []),
    ...(rejectedDisputeBlock.length > 0 ? ['', '### Rejected dispute decisions', ...rejectedDisputeBlock] : []),
    ...(rejectedConflictBlock.length > 0 ? ['', '### Rejected conflict decisions', ...rejectedConflictBlock] : []),
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
    || assembly.rejectedCarriedConflicts.length > 0;
}

/** ラウンド1の採用分（不採用でなかった決定）だけを残す。ラウンド2の再問い合わせ結果と合成するために使う。 */
function keepAcceptedDecisions(
  decisions: FindingManagerDecisions,
  assembly: AssembleManagerOutputResult,
): FindingManagerDecisions {
  const rejectedRawIds = new Set(assembly.rejectedRawDecisions.map((r) => r.rawFindingId));
  const rejectedDisputeIds = new Set(assembly.rejectedDisputeDecisions.map((r) => r.findingId));
  const rejectedConflictIds = new Set(assembly.rejectedConflictDecisions.map((r) => r.conflictId));
  return {
    rawDecisions: decisions.rawDecisions.filter((d) => !rejectedRawIds.has(d.rawFindingId)),
    disputeDecisions: decisions.disputeDecisions.filter((d) => !rejectedDisputeIds.has(d.findingId)),
    conflictDecisions: decisions.conflictDecisions.filter((d) => !rejectedConflictIds.has(d.conflictId)),
  };
}

/**
 * 再問い合わせ後もなお不採用の raw decision は、情報を捨てないため new finding として
 * 扱う（機械分類・reconciler の「未言及 raw は new」フォールバックと同じ思想）。
 * dispute/conflict の不採用分は、対象が既存の台帳エントリ（対象は変化しない）なので
 * 単に反映しない（何もしない = 現状維持）。
 *
 * ただし kind が resolution_confirmation の raw は new に倒せない。
 * manager-output-validation.ts の validateConfirmationRefsOnlyInResolutions が
 * 「Resolution confirmation ... cannot be cited as issue evidence」で newFindings
 * への混入を拒否するため、ここで forcedNewFindings に含めると最終検証で
 * invalid_manager_output に落ち、再問い合わせで直った他の決定まで道連れで
 * 台帳に反映されなくなる（実測: 既に resolved 済みの finding を再度 resolved と
 * 判断するケースで再現）。resolution_confirmation はここでは採用せず、
 * invalidAttempts / saveManagerValidationReport の記録だけに残して捨てる。
 */
function forceUnresolvedRawDecisionsAsNew(
  assembly: AssembleManagerOutputResult,
  residualRawFindings: readonly RawFinding[],
): FindingManagerOutput {
  const rawById = new Map(residualRawFindings.map((raw) => [raw.rawFindingId, raw]));
  const forcedNewFindings = assembly.rejectedRawDecisions
    .map((rejected) => rawById.get(rejected.rawFindingId))
    .filter((raw): raw is RawFinding => raw !== undefined && raw.kind !== 'resolution_confirmation')
    .map((raw) => ({ rawFindingIds: [raw.rawFindingId], title: raw.title, severity: raw.severity }));
  return {
    ...assembly.output,
    newFindings: [...assembly.output.newFindings, ...forcedNewFindings],
  };
}

async function runManagerWithSemanticRetry(input: {
  previousLedger: FindingLedger;
  rawFindings: RawFinding[];
  residualRawFindings: RawFinding[];
  mechanicalOutput: FindingManagerOutput;
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
    return { managerOutput, validation: finalizeValidation(managerOutput), invalidAttempts: [] };
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
    }),
    optionsBuilder: input.optionsBuilder,
    stepExecutor: input.stepExecutor,
  });
  const acceptedFirstDecisions = keepAcceptedDecisions(firstDecisions, firstAssembly);
  const combinedDecisions: FindingManagerDecisions = {
    rawDecisions: [...acceptedFirstDecisions.rawDecisions, ...retryDecisions.rawDecisions],
    disputeDecisions: [...acceptedFirstDecisions.disputeDecisions, ...retryDecisions.disputeDecisions],
    conflictDecisions: [...acceptedFirstDecisions.conflictDecisions, ...retryDecisions.conflictDecisions],
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
  });

  const stillRejected = hasAnyRejection(secondAssembly);
  const managerOutput = stillRejected
    ? forceUnresolvedRawDecisionsAsNew(secondAssembly, input.residualRawFindings)
    : secondAssembly.output;

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
  };
}

export async function runFindingManagerForStep(
  input: RunFindingManagerForStepInput,
): Promise<FindingManagerRunResult> {
  const previousLedger = input.ledgerStore.loadLedger();
  const ledgerCopyPath = input.ledgerCopyPath ?? input.ledgerStore.createRunCopy();
  const rawFindings = extractStructuredRawFindings({
    subResults: input.subResults,
    runId: input.runId,
    stepIteration: input.stepIteration,
    parentStepName: input.parentStep.name,
    callNamespace: input.callNamespace,
  });
  const rawFindingsPath = input.ledgerStore.saveRawFindings(input.runId, input.parentStep.name, rawFindings);
  const managerStep = buildManagerStep(input.contract);
  const providerInfo = input.optionsBuilder.resolveStepProviderModel(managerStep);

  // フィールド等価で確定する raw（解消確認・open 指摘への完全一致）はコードで
  // 分類し、判断が必要な残りだけを LLM manager に渡す。LLM を呼ばないのは
  // 「残りゼロ・prior step response に異議申告（Disputed Findings 見出し）なし・
  // 裁定待ちの active conflict なし」が全て揃う場合だけ。waiver は見出し配下の
  // claim からしか成立しないため、見出しの無い応答は判断材料を含まない。
  const mechanical = classifyRawFindingsMechanically({ previousLedger, rawFindings });
  const hasDisputeClaims = hasDisputeClaimsHeading(input.priorStepResponseText);
  const hasActiveConflict = previousLedger.conflicts.some((conflict) => conflict.status === 'active');
  const needsAgent = mechanical.residualRawFindings.length > 0 || hasDisputeClaims || hasActiveConflict;

  let managerOutput: FindingManagerOutput;
  let validation: FindingManagerValidationResult;
  let invalidAttempts: FindingManagerValidationAttemptReport[];
  if (needsAgent) {
    const instruction = buildManagerInstruction({
      contract: input.contract,
      previousLedger,
      ledgerCopyPath,
      rawFindingsPath,
      residualRawFindings: mechanical.residualRawFindings,
      mechanicallyClassifiedCount: rawFindings.length - mechanical.residualRawFindings.length,
      priorStepResponseText: input.priorStepResponseText,
    });
    ({ managerOutput, validation, invalidAttempts } = await runManagerWithSemanticRetry({
      previousLedger,
      rawFindings,
      residualRawFindings: mechanical.residualRawFindings,
      mechanicalOutput: mechanical.output,
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
    });
    staleRejections = describeRejections(freshAssembly);
    // 最新台帳との再照合で項目単位で不採用になった raw は、reconciler の
    // 「決定で言及されなかった raw finding は新規 finding にする」フォールバック
    // にも回さない。回すと不採用の意味が消え、この raw が結局 new finding として
    // 台帳に紛れ込む（reconcileFindingLedger 側のコメント参照）。
    const staleRejectedRawFindingIds = new Set(
      freshAssembly.rejectedRawDecisions.map((rejected) => rejected.rawFindingId),
    );
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
  if (invalidAttempts.length > 0 || staleRejections.length > 0) {
    input.ledgerStore.saveManagerValidationReport({
      version: 1,
      runId: input.runId,
      stepName: input.parentStep.name,
      retryCount: FINDING_MANAGER_MAX_SEMANTIC_RETRIES,
      ledgerUpdated: true,
      finalErrors: [],
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
