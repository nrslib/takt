import { executeAgent } from '../../../agents/agent-usecases.js';
import type { AgentResponse, AgentWorkflowStep, FindingContractConfig, WorkflowStep } from '../../models/types.js';
import {
  FindingManagerOutputJsonSchema,
  RawFindingsOutputJsonSchema,
  parseFindingManagerOutput,
  parseReviewerRawFindings,
} from './schemas.js';
import { reconcileFindingLedger } from './reconciler.js';
import { classifyRawFindingsMechanically, mergeFindingManagerOutputs } from './mechanical-classification.js';
import type { FindingLedgerStore, FindingManagerValidationAttemptReport } from './store.js';
import type { FindingLedger, FindingManagerOutput, RawFinding } from './types.js';
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

export interface FindingManagerSubStepResult {
  subStep: WorkflowStep;
  response: AgentResponse;
}

interface RunFindingManagerForParallelStepInput {
  contract: FindingContractConfig;
  ledgerStore: FindingLedgerStore;
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput'>;
  parentStep: WorkflowStep;
  stepIteration: number;
  subResults: FindingManagerSubStepResult[];
  workflowName: string;
  runId: string;
  timestamp: string;
  ledgerCopyPath?: string;
  /** Response text of the step that ran before the reviewers (usually the coder's fix report, which may contain dispute claims). */
  priorStepResponseText?: string;
}

export const RAW_FINDINGS_SCHEMA_REF = 'takt.findings.raw.v1';
export const FINDING_MANAGER_SCHEMA_REF = 'takt.findings.manager.v1';
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
}): string {
  return [
    input.runId,
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
}): RawFinding[] {
  return input.subResults.flatMap((result) => {
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
      schema: FindingManagerOutputJsonSchema,
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

function buildManagerRetryInstruction(input: {
  originalInstruction: string;
  validationErrors: readonly string[];
  managerOutput: FindingManagerOutput;
}): string {
  return [
    input.originalInstruction,
    '',
    '## Previous manager output was semantically invalid',
    'Validation errors:',
    ...input.validationErrors.map((error) => `- ${error}`),
    '',
    'Invalid manager output:',
    renderFencedJsonBlock(input.managerOutput),
    '',
    'Return a corrected manager output. Each raw finding must appear in exactly one manager decision, referenced finding ids must exist in the previous ledger, and state transitions must be valid.',
  ].join('\n');
}

function parseManagerOutput(response: AgentResponse): FindingManagerOutput {
  if (response.status !== 'done') {
    const detail = response.error ?? response.content;
    throw new Error(`Finding manager failed with status "${response.status}": ${detail}`);
  }
  const output = response.structuredOutput;
  if (typeof output !== 'object' || output == null || Array.isArray(output)) {
    throw new Error('Finding manager output must be an object');
  }
  return parseFindingManagerOutput(output);
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
}): Promise<FindingManagerOutput> {
  const phase1Instruction = input.stepExecutor.buildPhase1Instruction(input.instruction, input.managerStep);
  const agentOptions = buildManagerAgentOptions(input.optionsBuilder, input.managerStep);
  const rawResponse = await executeAgent(input.managerStep.persona, phase1Instruction, agentOptions);
  const response = input.stepExecutor.normalizeStructuredOutput(input.managerStep, rawResponse);
  return parseManagerOutput(response);
}

async function runManagerWithSemanticRetry(input: {
  previousLedger: FindingLedger;
  rawFindings: RawFinding[];
  mechanicalOutput: FindingManagerOutput;
  managerStep: AgentWorkflowStep;
  instruction: string;
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput'>;
  priorStepResponseText?: string;
}): Promise<ValidatedManagerOutputRun> {
  // 検証は「機械分類 + LLM 分類」を統合した最終形に対して行う。
  // 全 raw finding の網羅性は統合後でしか成立しないため。
  const firstAgentOutput = await runManagerAttempt({
    managerStep: input.managerStep,
    instruction: input.instruction,
    optionsBuilder: input.optionsBuilder,
    stepExecutor: input.stepExecutor,
  });
  const firstManagerOutput = mergeFindingManagerOutputs(input.mechanicalOutput, firstAgentOutput);
  const firstValidation = validateFindingManagerOutput({
    previousLedger: input.previousLedger,
    rawFindings: input.rawFindings,
    managerOutput: firstManagerOutput,
    priorStepResponseText: input.priorStepResponseText,
  });
  if (firstValidation.ok) {
    return { managerOutput: firstManagerOutput, validation: firstValidation, invalidAttempts: [] };
  }

  const firstAttempt = {
    attempt: 1,
    managerOutput: firstManagerOutput,
    validationErrors: firstValidation.errors,
  };
  const retryAgentOutput = await runManagerAttempt({
    managerStep: input.managerStep,
    instruction: buildManagerRetryInstruction({
      originalInstruction: input.instruction,
      validationErrors: firstValidation.errors,
      managerOutput: firstAgentOutput,
    }),
    optionsBuilder: input.optionsBuilder,
    stepExecutor: input.stepExecutor,
  });
  const retryManagerOutput = mergeFindingManagerOutputs(input.mechanicalOutput, retryAgentOutput);
  const retryValidation = validateFindingManagerOutput({
    previousLedger: input.previousLedger,
    rawFindings: input.rawFindings,
    managerOutput: retryManagerOutput,
    priorStepResponseText: input.priorStepResponseText,
  });

  return {
    managerOutput: retryManagerOutput,
    validation: retryValidation,
    invalidAttempts: retryValidation.ok
      ? [firstAttempt]
      : [
        firstAttempt,
        {
          attempt: 1 + FINDING_MANAGER_MAX_SEMANTIC_RETRIES,
          managerOutput: retryManagerOutput,
          validationErrors: retryValidation.errors,
        },
      ],
  };
}

export async function runFindingManagerForParallelStep(
  input: RunFindingManagerForParallelStepInput,
): Promise<FindingManagerRunResult> {
  const previousLedger = input.ledgerStore.loadLedger();
  const ledgerCopyPath = input.ledgerCopyPath ?? input.ledgerStore.createRunCopy();
  const rawFindings = extractStructuredRawFindings({
    subResults: input.subResults,
    runId: input.runId,
    stepIteration: input.stepIteration,
    parentStepName: input.parentStep.name,
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

  const nextLedger = reconcileFindingLedger({
    priorStepResponseText: input.priorStepResponseText,
    previousLedger,
    rawFindings,
    managerOutput,
    context: {
      workflowName: input.workflowName,
      stepName: input.parentStep.name,
      runId: input.runId,
      timestamp: input.timestamp,
    },
  });
  input.ledgerStore.saveLedger(nextLedger);
  if (invalidAttempts.length > 0) {
    input.ledgerStore.saveManagerValidationReport({
      version: 1,
      runId: input.runId,
      stepName: input.parentStep.name,
      retryCount: FINDING_MANAGER_MAX_SEMANTIC_RETRIES,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: invalidAttempts,
    });
  }
  return {
    status: 'updated',
    ledgerPath: ledgerCopyPath,
    providerInfo,
    ledger: nextLedger,
  };
}
