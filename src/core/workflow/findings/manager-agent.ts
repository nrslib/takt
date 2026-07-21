import { executeAgent } from '../../../agents/agent-usecases.js';
import type { AgentResponse, AgentWorkflowStep, FindingContractConfig } from '../../models/types.js';
import {
  RawFindingsOutputJsonSchema,
  RawFindingsOutputValidationJsonSchema,
  parseFindingManagerDecisions,
} from './schemas.js';
import { normalizeFindingText, parseFindingLocation, parseFindingLocationRange } from './location.js';
import type {
  FindingLedger,
  FindingManagerDecisions,
  RawFinding,
} from './types.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import {
  renderFencedJsonBlock,
  renderFencedTextBlock,
} from '../instruction/fenced-block.js';
import { loadTemplate } from '../../../shared/prompts/index.js';

export const RAW_FINDINGS_SCHEMA_REF = 'takt.findings.raw.v1';
export { FINDING_MANAGER_SCHEMA_REF } from './manager-step.js';
export const RawFindingsStructuredOutput = {
  schemaRef: RAW_FINDINGS_SCHEMA_REF,
  /** provider-facing strict schema。native structured output の生成拘束用。 */
  schema: RawFindingsOutputJsonSchema,
  /** post-hoc 検証用 schema。provider へは渡さない。 */
  validationSchema: RawFindingsOutputValidationJsonSchema,
} as const;

/**
 * v2: run-level の invalid_manager_output は存在しない。manager の壊れた応答・
 * 予算超過・解釈不能はすべて provisional として台帳へ着地し、run は継続する
 * （final gate は provisional が閉じ続ける）。
 */
export function buildManagerInputLedger(ledger: FindingLedger, fullDetailFindingIds?: ReadonlySet<string>): unknown {
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

/**
 * 同一ファイルを引用する open finding のグループ（2件以上）。言い換え増殖
 * （同じ問題が別 familyTag・別行で別 finding として積まれる — 実測: RFC 3339
 * 系 7 変種）の統合判断を manager に明示的に促すための決定的ヒント。
 * 判断そのものは manager の duplicateDecisions（と engine の検証）に委ねる。
 */
export function collectDuplicateLocusGroups(ledger: FindingLedger): Map<string, FindingLedger['findings']> {
  const byPath = new Map<string, FindingLedger['findings']>();
  for (const finding of ledger.findings) {
    if (finding.status !== 'open' || finding.provisional !== undefined) {
      continue;
    }
    // 行範囲形式（path:10-20）は parseFindingLocation では path に範囲ごと
    // 含まれてしまうため、先に範囲として解釈する（admission と同じ受理形式）。
    const path = parseFindingLocationRange(finding.location)?.path
      ?? parseFindingLocation(finding.location)?.path;
    if (path === undefined) {
      continue;
    }
    byPath.set(path, [...(byPath.get(path) ?? []), finding]);
  }
  return new Map([...byPath.entries()].filter(([, findings]) => findings.length >= 2));
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

export function buildManagerInstruction(input: {
  contract: FindingContractConfig;
  previousLedger: FindingLedger;
  ledgerCopyPath: string;
  rawFindingsPath: string;
  residualRawFindings: RawFinding[];
  mechanicallyClassifiedCount: number;
  priorStepResponseText?: string;
  invalidLocationCandidates: Map<string, string>;
  dismissCandidates: Map<string, string>;
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
  const dismissCandidatesBlock = [...input.dismissCandidates.entries()]
    .map(([findingId, description]) => `- ${findingId}: ${description}`)
    .join('\n');
  const duplicateLocusGroups = collectDuplicateLocusGroups(input.previousLedger);
  const duplicateLocusGroupsBlock = [...duplicateLocusGroups.entries()]
    .map(([path, findings]) => [
      `- ${path}:`,
      ...findings.map((finding) => `  - ${finding.id} [${finding.severity}] ${finding.title}`),
    ].join('\n'))
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
    hasDismissCandidates: input.dismissCandidates.size > 0,
    dismissCandidatesBlock,
    hasDuplicateLocusGroups: duplicateLocusGroups.size > 0,
    duplicateLocusGroupsBlock,
    coderResponse: renderFencedTextBlock(input.priorStepResponseText ?? '(no prior step response)'),
  });
}

export function parseManagerDecisions(response: AgentResponse): FindingManagerDecisions {
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

export async function runManagerAttempt(input: {
  managerStep: AgentWorkflowStep;
  instruction: string;
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput' | 'recordSynthesizedAgentUsage'>;
}): Promise<AgentResponse> {
  const phase1Instruction = input.stepExecutor.buildPhase1Instruction(input.instruction, input.managerStep);
  return runPreparedManagerAttempt({
    managerStep: input.managerStep,
    phase1Instruction,
    optionsBuilder: input.optionsBuilder,
    stepExecutor: input.stepExecutor,
  });
}

export async function runPreparedManagerAttempt(input: {
  managerStep: AgentWorkflowStep;
  phase1Instruction: string;
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'normalizeStructuredOutput' | 'recordSynthesizedAgentUsage'>;
}): Promise<AgentResponse> {
  const agentOptions = buildManagerAgentOptions(input.optionsBuilder, input.managerStep);
  let rawResponse: AgentResponse;
  try {
    rawResponse = await executeAgent(input.managerStep.persona, input.phase1Instruction, agentOptions);
  } catch (error) {
    // 呼び出し自体が失敗しても集計の死角を作らない — usage 欠損の失敗イベントを残す。
    input.stepExecutor.recordSynthesizedAgentUsage(input.managerStep, false, undefined);
    throw error;
  }
  input.stepExecutor.recordSynthesizedAgentUsage(
    input.managerStep,
    rawResponse.status === 'done',
    rawResponse.providerUsage,
  );
  return input.stepExecutor.normalizeStructuredOutput(input.managerStep, rawResponse);
}
