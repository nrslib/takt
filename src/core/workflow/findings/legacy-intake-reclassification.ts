import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  computeRawPayloadDigest,
  computeTerminalSettlementId,
  findingContentAddress,
} from '../../models/finding-contract-identity.js';
import type {
  FindingLedger,
  FindingObservation,
  FindingProvisionalKind,
  IntakeContractDefect,
  RawFinding,
} from './types.js';
import type { ReviewerAnomalySpec } from './reviewer-anomalies.js';
import { applyReviewerAnomalySpecsToLedger } from './reviewer-anomalies.js';
import { computeReviewerAnomalyStableKey } from './raw-canonicalization.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import { provisionalClaimBindingAuthorizationViolation } from '../../models/finding-provisional-claim-authorization.js';
import type { FindingProvisionalClaimBindingAuthorizationReference } from '../../models/finding-types.js';
import { hasUnsettledActiveConflictOwnership } from './conflict-ownership.js';

const MIGRATABLE_KINDS = new Set<FindingProvisionalKind>([
  'raw-meaning-ambiguous',
  'raw-adjudication-unresolved',
]);
const CLASSIFICATION_AUTHORITY_ID = 'system/intake_observation_classification_v1';
const RECLASSIFICATION_AUTHORITY_ID = 'system/intake_contract_reclassification_v1' as const;

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareBinaryStrings);
}

function missingRequirements(raw: RawFinding): IntakeContractDefect['missingRequirements'] {
  const missing: IntakeContractDefect['missingRequirements'] = [];
  if (raw.familyTag === null) missing.push('familyTag');
  if (raw.severity === null) missing.push('severity');
  if (raw.title === null) missing.push('title');
  if (raw.description === null) missing.push('description');
  if (raw.target.kind === 'review_scope') missing.push('target');
  if (raw.relation === null) missing.push('relation');
  if (raw.evidence.length === 0) missing.push('claimEvidence');
  return sorted(missing) as IntakeContractDefect['missingRequirements'];
}

function contractDefect(input: {
  raw: RawFinding;
  presentationOwnerReviewer: string;
  presentationLimit: number;
}): IntakeContractDefect {
  const missing = missingRequirements(input.raw);
  const reasonCodes: IntakeContractDefect['reasonCodes'] = [];
  if (missing.some((requirement) => (
    requirement === 'familyTag'
    || requirement === 'severity'
    || requirement === 'title'
    || requirement === 'description'
    || requirement === 'target'
    || requirement === 'relation'
  ))) {
    reasonCodes.push('product-identity-incomplete');
  }
  if (input.raw.evidence.length === 0) {
    reasonCodes.push('claim-evidence-missing');
  }
  if (input.raw.rawExcerpt !== undefined && input.raw.rawExcerpt.length > 0
    && input.raw.description === null) {
    reasonCodes.push('normalizer-extraction-loss');
  }
  const observationClass = input.raw.rawExcerpt !== undefined
    || input.raw.description !== null
    || input.raw.evidence.length > 0
    || input.raw.target.kind !== 'review_scope'
    || input.raw.familyTag !== null
    || input.raw.severity !== null
    || input.raw.title !== null
    ? 'claim-bearing' as const
    : 'protocol-noise' as const;
  return {
    observationClass,
    classificationAuthorityId: CLASSIFICATION_AUTHORITY_ID,
    reasonCodes: sorted(reasonCodes) as IntakeContractDefect['reasonCodes'],
    missingRequirements: missing,
    presentationOwnerReviewer: input.presentationOwnerReviewer,
    presentationLimit: Math.max(1, input.presentationLimit),
  };
}

function exactLegacyGraph(input: {
  ledger: FindingLedger;
  findingId: string;
  raw: RawFinding;
}): {
  rawCanonicalSnapshotIds: string[];
  episodeIds: string[];
  attemptIds: string[];
  scopeBindingIds: string[];
  bindingAuthorizationIds: string[];
  bindingDecisionIds: string[];
} | undefined {
  const { ledger, findingId, raw } = input;
  const snapshots = ledger.rawCanonicalSnapshots.filter(
    (snapshot) => snapshot.rawFindingId === raw.rawFindingId,
  );
  if (snapshots.length !== 1) return undefined;
  const snapshot = snapshots[0]!;
  if (
    snapshot.rawPayloadDigest !== computeRawPayloadDigest(raw)
    || snapshot.canonicalProvenance.ambiguityCodes.length === 0
    || snapshot.canonicalProvenance.ambiguityCodes.some((code) => code !== 'missing-required-field')
    || missingRequirements(raw).length === 0
  ) {
    return undefined;
  }
  const observations = ledger.interpretationRawObservations.filter(
    (observation) => observation.rawFindingId === raw.rawFindingId
      && observation.rawCanonicalSnapshotId === snapshot.rawCanonicalSnapshotId,
  );
  if (observations.length !== 1) return undefined;
  const observation = observations[0]!;
  const outcomes = ledger.rawInterpretationOutcomes.filter(
    (outcome) => outcome.rawFindingId === raw.rawFindingId
      && outcome.kind === 'provisional'
      && outcome.provisionalFindingId === findingId,
  );
  if (outcomes.length !== 1) return undefined;
  const attempts = ledger.interpretationAttempts.filter(
    (attempt) => attempt.caseSnapshotId === observation.caseSnapshotId
      && attempt.caseId === observation.caseId
      && attempt.rawFindingIds.length === 1
      && attempt.rawFindingIds[0] === raw.rawFindingId
      && (attempt.stage === 'completed' || attempt.stage === 'applied')
      && attempt.decision.kind === 'provisional',
  );
  if (attempts.length !== 1) return undefined;
  const isolationBindings = ledger.evidenceBindings.filter((binding) => (
    binding.sourceRawFindingId === raw.rawFindingId
      && binding.target.entityKind === 'finding'
      && binding.target.entityId === findingId
      && ledger.evidenceRecords.some((record) => (
        record.evidenceId === binding.evidenceId
        && record.kind === 'engine_proof'
        && record.subject.kind === 'finding_provisional_isolation'
        && record.subject.findingId === findingId
        && record.subject.provisionalKind === 'raw-meaning-ambiguous'
      ))
  ));
  if (isolationBindings.length !== 1) return undefined;
  if (ledger.conflictRawClaimLandings.some((landing) => landing.rawFindingId === raw.rawFindingId)) {
    return undefined;
  }
  const terminalEpisodes = ledger.terminalAdjudicationEpisodes.filter(
    (episode) => episode.findingId === findingId
      && !ledger.terminalAdjudicationSettlements.some(
        (settlement) => settlement.episodeId === episode.episodeId,
      ),
  );
  const terminalAttempts = ledger.terminalAdjudicationAttempts.filter(
    (attempt) => terminalEpisodes.some((episode) => episode.episodeId === attempt.episodeId),
  );
  if (terminalAttempts.some((attempt) => attempt.stage === 'started' || attempt.stage === 'proposed')) {
    return undefined;
  }
  const scopeBindingIds = ledger.findingScopeBindings
    .filter((binding) => binding.findingId === findingId)
    .map(({ bindingId }) => bindingId);
  return {
    rawCanonicalSnapshotIds: [snapshot.rawCanonicalSnapshotId],
    episodeIds: sorted(terminalEpisodes.map(({ episodeId }) => episodeId)),
    attemptIds: sorted(terminalAttempts.map(({ attemptId }) => attemptId)),
    scopeBindingIds: sorted(scopeBindingIds),
    bindingAuthorizationIds: [],
    bindingDecisionIds: [],
  };
}

function exactLegacyGraphB(input: {
  ledger: FindingLedger;
  findingId: string;
  raws: readonly RawFinding[];
}): {
  rawCanonicalSnapshotIds: string[];
  episodeIds: string[];
  attemptIds: string[];
  scopeBindingIds: string[];
  bindingAuthorizationIds: string[];
  bindingDecisionIds: string[];
} | undefined {
  const { ledger, findingId, raws } = input;
  if (raws.length === 0 || raws.some((raw) => raw.evidence.length !== 0)) {
    return undefined;
  }
  const finding = ledger.findings.find((candidate) => candidate.id === findingId);
  if (
    finding?.status !== 'open'
    || finding.provisional === undefined
    || !(
      finding.provisional.kind === 'raw-adjudication-unresolved'
      || finding.provisional.kind === 'raw-meaning-ambiguous'
    )
    || hasUnsettledActiveConflictOwnership(ledger, findingId)
  ) {
    return undefined;
  }
  const rawIds = sorted(raws.map(({ rawFindingId }) => rawFindingId));
  if (!sameStringSet(finding.provisional.sourceRawFindingIds, rawIds)) {
    return undefined;
  }
  if (ledger.conflictRawClaimLandings.some((landing) => rawIds.includes(landing.rawFindingId))) {
    return undefined;
  }
  if (
    ledger.interpretationRawObservations.some((observation) => rawIds.includes(observation.rawFindingId))
    || ledger.rawInterpretationOutcomes.some((outcome) => rawIds.includes(outcome.rawFindingId))
  ) {
    return undefined;
  }
  const snapshots = raws.map((raw) => {
    const matches = ledger.rawCanonicalSnapshots.filter(
      (snapshot) => snapshot.rawFindingId === raw.rawFindingId,
    );
    return matches.length === 1 && matches[0]!.rawPayloadDigest === computeRawPayloadDigest(raw)
      ? matches[0]
      : undefined;
  });
  if (snapshots.some((snapshot) => snapshot === undefined)) {
    return undefined;
  }
  const proofRecords = ledger.evidenceRecords.filter((record) => (
    record.kind === 'engine_proof'
      && 'subject' in record
      && record.subject.kind === 'finding_provisional_isolation'
      && record.subject.findingId === findingId
      && ledger.evidenceBindings.some((binding) => (
        binding.evidenceId === record.evidenceId
          && binding.target.entityKind === 'finding'
          && binding.target.entityId === findingId
          && binding.sourceRawFindingId !== null
          && rawIds.includes(binding.sourceRawFindingId)
      ))
  ));
  if (proofRecords.length !== 1) {
    return undefined;
  }
  const proofRecord = proofRecords[0]!;
  if (
    !('subject' in proofRecord)
    || proofRecord.subject.kind !== 'finding_provisional_isolation'
    || proofRecord.subject.provisionalKind !== finding.provisional.kind
    || proofRecord.subject.stableKey !== finding.provisional.stableKey
  ) {
    return undefined;
  }
  const sourceBindings = ledger.evidenceBindings.filter((binding) => (
    binding.target.entityKind === 'finding'
      && binding.target.entityId === findingId
      && binding.evidenceId === proofRecord.evidenceId
      && binding.sourceRawFindingId !== null
      && rawIds.includes(binding.sourceRawFindingId)
  ));
  if (
    sourceBindings.length !== rawIds.length
    || rawIds.some((rawId) => sourceBindings.filter(
      (binding) => binding.sourceRawFindingId === rawId,
    ).length !== 1)
  ) {
    return undefined;
  }
  const references = proofRecords.flatMap((record) => (
    'subject' in record && record.subject.kind === 'finding_provisional_isolation'
      ? record.subject.claimBindingAuthorizationReferences
      : []
  ));
  const bundleReferences = references.filter((reference) => (
    reference.kind === 'new_provisional_bundle'
      && reference.sourceRawFindingIds.length === rawIds.length
      && JSON.stringify(reference.sourceRawFindingIds) === JSON.stringify(rawIds)
      && provisionalClaimBindingAuthorizationViolation(reference) === undefined
  ));
  if (references.length !== 1 || bundleReferences.length !== 1) {
    return undefined;
  }
  const bundleReference = bundleReferences[0]! as Extract<
    FindingProvisionalClaimBindingAuthorizationReference,
    { kind: 'new_provisional_bundle' }
  >;
  const otherFindingProofs = ledger.evidenceRecords.filter((record) => (
    record.kind === 'engine_proof'
      && 'subject' in record
      && record.subject.kind !== 'finding_provisional_isolation'
      && 'findingId' in record.subject
      && record.subject.findingId === findingId
  ));
  if (otherFindingProofs.length > 0) {
    return undefined;
  }
  const terminalEpisodes = ledger.terminalAdjudicationEpisodes.filter(
    (episode) => episode.findingId === findingId
      && !ledger.terminalAdjudicationSettlements.some(
        (settlement) => settlement.episodeId === episode.episodeId,
      ),
  );
  const terminalAttempts = ledger.terminalAdjudicationAttempts.filter(
    (attempt) => terminalEpisodes.some((episode) => episode.episodeId === attempt.episodeId),
  );
  if (terminalAttempts.some((attempt) => attempt.stage === 'started' || attempt.stage === 'proposed')) {
    return undefined;
  }
  return {
    rawCanonicalSnapshotIds: snapshots.map((snapshot) => snapshot!.rawCanonicalSnapshotId).sort(compareBinaryStrings),
    episodeIds: sorted(terminalEpisodes.map(({ episodeId }) => episodeId)),
    attemptIds: sorted(terminalAttempts.map(({ attemptId }) => attemptId)),
    scopeBindingIds: sorted(ledger.findingScopeBindings
      .filter((binding) => binding.findingId === findingId)
      .map(({ bindingId }) => bindingId)),
    bindingAuthorizationIds: [bundleReference.authorizationId],
    bindingDecisionIds: [bundleReference.bindingDecisionId],
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function legacyAnomalySpec(input: {
  raws: readonly RawFinding[];
  reviewerStableKey: string;
  lineageKey: string;
  defect: IntakeContractDefect;
}): ReviewerAnomalySpec {
  const raw = input.raws[0];
  if (raw === undefined) {
    throw new Error('Legacy intake migration requires at least one source raw finding');
  }
  const stableKey = computeReviewerAnomalyStableKey({
    reviewerStableKey: input.reviewerStableKey,
    lineageKey: input.lineageKey,
    anomalyKind: 'intake-contract-incomplete',
    sourceExcerptDigest: raw.sourceBinding.excerptDigest,
  });
  return {
    kind: 'intake-contract-incomplete',
    stableKey,
    lineageKey: input.lineageKey,
    sourceRawFindingIds: input.raws.map(({ rawFindingId }) => rawFindingId).sort(compareBinaryStrings),
    sourceIntakeIds: [],
    reviewers: [...new Set(input.raws.map(({ reviewer }) => reviewer))].sort(compareBinaryStrings),
    title: raw.title ?? `Legacy incomplete intake ${raw.rawFindingId}`,
    ...(raw.rawExcerpt === undefined ? {} : { claimedExcerpt: raw.rawExcerpt }),
    mismatchReason: 'Legacy provisional was isolated before product-claim adjudication',
    intakeContract: input.defect,
  };
}

export interface LegacyIntakeReclassificationResult {
  ledger: FindingLedger;
  migratedFindingIds: string[];
}

export function migrateLegacyIntakeProvisionalFindings(input: {
  ledger: FindingLedger;
  observation: FindingObservation;
  presentationLimit: number;
}): LegacyIntakeReclassificationResult {
  let ledger = input.ledger;
  const migratedFindingIds: string[] = [];
  for (const finding of input.ledger.findings) {
    if (
      finding.status !== 'open'
      || finding.provisional === undefined
      || finding.reviewerAnomalyReclassification !== undefined
      || !MIGRATABLE_KINDS.has(finding.provisional.kind)
    ) {
      continue;
    }
    const rawMatches = finding.provisional.sourceRawFindingIds.map((rawFindingId) => (
      input.ledger.rawFindings.filter((raw) => raw.rawFindingId === rawFindingId)
    ));
    if (rawMatches.some((matches) => matches.length !== 1)) continue;
    const sourceRaws = rawMatches.map((matches) => matches[0]!);
    const raw = sourceRaws[0]!;
    const graph = finding.provisional.kind === 'raw-adjudication-unresolved'
      ? exactLegacyGraphB({
          ledger: input.ledger,
          findingId: finding.id,
          raws: sourceRaws,
        })
      : sourceRaws.length === 1
        ? exactLegacyGraph({ ledger: input.ledger, findingId: finding.id, raw })
          ?? (sourceRaws.every((sourceRaw) => sourceRaw.evidence.length === 0)
            ? exactLegacyGraphB({
                ledger: input.ledger,
                findingId: finding.id,
                raws: sourceRaws,
              })
            : undefined)
        : undefined;
    if (graph === undefined) continue;
    const snapshot = input.ledger.rawCanonicalSnapshots.find(
      (candidate) => candidate.rawCanonicalSnapshotId === graph.rawCanonicalSnapshotIds[0],
    );
    if (snapshot === undefined) continue;
    const defect = contractDefect({
      raw,
      presentationOwnerReviewer: raw.reviewer,
      presentationLimit: input.presentationLimit,
    });
    const anomalySpec = legacyAnomalySpec({
      raws: sourceRaws,
      reviewerStableKey: snapshot.reviewerStableKey,
      lineageKey: snapshot.lineageKey,
      defect,
    });
    const withAnomaly = applyReviewerAnomalySpecsToLedger(
      ledger,
      [anomalySpec],
      {
        workflowName: ledger.workflowName,
        stepName: input.observation.stepName,
        runId: input.observation.runId,
        timestamp: input.observation.timestamp,
      },
    );
    const anomaly = withAnomaly.reviewerAnomalies!.find((entry) => (
      entry.kind === 'intake-contract-incomplete'
      && entry.stableKey === anomalySpec.stableKey
      && entry.sourceRawFindingIds.includes(raw.rawFindingId)
    ));
    if (anomaly === undefined) {
      throw new Error(`Legacy intake migration did not create anomaly for finding "${finding.id}"`);
    }
    const oldHead = captureFindingLifecycleHead(ledger, 'finding', finding.id);
    if (oldHead === undefined) continue;
    const migrationId = findingContentAddress('intake-contract-reclassification', {
      findingId: finding.id,
      oldHead,
      stableKey: anomalySpec.stableKey,
    });
    const terminalSettlements = graph.episodeIds.flatMap((episodeId) => {
      const episode = ledger.terminalAdjudicationEpisodes.find(
        (candidate) => candidate.episodeId === episodeId,
      );
      if (episode === undefined) return [];
      const settlementId = computeTerminalSettlementId(episodeId);
      return [{
        settlementId,
        episodeId,
        provisionalFindingId: finding.id,
        candidateSnapshotDigest: episode.candidateSnapshotDigest,
        outcome: 'reclassified_to_reviewer_anomaly' as const,
        reason: 'product_claim_not_adjudicated' as const,
        migrationId,
        attemptIds: graph.attemptIds.filter((attemptId) => (
          ledger.terminalAdjudicationAttempts.find((attempt) => attempt.attemptId === attemptId)?.episodeId === episodeId
        )),
        scopeBindingIds: graph.scopeBindingIds,
        recordedAt: structuredClone(input.observation),
      }];
    });
    ledger = {
      ...withAnomaly,
      findings: ledger.findings.map((candidate) => (
        candidate.id === finding.id
          ? {
              ...candidate,
              reviewerAnomalyReclassification: {
                kind: 'reclassified_to_reviewer_anomaly' as const,
                migrationId,
                authorityId: RECLASSIFICATION_AUTHORITY_ID,
                reason: 'product_claim_not_adjudicated' as const,
                anomalyId: anomaly.id,
                oldHead,
                rawFindingIds: sorted(finding.provisional!.sourceRawFindingIds),
                rawCanonicalSnapshotIds: graph.rawCanonicalSnapshotIds,
                terminalEpisodeIds: graph.episodeIds,
                terminalAttemptIds: graph.attemptIds,
                scopeBindingIds: graph.scopeBindingIds,
                bindingAuthorizationIds: graph.bindingAuthorizationIds,
                bindingDecisionIds: graph.bindingDecisionIds,
                recordedAt: structuredClone(input.observation),
              },
            }
          : candidate
      )),
      terminalAdjudicationSettlements: [
        ...ledger.terminalAdjudicationSettlements,
        ...terminalSettlements,
      ],
      updatedAt: input.observation.timestamp,
    };
    migratedFindingIds.push(finding.id);
  }
  return { ledger, migratedFindingIds };
}
