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
import {
  adaptProviderRawDecisions,
  PROVIDER_ANCHOR_RELEVANCE_INSTRUCTION,
} from './manager-raw-decision-adapter.js';
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
import { composeFindingManagerInstruction } from './manager-instruction-composer.js';
import {
  boundPromptArray,
  promptArrayView,
  boundPromptString,
  FINDING_MANAGER_PROMPT_LEDGER_LOCATIONS_ARRAY_MAX_BYTES,
  FINDING_MANAGER_PROMPT_FIELD_LIMITS,
  type PromptTruncationMarker,
} from './prompt-bounds.js';

type ManagerOptionsBuilder = Pick<OptionsBuilder, 'buildAgentOptions'>;

export { RAW_FINDINGS_SCHEMA_REF };
export { FINDING_MANAGER_SCHEMA_REF } from './manager-step.js';

export const SEMANTIC_RESOLUTION_INSTRUCTION = 'For a code resolution_confirmation, resolve only when the materialized quote shows that the original finding failure mode and required fix are actually satisfied. A valid quote at the same path, or a valid quote by itself, is not evidence of semantic resolution.';

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
      const path = boundPromptString({
        value: evidence.path,
        fieldPath: `${rawFinding.rawFindingId}.evidence.path`,
        maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.targetCollectionItemMaxBytes,
      });
      const verbatimExcerpt = boundPromptString({
        value: evidence.verbatimExcerpt,
        fieldPath: `${rawFinding.rawFindingId}.evidence.verbatimExcerpt`,
        maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceVerbatimExcerptMaxBytes,
      });
      return {
        kind: evidence.kind,
        path: path.text,
        ...(path.truncation === undefined ? {} : { pathTruncation: path.truncation }),
        startLine: evidence.startLine,
        endLine: evidence.endLine,
        verbatimExcerpt: verbatimExcerpt.text,
        ...(verbatimExcerpt.truncation === undefined
          ? {}
          : { verbatimExcerptTruncation: verbatimExcerpt.truncation }),
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

function boundedTextField(input: {
  value: string | null | undefined;
  fieldPath: string;
  maxRenderedBytes: number;
}): { value: string | null | undefined; truncation?: PromptTruncationMarker } {
  const value = input.value;
  if (value === undefined || value === null) {
    return { value };
  }
  const bounded = boundPromptString({
    value,
    fieldPath: input.fieldPath,
    maxRenderedBytes: input.maxRenderedBytes,
  });
  return { value: bounded.text, truncation: bounded.truncation };
}

function boundedTargetCollection(input: {
  values: readonly string[];
  fieldPath: string;
  maxRenderedBytes: number;
}): unknown {
  const itemTruncations: Array<{ index: number; marker: PromptTruncationMarker }> = [];
  const boundedItems = input.values.map((value, index) => {
    const bounded = boundPromptString({
      value,
      fieldPath: `${input.fieldPath}[${index}]`,
      maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.targetCollectionItemMaxBytes,
    });
    if (bounded.truncation !== undefined) {
      itemTruncations.push({ index, marker: bounded.truncation });
    }
    return bounded.text;
  });
  const bounded = boundPromptArray({
    items: boundedItems,
    fieldPath: input.fieldPath,
    maxItems: 8,
    maxRenderedBytes: input.maxRenderedBytes,
  });
  const retainedItemTruncations = itemTruncations
    .filter(({ index }) => index < bounded.items.length)
    .map(({ marker }) => marker);
  if (bounded.truncation === undefined && retainedItemTruncations.length === 0) {
    return bounded.items;
  }
  return {
    items: bounded.items,
    ...(bounded.truncation === undefined ? {} : { truncation: bounded.truncation }),
    ...(retainedItemTruncations.length === 0
      ? {}
      : { itemTruncations: retainedItemTruncations }),
  };
}

function boundFindingTarget(target: RawFinding['target']): unknown {
  switch (target.kind) {
    case 'review_scope':
      return { kind: target.kind };
    case 'code':
      return {
        kind: target.kind,
        paths: boundedTargetCollection({
          values: target.paths,
          fieldPath: 'target.paths',
          maxRenderedBytes: TARGET_CODE_PATHS_MAX_RENDERED_BYTES,
        }),
      };
    case 'structure':
      return {
        kind: target.kind,
        scope: {
          kind: target.scope.kind,
          roots: boundedTargetCollection({
            values: target.scope.roots,
            fieldPath: 'target.scope.roots',
            maxRenderedBytes: TARGET_STRUCTURE_COLLECTION_MAX_RENDERED_BYTES,
          }),
        },
        manifestTargets: boundedTargetCollection({
          values: target.manifestTargets,
          fieldPath: 'target.manifestTargets',
          maxRenderedBytes: TARGET_STRUCTURE_COLLECTION_MAX_RENDERED_BYTES,
        }),
      };
    case 'absence': {
      if (target.predicate.kind === 'path_state') {
        const path = boundPromptString({
          value: target.predicate.path,
          fieldPath: 'target.predicate.path',
          maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.targetCollectionItemMaxBytes,
        });
        return {
          kind: target.kind,
          predicate: {
            kind: target.predicate.kind,
            path: path.text,
            expected: target.predicate.expected,
            ...(path.truncation === undefined ? {} : { pathTruncation: path.truncation }),
          },
        };
      }
      const roots = boundedTargetCollection({
        values: target.predicate.roots,
        fieldPath: 'target.predicate.roots',
        maxRenderedBytes: TARGET_ABSENCE_ROOTS_MAX_RENDERED_BYTES,
      });
      const literal = boundPromptString({
        value: target.predicate.literal,
        fieldPath: 'target.predicate.literal',
        maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.targetLiteralMaxBytes,
      });
      return {
        kind: target.kind,
        predicate: {
          kind: target.predicate.kind,
          roots,
          literal: literal.text,
          textDomain: target.predicate.textDomain,
          ...(literal.truncation === undefined ? {} : { literalTruncation: literal.truncation }),
        },
      };
    }
  }
}

export function managerPromptTargetView(target: RawFinding['target']): unknown {
  return boundFindingTarget(target);
}

function boundedEvidenceDetails(
  rawFinding: RawFinding,
  evidenceRecords: readonly FindingEvidenceRecord[],
): unknown {
  const details = managerEvidenceDetails(rawFinding, evidenceRecords);
  return promptArrayView(boundPromptArray({
    items: details,
    fieldPath: `${rawFinding.rawFindingId}.evidenceDetails`,
    maxItems: FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceMaxItems,
    maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerEvidenceArrayMaxBytes,
  }));
}

export function managerRawFindingView(
  rawFinding: RawFinding,
  evidenceRecords: readonly FindingEvidenceRecord[],
): unknown {
  const stepName = boundedTextField({
    value: rawFinding.stepName,
    fieldPath: `${rawFinding.rawFindingId}.stepName`,
    maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.stepNameMaxBytes,
  });
  const reviewer = boundedTextField({
    value: rawFinding.reviewer,
    fieldPath: `${rawFinding.rawFindingId}.reviewer`,
    maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.reviewerMaxBytes,
  });
  const familyTag = boundedTextField({
    value: rawFinding.familyTag,
    fieldPath: `${rawFinding.rawFindingId}.familyTag`,
    maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.familyTagMaxBytes,
  });
  const title = boundedTextField({
    value: rawFinding.title,
    fieldPath: `${rawFinding.rawFindingId}.title`,
    maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.rawTitleMaxBytes,
  });
  const description = boundedTextField({
    value: rawFinding.description,
    fieldPath: `${rawFinding.rawFindingId}.description`,
    maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.rawDescriptionMaxBytes,
  });
  const suggestion = boundedTextField({
    value: rawFinding.suggestion,
    fieldPath: `${rawFinding.rawFindingId}.suggestion`,
    maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.rawSuggestionMaxBytes,
  });
  const rawExcerpt = boundedTextField({
    value: rawFinding.rawExcerpt,
    fieldPath: `${rawFinding.rawFindingId}.rawExcerpt`,
    maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.rawExcerptMaxBytes,
  });
  return {
    rawFindingId: rawFinding.rawFindingId,
    stepName: stepName.value,
    ...(stepName.truncation === undefined ? {} : { stepNameTruncation: stepName.truncation }),
    reviewer: reviewer.value,
    ...(reviewer.truncation === undefined ? {} : { reviewerTruncation: reviewer.truncation }),
    familyTag: familyTag.value,
    ...(familyTag.truncation === undefined ? {} : { familyTagTruncation: familyTag.truncation }),
    severity: rawFinding.severity,
    title: title.value,
    ...(title.truncation === undefined ? {} : { titleTruncation: title.truncation }),
    description: description.value,
    ...(description.truncation === undefined ? {} : { descriptionTruncation: description.truncation }),
    suggestion: suggestion.value,
    ...(suggestion.truncation === undefined ? {} : { suggestionTruncation: suggestion.truncation }),
    target: boundFindingTarget(rawFinding.target),
    targetIdentityHash: rawFinding.targetIdentityHash,
    claimIdentityHash: rawFinding.claimIdentityHash,
    semanticClaimIdentityHash: rawFinding.semanticClaimIdentityHash,
    candidateIdentityHash: rawFinding.candidateIdentityHash,
    ...(rawFinding.reassertsReviewerAnomalyId === undefined
      ? {}
      : { reassertsReviewerAnomalyId: rawFinding.reassertsReviewerAnomalyId }),
    rawExcerpt: rawExcerpt.value,
    ...(rawExcerpt.truncation === undefined ? {} : { rawExcerptTruncation: rawExcerpt.truncation }),
    sourceBinding: {
      reportDigest: rawFinding.sourceBinding.reportDigest,
      startByte: rawFinding.sourceBinding.startByte,
      endByte: rawFinding.sourceBinding.endByte,
      excerptDigest: rawFinding.sourceBinding.excerptDigest,
    },
    relation: rawFinding.relation,
    targetFindingId: rawFinding.targetFindingId,
    ...(rawFinding.targetPrecondition === undefined
      ? {}
      : { targetPrecondition: rawFinding.targetPrecondition }),
    evidence: promptArrayView(boundPromptArray({
      items: rawFinding.evidence.map((evidence, index) => (
        evidence.kind === 'file_quote'
          ? (() => {
              const path = boundPromptString({
                value: evidence.path,
                fieldPath: `${rawFinding.rawFindingId}.evidence[${index}].path`,
                maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.targetCollectionItemMaxBytes,
              });
              const verbatimExcerpt = boundPromptString({
                value: evidence.verbatimExcerpt,
                fieldPath: `${rawFinding.rawFindingId}.evidence[${index}].verbatimExcerpt`,
                maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceVerbatimExcerptMaxBytes,
              });
              return {
                kind: evidence.kind,
                path: path.text,
                ...(path.truncation === undefined ? {} : { pathTruncation: path.truncation }),
                startLine: evidence.startLine,
                endLine: evidence.endLine,
                verbatimExcerpt: verbatimExcerpt.text,
                ...(verbatimExcerpt.truncation === undefined
                  ? {}
                  : { verbatimExcerptTruncation: verbatimExcerpt.truncation }),
                snapshotId: evidence.snapshotId,
              };
            })()
          : { kind: evidence.kind, proofId: evidence.proofId }
      )),
      fieldPath: `${rawFinding.rawFindingId}.evidence`,
      maxItems: FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceMaxItems,
      maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceArrayMaxBytes,
    })),
    evidenceDetails: boundedEvidenceDetails(rawFinding, evidenceRecords),
  };
}

function digestCompactValue(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

const COMPACT_FINDING_COLLECTION_LIMIT = 16;
const TARGET_CODE_PATHS_MAX_RENDERED_BYTES = 768;
const TARGET_STRUCTURE_COLLECTION_MAX_RENDERED_BYTES = 384;
const TARGET_ABSENCE_ROOTS_MAX_RENDERED_BYTES = 256;

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

function boundedLedgerTextField(input: {
  value: string | null | undefined;
  fieldPath: string;
  maxRenderedBytes: number;
}): Record<string, unknown> {
  const bounded = boundedTextField(input);
  return {
    ...(input.value === undefined ? {} : { value: bounded.value }),
    ...(bounded.truncation === undefined ? {} : { truncation: bounded.truncation }),
  };
}

function boundedLedgerLocations(
  ledger: FindingLedger,
  finding: FindingLedger['findings'][number],
): unknown {
  const itemTruncations: Array<{ index: number; marker: PromptTruncationMarker }> = [];
  const boundedLocations = findingFileQuoteLocations(ledger, finding).map((location, index) => {
    const bounded = boundPromptString({
      value: formatFileQuoteLocation(location),
      fieldPath: `${finding.id}.locations[${index}]`,
      maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerLocationMaxBytes,
    });
    if (bounded.truncation !== undefined) {
      itemTruncations.push({ index, marker: bounded.truncation });
    }
    return bounded.text;
  });
  const bounded = boundPromptArray({
    items: boundedLocations,
    fieldPath: `${finding.id}.locations`,
    maxItems: FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerMaxLocations,
    maxRenderedBytes: FINDING_MANAGER_PROMPT_LEDGER_LOCATIONS_ARRAY_MAX_BYTES,
  });
  const retainedItemTruncations = itemTruncations
    .filter(({ index }) => index < bounded.items.length)
    .map(({ marker }) => marker);
  if (bounded.truncation === undefined && retainedItemTruncations.length === 0) {
    return bounded.items;
  }
  return {
    items: bounded.items,
    ...(bounded.truncation === undefined ? {} : { truncation: bounded.truncation }),
    ...(retainedItemTruncations.length === 0
      ? {}
      : { itemTruncations: retainedItemTruncations }),
  };
}

function boundedLedgerEvidenceDetails(
  ledger: FindingLedger,
  finding: FindingLedger['findings'][number],
): unknown {
  const details = finding.evidenceIds.map((evidenceId) => {
    const record = ledger.evidenceRecords.find((candidate) => candidate.evidenceId === evidenceId);
    if (record === undefined || record.kind !== 'file_quote') {
      return record ?? {
        evidenceId,
        protocolError: 'finding evidence record is missing',
      };
    }
    const path = boundPromptString({
      value: record.path,
      fieldPath: `${finding.id}.evidenceDetails.${evidenceId}.path`,
      maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.targetCollectionItemMaxBytes,
    });
    const excerpt = boundPromptString({
      value: record.verbatimExcerpt,
      fieldPath: `${finding.id}.evidenceDetails.${evidenceId}.verbatimExcerpt`,
      maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerEvidenceVerbatimExcerptMaxBytes,
    });
    return {
      kind: record.kind,
      evidenceId: record.evidenceId,
      claimIdentityHash: record.claimIdentityHash,
      path: path.text,
      ...(path.truncation === undefined ? {} : { pathTruncation: path.truncation }),
      startLine: record.startLine,
      endLine: record.endLine,
      verbatimExcerpt: excerpt.text,
      ...(excerpt.truncation === undefined
        ? {}
        : { verbatimExcerptTruncation: excerpt.truncation }),
      snapshotId: record.snapshotId,
      fileHash: record.fileHash,
    };
  });
  return promptArrayView(boundPromptArray({
    items: details,
    fieldPath: `${finding.id}.evidenceDetails`,
    maxItems: FINDING_MANAGER_PROMPT_FIELD_LIMITS.evidenceMaxItems,
    maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerEvidenceArrayMaxBytes,
  }));
}

function boundedLedgerTarget(target: FindingLedger['findings'][number]['target']): unknown {
  return target === null ? null : boundFindingTarget(target);
}

/**
 * run-level の invalid_manager_output は存在しない。manager の壊れた応答・
 * 予算超過・解釈不能はすべて provisional として台帳へ着地し、run は継続する
 * （final gate は provisional が閉じ続ける）。
 */
export function buildManagerInputLedger(
  ledger: FindingLedger,
  fullDetailFindingIds?: ReadonlySet<string>,
  options?: {
    includeRawFindingDetails?: boolean;
  },
): unknown {
  const rawFindingsById = new Map(ledger.rawFindings.map((rawFinding) => [rawFinding.rawFindingId, rawFinding]));
  const includeRawFindingDetails = options?.includeRawFindingDetails ?? true;
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
        ...(() => {
          const title = boundedLedgerTextField({
            value: finding.title,
            fieldPath: `${finding.id}.title`,
            maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerTitleMaxBytes,
          });
          return {
            title: title.value,
            ...(title.truncation === undefined ? {} : { titleTruncation: title.truncation }),
          };
        })(),
        target: boundedLedgerTarget(finding.target),
        targetIdentityHash: finding.targetIdentityHash,
        claimIdentityHash: finding.claimIdentityHash,
        semanticClaimIdentityHash: finding.semanticClaimIdentityHash,
        locations: boundedLedgerLocations(ledger, finding),
        ...(() => {
          const description = boundedLedgerTextField({
            value: finding.description,
            fieldPath: `${finding.id}.description`,
            maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerDescriptionMaxBytes,
          });
          const suggestion = boundedLedgerTextField({
            value: finding.suggestion,
            fieldPath: `${finding.id}.suggestion`,
            maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerSuggestionMaxBytes,
          });
          return {
            description: description.value,
            suggestion: suggestion.value,
            ...(description.truncation === undefined
              ? {}
              : { descriptionTruncation: description.truncation }),
            ...(suggestion.truncation === undefined
              ? {}
              : { suggestionTruncation: suggestion.truncation }),
          };
        })(),
        reviewers: finding.reviewers,
        rawFindingIds: finding.rawFindingIds,
        ...(includeRawFindingDetails
          ? {
              rawFindings: finding.rawFindingIds
                .map((rawFindingId) => rawFindingsById.get(rawFindingId))
                .filter((rawFinding): rawFinding is RawFinding => rawFinding !== undefined)
                .map((rawFinding) => managerRawFindingView(rawFinding, ledger.evidenceRecords)),
            }
          : {}),
        evidenceDetails: boundedLedgerEvidenceDetails(ledger, finding),
        firstSeen: finding.firstSeen,
        lastSeen: finding.lastSeen,
        waivers: finding.waivers,
        disputes: finding.disputes,
        ...(finding.provisional !== undefined
          ? (() => {
              const reason = boundPromptString({
                value: finding.provisional.reason,
                fieldPath: `${finding.id}.provisional.reason`,
                maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.provisionalReasonMaxBytes,
              });
              return {
                provisional: {
                  kind: finding.provisional.kind,
                  reason: reason.text,
                  ...(reason.truncation === undefined ? {} : { reasonTruncation: reason.truncation }),
                },
              };
            })()
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
        const title = boundedLedgerTextField({
          value: finding.title,
          fieldPath: `${finding.id}.title`,
          maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerTitleMaxBytes,
        });
        return {
          id: finding.id,
          revision: finding.revision,
          status: finding.status,
          lifecycle: finding.lifecycle,
          severity: finding.severity,
          title: title.value,
          ...(title.truncation === undefined ? {} : { titleTruncation: title.truncation }),
          target: boundedLedgerTarget(finding.target),
          targetIdentityHash: finding.targetIdentityHash,
          claimIdentityHash: finding.claimIdentityHash,
          semanticClaimIdentityHash: finding.semanticClaimIdentityHash,
          projectionDigest: computeFindingLifecycleProjectionDigest(finding),
          sourceBindings: compactFindingCollection(sourceBindings),
          evidenceSummaries: compactFindingCollection(evidenceSummaries),
          locations: compactFindingCollection(locations.map((location, index) => {
            const bounded = boundPromptString({
              value: location,
              fieldPath: `${finding.id}.locations[${index}]`,
              maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.ledgerLocationMaxBytes,
            });
            return {
              location: bounded.text,
              ...(bounded.truncation === undefined
                ? {}
                : { locationTruncation: bounded.truncation }),
            };
          })),
          lastSeen: finding.lastSeen,
          ...(finding.provisional !== undefined
            ? (() => {
                const reason = boundPromptString({
                  value: finding.provisional.reason,
                  fieldPath: `${finding.id}.provisional.reason`,
                  maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.provisionalReasonMaxBytes,
                });
                return {
                  provisional: {
                    kind: finding.provisional.kind,
                    reason: reason.text,
                    ...(reason.truncation === undefined ? {} : { reasonTruncation: reason.truncation }),
                  },
                };
              })()
            : {}),
        };
      })())),
    conflicts: ledger.conflicts.map((conflict) => ({
      id: conflict.id,
      status: conflict.status,
      findingIds: conflict.findingIds,
      rawFindingIds: conflict.rawFindingIds,
      ...(() => {
        const description = boundPromptString({
          value: conflict.description,
          fieldPath: `${conflict.id}.description`,
          maxRenderedBytes: FINDING_MANAGER_PROMPT_FIELD_LIMITS.conflictReasonMaxBytes,
        });
        return {
          description: description.text,
          ...(description.truncation === undefined
            ? {}
            : { descriptionTruncation: description.truncation }),
        };
      })(),
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
  const managerInstruction = [
    input.contract.manager.instruction,
    '',
    SEMANTIC_RESOLUTION_INSTRUCTION,
    ...(input.mechanicallyClassifiedCount > 0
      ? [
        '',
        `NOTE: ${input.mechanicallyClassifiedCount} raw findings (exact duplicates and explicit persists references) were already classified mechanically by the engine and are NOT shown below. Classify only the raw findings listed below. Do not reference raw finding ids that are not listed.`,
      ]
      : []),
  ].join('\n');
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
  const baseInstruction = loadTemplate('finding_manager_instruction', 'en', {
    managerInstruction,
    outputContract: input.contract.manager.outputContract,
    anchorRelevanceInstruction: PROVIDER_ANCHOR_RELEVANCE_INSTRUCTION,
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
  return composeFindingManagerInstruction({
    baseInstruction,
    policyContents: input.contract.manager.policyContents,
    knowledgeContents: input.contract.manager.knowledgeContents,
  });
}

export function parseManagerDecisions(
  response: AgentResponse,
  rawFindings: readonly RawFinding[],
): FindingManagerDecisions {
  if (response.status !== 'done') {
    const detail = response.error ?? response.content;
    throw new Error(`Finding manager failed with status "${response.status}": ${detail}`);
  }
  const output = response.structuredOutput;
  if (typeof output !== 'object' || output == null || Array.isArray(output)) {
    throw new Error('Finding manager output must be an object');
  }
  const providerDecisions = parseFindingManagerDecisions(output);
  return {
    ...providerDecisions,
    rawDecisions: adaptProviderRawDecisions(
      providerDecisions.rawDecisions,
      rawFindings,
    ),
  };
}

export function buildManagerAgentOptions(
  optionsBuilder: ManagerOptionsBuilder,
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
  optionsBuilder: ManagerOptionsBuilder;
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
  optionsBuilder: ManagerOptionsBuilder;
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
