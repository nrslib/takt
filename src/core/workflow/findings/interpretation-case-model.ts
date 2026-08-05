import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  binarySortedUnique,
  findingContentAddress,
} from '../../models/finding-contract-identity.js';
import {
  computeClaimIdentityHash,
  computeSemanticClaimIdentityHash,
  computeTargetIdentityHash,
} from '../../models/finding-claim-identity.js';
import type {
  CanonicalRawFinding,
  EngineProofSubject,
  FindingLedger,
  FindingEvidenceRecord,
  InterpretationCase,
  InterpretationCaseMember,
  InterpretationDecision,
  InterpretationPolicyClass,
  SemanticDecisionContextV1,
  TargetSemanticHeadV1,
} from './types.js';
import {
  assertCanonicalIntakeRecoveryStates,
  type CanonicalIntakeItem,
} from './manager-admission.js';
import { canonicalRawIntegrityDigestOf } from './raw-canonicalization.js';
import {
  issueDeterministicSameProofs,
} from './raw-capabilities.js';

const CASE_MODEL_VERSION = 1;

function hashDomain<Value extends object>(
  domain: string,
  value: Value,
): string {
  return findingContentAddress(
    domain,
    value as unknown as Readonly<Record<string, unknown>>,
  );
}

function policyClassFor(
  canonical: CanonicalRawFinding,
  provisionalOnlyRawFindingIds: ReadonlySet<string>,
): InterpretationPolicyClass {
  if (provisionalOnlyRawFindingIds.has(canonical.rawFindingId)) {
    return 'provisional_only';
  }
  return canonical.relation === 'resolution_confirmation'
    ? 'confirmation'
    : 'general';
}

function caseIdFor(
  canonical: CanonicalRawFinding,
  policyClass: InterpretationPolicyClass,
): string {
  return hashDomain('interpretation-case', {
    version: CASE_MODEL_VERSION,
    reviewerStableKey: canonical.reviewerStableKey,
    lineageKey: canonical.lineageKey,
    policyClass,
  });
}

function sortedUnique<Value extends string>(values: readonly Value[]): Value[] {
  return binarySortedUnique([...new Set(values)]) as Value[];
}

function assertNever(value: never): never {
  throw new Error(`Unsupported semantic evidence variant: ${canonicalJson(value)}`);
}

function semanticEngineProofSubject(subject: EngineProofSubject): unknown {
  switch (subject.kind) {
    case 'repository_manifest':
      return {
        kind: subject.kind,
        scope: {
          kind: subject.scope.kind,
          roots: sortedUnique(subject.scope.roots),
        },
        manifestTargets: sortedUnique(subject.manifestTargets),
        observedTargets: sortedUnique(subject.observedTargets),
      };
    case 'repository_query':
      return {
        kind: subject.kind,
        predicate: subject.predicate.kind === 'path_state'
          ? {
              kind: subject.predicate.kind,
              path: subject.predicate.path,
              expected: subject.predicate.expected,
            }
          : {
              kind: subject.predicate.kind,
              roots: sortedUnique(subject.predicate.roots),
              literal: subject.predicate.literal,
              textDomain: subject.predicate.textDomain,
            },
        result: subject.result,
        coverage: subject.coverage,
      };
    case 'authoritative_quote':
      return {
        kind: subject.kind,
        source: subject.source,
        declarationId: subject.declarationId,
        verbatimExcerpt: subject.verbatimExcerpt,
      };
    case 'finding_provisional_isolation':
      return {
        kind: subject.kind,
        findingId: subject.findingId,
        provisionalKind: subject.provisionalKind,
        stableKey: subject.stableKey,
      };
    case 'finding_target_invalid':
      return {
        kind: subject.kind,
        findingId: subject.findingId,
        reason: subject.reason,
      };
    case 'finding_claim_sets_equal':
      return {
        kind: subject.kind,
        findingIds: sortedUnique(subject.findingIds),
        semanticClaimIdentityHashes: sortedUnique(subject.semanticClaimIdentityHashes),
      };
    case 'finding_provisional_product_transition':
      return {
        kind: subject.kind,
        operation: subject.operation,
        findingId: subject.findingId,
        targetIdentityHash: subject.targetIdentityHash,
        materializedProductClaimDigest: subject.materializedProductClaimDigest,
      };
    case 'finding_claim_identical':
      return {
        kind: subject.kind,
        adjudicationKind: subject.adjudicationKind,
        subjectIds: sortedUnique(subject.subjectIds),
        findingIds: sortedUnique(subject.findingIds),
        claimSnapshotDigests: sortedUnique(subject.claimSnapshotDigests),
        rawClaimRefIds: sortedUnique(subject.rawClaimRefIds),
        exactClaimIdentityDigest: subject.exactClaimIdentityDigest,
      };
    case 'raw_provisional_claim_identical':
      return {
        kind: subject.kind,
        rawFindingId: subject.rawFindingId,
        rawCanonicalSnapshotId: subject.rawCanonicalSnapshotId,
        targetFindingId: subject.targetFindingId,
        targetIdentityHash: subject.targetIdentityHash,
        claimIdentityHash: subject.claimIdentityHash,
        semanticClaimIdentityHash: subject.semanticClaimIdentityHash,
        exactClaimIdentityDigest: subject.exactClaimIdentityDigest,
      };
    case 'finding_claim_supported_after_verification':
      return {
        kind: subject.kind,
        adjudicationKind: subject.adjudicationKind,
        subjectId: subject.subjectId,
        findingId: subject.findingId,
        rawClaimRefIds: sortedUnique(subject.rawClaimRefIds),
        productProjectionDigest: subject.productProjectionDigest,
      };
    case 'finding_no_issue_after_verification':
    case 'finding_claim_refuted':
      return {
        kind: subject.kind,
        adjudicationKind: subject.adjudicationKind,
        subjectId: subject.subjectId,
        findingId: subject.findingId,
        claimSnapshotDigest: subject.claimSnapshotDigest,
        rawClaimRefIds: sortedUnique(subject.rawClaimRefIds),
      };
    default:
      return assertNever(subject);
  }
}

function semanticEvidenceRecord(record: FindingEvidenceRecord): unknown {
  if (record.kind === 'file_quote') {
    return {
      kind: record.kind,
      path: record.path,
      startLine: record.startLine,
      endLine: record.endLine,
      verbatimExcerpt: record.verbatimExcerpt,
    };
  }
  const base = {
    kind: record.kind,
    purpose: record.purpose,
    verifierId: record.verifierId,
    verifierVersion: record.verifierVersion,
    claimIdentityHash: record.claimIdentityHash,
    targetFindingId: record.targetFindingId,
    subject: semanticEngineProofSubject(record.subject),
    resultDigest: record.resultDigest,
  };
  return record.subject.kind === 'finding_provisional_product_transition'
    ? base
    : {
        ...base,
        dependencyDigests: sortedUnique(record.dependencyDigests),
      };
}

function uniqueSortedEvidenceProjections(
  records: readonly FindingEvidenceRecord[],
): unknown[] {
  const byProjection = new Map<string, unknown>();
  for (const record of records) {
    const projection = semanticEvidenceRecord(record);
    byProjection.set(canonicalJson(projection), projection);
  }
  return [...byProjection]
    .sort(([left], [right]) => compareBinaryStrings(left, right))
    .map(([, projection]) => projection);
}

function evidenceContentDigest(records: readonly FindingEvidenceRecord[]): string {
  const projections = uniqueSortedEvidenceProjections(records);
  return hashDomain('interpretation-evidence-content', {
    version: CASE_MODEL_VERSION,
    records: projections,
  });
}

function rawEvidenceContentDigest(canonical: CanonicalRawFinding): string {
  const proofRecords = new Map(
    canonical.issuedEngineProofRecords.map((record) => [record.proofId, record]),
  );
  const projections = canonical.evidence.map((evidence) => {
    if (evidence.kind === 'file_quote') {
      return {
        kind: evidence.kind,
        path: evidence.path,
        startLine: evidence.startLine,
        endLine: evidence.endLine,
        verbatimExcerpt: evidence.verbatimExcerpt,
      };
    }
    const record = proofRecords.get(evidence.proofId);
    if (record === undefined) {
      throw new Error(`Canonical raw finding "${canonical.rawFindingId}" references unavailable engine proof content`);
    }
    return semanticEvidenceRecord(record);
  });
  const uniqueProjections = [...new Map(projections.map((projection) => [
    canonicalJson(projection),
    projection,
  ])).entries()]
    .sort(([left], [right]) => compareBinaryStrings(left, right))
    .map(([, projection]) => projection);
  return hashDomain('interpretation-raw-evidence-content', {
    version: CASE_MODEL_VERSION,
    evidence: uniqueProjections,
  });
}

function targetSemanticHead(
  targetFindingId: string,
  ledger: FindingLedger,
  currentCaseId: string,
): TargetSemanticHeadV1 | null {
  const target = ledger.findings.find((finding) => finding.id === targetFindingId);
  if (target === undefined) {
    return null;
  }
  const evidenceRecords = target.evidenceIds.flatMap((evidenceId) => {
    const record = ledger.evidenceRecords.find((candidate) => candidate.evidenceId === evidenceId);
    if (record === undefined) {
      throw new Error(`Finding "${target.id}" references missing evidence content "${evidenceId}"`);
    }
    const bindings = ledger.evidenceBindings.filter((binding) => (
      binding.evidenceId === evidenceId
      && binding.target.entityKind === 'finding'
      && binding.target.entityId === target.id
    ));
    if (bindings.length === 0) {
      throw new Error(`Finding "${target.id}" evidence "${evidenceId}" has no contribution origin`);
    }
    const externallyContributed = bindings.some((binding) => (
      binding.contributionOrigin.kind === 'external'
      || binding.contributionOrigin.caseId !== currentCaseId
    ));
    return externallyContributed ? [record] : [];
  });
  return {
    targetFindingId: target.id,
    status: target.status,
    lifecycle: target.lifecycle,
    target: target.target === null ? null : structuredClone(target.target),
    targetIdentityHash: target.targetIdentityHash,
    claimIdentityHash: target.claimIdentityHash,
    semanticClaimIdentityHash: target.semanticClaimIdentityHash,
    severity: target.severity,
    title: target.title,
    description: target.description ?? null,
    suggestion: target.suggestion ?? null,
    evidenceContentDigest: evidenceContentDigest(evidenceRecords),
  };
}

function hasValidProductIdentity(canonical: CanonicalRawFinding): boolean {
  if (
    canonical.familyTag === undefined
    || canonical.familyTag.trim().length === 0
    || canonical.severity === undefined
    || canonical.title === undefined
    || canonical.title.trim().length === 0
    || canonical.description === undefined
    || canonical.description.trim().length === 0
  ) {
    return false;
  }
  const suggestion = canonical.suggestion ?? null;
  return canonical.targetIdentityHash === computeTargetIdentityHash(canonical.target)
    && canonical.claimIdentityHash === computeClaimIdentityHash({
      target: canonical.target,
      familyTag: canonical.familyTag,
      severity: canonical.severity,
      title: canonical.title,
      description: canonical.description,
      suggestion,
    })
    && canonical.semanticClaimIdentityHash === computeSemanticClaimIdentityHash({
      target: canonical.target,
      title: canonical.title,
      description: canonical.description,
    });
}

function semanticDecisionContext(input: {
  caseId: string;
  canonical: CanonicalRawFinding;
  ledger: FindingLedger;
  policyClass: InterpretationPolicyClass;
}): SemanticDecisionContextV1 {
  const mayCreateIndependentFinding = input.policyClass === 'general'
    && hasValidProductIdentity(input.canonical);
  const candidateTargets = (input.canonical.targetFindingId === undefined
    ? []
    : [input.canonical.targetFindingId]).flatMap((targetFindingId) => {
    const head = targetSemanticHead(targetFindingId, input.ledger, input.caseId);
    return head === null ? [] : [head];
  });
  return {
    version: 1,
    claim: {
      familyTag: input.canonical.familyTag ?? null,
      severity: input.canonical.severity ?? null,
      title: input.canonical.title ?? null,
      description: input.canonical.description ?? null,
      suggestion: input.canonical.suggestion ?? null,
      relation: input.canonical.relation,
      targetFindingId: input.canonical.targetFindingId ?? null,
      target: structuredClone(input.canonical.target),
      targetIdentityHash: input.canonical.targetIdentityHash,
      claimIdentityHash: input.canonical.claimIdentityHash,
      semanticClaimIdentityHash: input.canonical.semanticClaimIdentityHash,
      evidenceContentDigest: rawEvidenceContentDigest(input.canonical),
    },
    ambiguityCodes: sortedUnique(input.canonical.provenance.ambiguityCodes),
    policyClass: input.policyClass,
    capabilities: {
      mayCreateIndependentFinding,
      mayOpenConflict: input.policyClass !== 'provisional_only'
        && candidateTargets.some((target) => target.status === 'open'),
      mayCreateProvisional: true,
    },
    candidateTargets,
  };
}

interface PlannedMember {
  member: InterpretationCaseMember;
  decisionContext: SemanticDecisionContextV1;
  semanticProjectionDigest: string;
}

function mixedProjectionDigest(digests: readonly string[]): string {
  return hashDomain('interpretation-mixed-semantic-projections', {
    version: CASE_MODEL_VERSION,
    semanticProjectionDigests: [...digests].sort(compareBinaryStrings),
  });
}

export function createInterpretationCases(input: {
  items: readonly CanonicalIntakeItem[];
  ledger: FindingLedger;
  provisionalOnlyRawFindingIds: ReadonlySet<string>;
}): InterpretationCase[] {
  assertCanonicalIntakeRecoveryStates(input.items, input.ledger);
  const rawFindingIds = new Set<string>();
  for (const item of input.items) {
    if (rawFindingIds.has(item.canonical.rawFindingId)) {
      throw new Error(`Duplicate canonical raw finding id "${item.canonical.rawFindingId}" in interpretation cases`);
    }
    rawFindingIds.add(item.canonical.rawFindingId);
  }

  const proofBindings = issueDeterministicSameProofs({
    ledger: input.ledger,
    ambiguousRawFindings: input.items.map((item) => item.canonical),
    excludedTargetFindingIdsByRawFindingId: new Map(),
  });
  const grouped = new Map<string, {
    lineageKey: string;
    policyClass: InterpretationPolicyClass;
    members: PlannedMember[];
  }>();

  for (const item of input.items) {
    const canonical = item.canonical;
    const policyClass = policyClassFor(canonical, input.provisionalOnlyRawFindingIds);
    const caseId = caseIdFor(canonical, policyClass);
    const proofBinding = policyClass === 'general'
      ? proofBindings.get(canonical.rawFindingId)
      : undefined;
    const decisionContext = semanticDecisionContext({
      caseId,
      canonical,
      ledger: input.ledger,
      policyClass,
    });
    const plannedMember: PlannedMember = {
      member: {
        rawFindingId: canonical.rawFindingId,
        canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(canonical),
        ...(proofBinding === undefined ? {} : { proofBinding }),
      },
      decisionContext,
      semanticProjectionDigest: hashDomain(
        'interpretation-semantic-projection',
        decisionContext,
      ),
    };
    const existing = grouped.get(caseId);
    if (existing === undefined) {
      grouped.set(caseId, {
        lineageKey: canonical.lineageKey,
        policyClass,
        members: [plannedMember],
      });
    } else {
      if (existing.lineageKey !== canonical.lineageKey) {
        throw new Error(`Interpretation case "${caseId}" contains mixed lineages`);
      }
      existing.members.push(plannedMember);
    }
  }

  return [...grouped]
    .sort(([left], [right]) => compareBinaryStrings(left, right))
    .map(([caseId, group]) => {
      const members = [...group.members].sort((left, right) => (
        compareBinaryStrings(left.member.rawFindingId, right.member.rawFindingId)
      ));
      const distinctDigests = [...new Set(
        members.map((member) => member.semanticProjectionDigest),
      )].sort(compareBinaryStrings);
      if (distinctDigests.length !== 1) {
        return {
          kind: 'case_provisional',
          caseId,
          lineageKey: group.lineageKey,
          policyClass: group.policyClass,
          semanticProjectionDigest: mixedProjectionDigest(distinctDigests),
          members: members.map(({ member }) => member),
          decisionContext: null,
          reason: 'Interpretation case contains mixed semantic projections',
        } satisfies InterpretationCase;
      }
      return {
        kind: 'provider_case',
        caseId,
        lineageKey: group.lineageKey,
        policyClass: group.policyClass,
        semanticProjectionDigest: distinctDigests[0]!,
        members: members.map(({ member }) => member),
        decisionContext: members[0]!.decisionContext,
      } satisfies InterpretationCase;
    });
}

function provisional(reason: string): InterpretationDecision {
  return { kind: 'provisional', reason };
}

export function validateInterpretationCaseDecision(input: {
  plannedCase: InterpretationCase;
  decision: InterpretationDecision;
  ledger: FindingLedger;
}): InterpretationDecision {
  if (input.plannedCase.kind === 'case_provisional') {
    return provisional(input.plannedCase.reason);
  }
  if (input.decision.kind === 'provisional') {
    return input.decision.reason.length > 0
      ? input.decision
      : provisional('Interpretation provider returned an empty provisional reason');
  }
  if (input.plannedCase.policyClass === 'provisional_only') {
    return provisional('Interpretation policy permits only a provisional decision');
  }
  if (
    input.plannedCase.policyClass === 'confirmation'
    && input.decision.kind === 'create_independent'
  ) {
    return provisional('Confirmation interpretation cannot create a product finding');
  }
  if (
    input.decision.kind === 'create_independent'
    && !input.plannedCase.decisionContext.capabilities.mayCreateIndependentFinding
  ) {
    return provisional('Independent finding creation requires a complete, identity-valid product payload for every case member');
  }
  if (input.decision.kind === 'open_conflict') {
    const targetFindingId = input.decision.targetFindingId;
    if (!input.plannedCase.decisionContext.capabilities.mayOpenConflict) {
      return provisional('Open-conflict is not an engine-issued capability for this interpretation case');
    }
    if (!input.plannedCase.decisionContext.candidateTargets.some(
      (candidate) => candidate.targetFindingId === targetFindingId,
    )) {
      return provisional('Conflict target is outside the engine-derived candidate target set');
    }
    const target = input.ledger.findings.find(
      (finding) => finding.id === targetFindingId,
    );
    if (target === undefined || target.status !== 'open') {
      return provisional('Conflict target does not exist as an open finding');
    }
  }
  return input.decision;
}
