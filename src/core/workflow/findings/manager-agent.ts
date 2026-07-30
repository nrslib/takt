import { executeAgent } from '../../../agents/agent-usecases.js';
import type { AgentResponse, AgentWorkflowStep, FindingContractConfig, WorkflowStructuredOutput } from '../../models/types.js';
import {
  RawFindingsOutputValidationJsonSchema,
  createRawFindingsOutputJsonSchema,
  parseFindingManagerDecisions,
} from './schemas.js';
import { RAW_FINDINGS_SCHEMA_REF } from './raw-canonicalization.js';
import { normalizeFindingText } from '../../models/finding-claim-identity.js';
import type {
  FindingEvidenceRecord,
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
import {
  findingFileQuoteLocations,
  formatFileQuoteLocation,
  rawFindingFileQuoteLocations,
} from './evidence-location.js';
import { createHash } from 'node:crypto';
import {
  canonicalJson,
  compareCanonicalJsonValues,
} from '../../../shared/utils/canonical-json.js';
import { computeFindingLifecycleProjectionDigest } from '../../models/finding-lifecycle-identity.js';
import { selectActionableFindingEntries } from './context.js';

export { RAW_FINDINGS_SCHEMA_REF };
export { FINDING_MANAGER_SCHEMA_REF } from './manager-step.js';

export function createRawFindingsStructuredOutput(): WorkflowStructuredOutput {
  return {
    schemaRef: RAW_FINDINGS_SCHEMA_REF,
    schema: createRawFindingsOutputJsonSchema(),
    validationSchema: RawFindingsOutputValidationJsonSchema,
  };
}

function managerEvidenceDetails(
  rawFinding: RawFinding,
  evidenceRecords: readonly FindingEvidenceRecord[],
): unknown[] {
  const recordsByProofId = new Map(
    evidenceRecords
      .filter((record) => record.kind === 'engine_proof')
      .map((record) => [record.proofId, record]),
  );
  return rawFinding.evidence.map((evidence) => {
    if (evidence.kind === 'file_quote') {
      return {
        kind: evidence.kind,
        path: evidence.path,
        startLine: evidence.startLine,
        endLine: evidence.endLine,
        verbatimExcerpt: evidence.verbatimExcerpt,
        snapshotId: evidence.snapshotId,
      };
    }
    const record = recordsByProofId.get(evidence.proofId);
    return record === undefined
      ? {
          kind: evidence.kind,
          proofId: evidence.proofId,
          record: null,
          protocolError: 'referenced engine proof is not present in the supplied registry',
        }
      : {
          kind: record.kind,
          proofId: record.proofId,
          evidenceId: record.evidenceId,
          purpose: record.purpose,
          verifier: {
            id: record.verifierId,
            version: record.verifierVersion,
          },
          claimIdentityHash: record.claimIdentityHash,
          targetFindingId: record.targetFindingId,
          subject: record.subject,
          dependencyDigests: record.dependencyDigests,
          resultDigest: record.resultDigest,
          snapshotId: record.snapshotId,
        };
  });
}

export function managerRawFindingView(
  rawFinding: RawFinding,
  evidenceRecords: readonly FindingEvidenceRecord[],
): unknown {
  return {
    ...rawFinding,
    target: rawFinding.target,
    targetIdentityHash: rawFinding.targetIdentityHash,
    claimIdentityHash: rawFinding.claimIdentityHash,
    semanticClaimIdentityHash: rawFinding.semanticClaimIdentityHash,
    candidateIdentityHash: rawFinding.candidateIdentityHash,
    evidenceDetails: managerEvidenceDetails(rawFinding, evidenceRecords),
  };
}

function digestCompactValue(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

const COMPACT_FINDING_COLLECTION_LIMIT = 16;

function compactFindingCollection<T>(fullSet: readonly T[]): {
  items: T[];
  totalCount: number;
  fullSetDigest: string;
  truncated: boolean;
} {
  const canonicalItems = [...fullSet].sort(compareCanonicalJsonValues);
  return {
    items: canonicalItems.slice(0, COMPACT_FINDING_COLLECTION_LIMIT),
    totalCount: canonicalItems.length,
    fullSetDigest: digestCompactValue(canonicalItems),
    truncated: canonicalItems.length > COMPACT_FINDING_COLLECTION_LIMIT,
  };
}

function compactEngineProofSubject(
  record: Extract<FindingEvidenceRecord, { kind: 'engine_proof' }>,
): unknown {
  const subject = record.subject;
  switch (subject.kind) {
    case 'repository_query':
      return {
        kind: subject.kind,
        predicate: subject.predicate.kind === 'path_state'
          ? subject.predicate
          : {
              kind: subject.predicate.kind,
              roots: subject.predicate.roots,
              literalDigest: digestCompactValue(subject.predicate.literal),
              textDomain: subject.predicate.textDomain,
            },
        result: subject.result,
        coverage: subject.coverage,
      };
    case 'repository_manifest':
      return {
        kind: subject.kind,
        scope: subject.scope,
        manifestTargetCount: subject.manifestTargets.length,
        manifestTargetsDigest: digestCompactValue(subject.manifestTargets),
        observedTargetCount: subject.observedTargets.length,
        observedTargetsDigest: digestCompactValue(subject.observedTargets),
      };
    case 'authoritative_quote':
      return {
        kind: subject.kind,
        source: subject.source,
        declarationId: subject.declarationId,
        verbatimExcerptDigest: digestCompactValue(subject.verbatimExcerpt),
      };
    default:
      return { kind: subject.kind };
  }
}

function compactEvidenceSummary(record: FindingEvidenceRecord | undefined, evidenceId: string): unknown {
  if (record === undefined) {
    return {
      evidenceId,
      protocolError: 'finding evidence record is missing',
    };
  }
  if (record.kind === 'file_quote') {
    return {
      kind: record.kind,
      evidenceId: record.evidenceId,
      claimIdentityHash: record.claimIdentityHash,
      path: record.path,
      startLine: record.startLine,
      endLine: record.endLine,
      fileHash: record.fileHash,
      snapshotId: record.snapshotId,
    };
  }
  return {
    kind: record.kind,
    evidenceId: record.evidenceId,
    proofId: record.proofId,
    purpose: record.purpose,
    verifier: {
      id: record.verifierId,
      version: record.verifierVersion,
    },
    claimIdentityHash: record.claimIdentityHash,
    targetFindingId: record.targetFindingId,
    subject: compactEngineProofSubject(record),
    dependencyDigests: record.dependencyDigests,
    resultDigest: record.resultDigest,
    snapshotId: record.snapshotId,
  };
}

/**
 * run-level の invalid_manager_output は存在しない。manager の壊れた応答・
 * 予算超過・解釈不能はすべて provisional として台帳へ着地し、run は継続する
 * （final gate は provisional が閉じ続ける）。
 */
export function buildManagerInputLedger(ledger: FindingLedger, fullDetailFindingIds?: ReadonlySet<string>): unknown {
  const rawFindingsById = new Map(ledger.rawFindings.map((rawFinding) => [rawFinding.rawFindingId, rawFinding]));
  const needsFullDetail = (finding: FindingLedger['findings'][number]): boolean => (
    fullDetailFindingIds === undefined
      ? finding.status === 'open'
      : fullDetailFindingIds.has(finding.id)
  );
  return {
    workflowName: ledger.workflowName,
    nextId: ledger.nextId,
    updatedAt: ledger.updatedAt,
    findings: ledger.findings.map((finding) => (needsFullDetail(finding)
      ? {
        id: finding.id,
        revision: finding.revision,
        status: finding.status,
        lifecycle: finding.lifecycle,
        severity: finding.severity,
        title: finding.title,
        target: finding.target,
        targetIdentityHash: finding.targetIdentityHash,
        claimIdentityHash: finding.claimIdentityHash,
        semanticClaimIdentityHash: finding.semanticClaimIdentityHash,
        locations: findingFileQuoteLocations(ledger, finding).map(formatFileQuoteLocation),
        description: finding.description,
        suggestion: finding.suggestion,
        reviewers: finding.reviewers,
        rawFindingIds: finding.rawFindingIds,
        rawFindings: finding.rawFindingIds
          .map((rawFindingId) => rawFindingsById.get(rawFindingId))
          .filter((rawFinding): rawFinding is RawFinding => rawFinding !== undefined)
          .map((rawFinding) => managerRawFindingView(rawFinding, ledger.evidenceRecords)),
        evidenceDetails: finding.evidenceIds.map((evidenceId) => (
          ledger.evidenceRecords.find((record) => record.evidenceId === evidenceId) ?? {
            evidenceId,
            protocolError: 'finding evidence record is missing',
          }
        )),
        firstSeen: finding.firstSeen,
        lastSeen: finding.lastSeen,
        waivers: finding.waivers,
        disputes: finding.disputes,
        ...(finding.provisional !== undefined
          ? { provisional: { kind: finding.provisional.kind, reason: finding.provisional.reason } }
          : {}),
      }
      : (() => {
        const sourceBindings = finding.rawFindingIds
          .map((rawFindingId) => rawFindingsById.get(rawFindingId))
          .filter((rawFinding): rawFinding is RawFinding => rawFinding !== undefined)
          .map((rawFinding) => ({
            rawFindingId: rawFinding.rawFindingId,
            targetIdentityHash: rawFinding.targetIdentityHash,
            claimIdentityHash: rawFinding.claimIdentityHash,
            semanticClaimIdentityHash: rawFinding.semanticClaimIdentityHash,
            candidateIdentityHash: rawFinding.candidateIdentityHash,
            sourceBinding: rawFinding.sourceBinding,
          }));
        const evidenceSummaries = finding.evidenceIds.map((evidenceId) => compactEvidenceSummary(
          ledger.evidenceRecords.find((record) => record.evidenceId === evidenceId),
          evidenceId,
        ));
        const locations = findingFileQuoteLocations(ledger, finding).map(formatFileQuoteLocation);
        return {
          id: finding.id,
          revision: finding.revision,
          status: finding.status,
          lifecycle: finding.lifecycle,
          severity: finding.severity,
          title: finding.title,
          target: finding.target,
          targetIdentityHash: finding.targetIdentityHash,
          claimIdentityHash: finding.claimIdentityHash,
          semanticClaimIdentityHash: finding.semanticClaimIdentityHash,
          projectionDigest: computeFindingLifecycleProjectionDigest(finding),
          sourceBindings: compactFindingCollection(sourceBindings),
          evidenceSummaries: compactFindingCollection(evidenceSummaries),
          locations: compactFindingCollection(locations),
          lastSeen: finding.lastSeen,
          ...(finding.provisional !== undefined
            ? { provisional: { kind: finding.provisional.kind, reason: finding.provisional.reason } }
            : {}),
        };
      })())),
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
    const paths = new Set(
      findingFileQuoteLocations(ledger, finding).map(({ path }) => path),
    );
    for (const path of paths) {
      byPath.set(path, [...(byPath.get(path) ?? []), finding]);
    }
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
  const openFindings = selectActionableFindingEntries(ledger);
  for (const raw of residualRawFindings) {
    if (raw.title === null || raw.description === null) {
      throw new Error(`Residual raw finding "${raw.rawFindingId}" has an incomplete claim payload`);
    }
    if (raw.targetFindingId !== null) {
      ids.add(raw.targetFindingId);
    }
    const rawPaths = new Set(rawFindingFileQuoteLocations(raw).map(({ path }) => path));
    const rawTitle = normalizeFindingText(raw.title).toLowerCase();
    const rawSymbols = new Set([...extractSymbols(raw.title), ...extractSymbols(raw.description)]);
    for (const finding of openFindings) {
      const findingPaths = findingFileQuoteLocations(ledger, finding)
        .map(({ path }) => path);
      if (findingPaths.some((path) => rawPaths.has(path))) {
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
  residualRawFindings: RawFinding[];
  mechanicallyClassifiedCount: number;
  priorStepResponseText?: string;
  invalidLocationCandidates: Map<string, string>;
  dismissCandidates: Map<string, string>;
  verifiedEvidenceRecordsByRawFindingId: ReadonlyMap<string, readonly FindingEvidenceRecord[]>;
  fullDetailFindingIds?: ReadonlySet<string>;
}): string {
  const managerInputLedger = buildManagerInputLedger(
    input.previousLedger,
    input.fullDetailFindingIds
      ?? collectFullDetailFindingIds(input.previousLedger, input.residualRawFindings),
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
    managerInputLedger: renderFencedJsonBlock(managerInputLedger),
    rawFindings: renderFencedJsonBlock(input.residualRawFindings.map((rawFinding) => (
      managerRawFindingView(
        rawFinding,
        input.verifiedEvidenceRecordsByRawFindingId.get(rawFinding.rawFindingId) ?? [],
      )
    ))),
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
  const options = {
    ...optionsBuilder.buildAgentOptions(managerStep),
  } as ReturnType<OptionsBuilder['buildAgentOptions']> & {
    permissionResolution?: unknown;
  };
  delete options.permissionResolution;
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
