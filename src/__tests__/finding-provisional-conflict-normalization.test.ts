import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatConflictId } from '../core/models/finding-conflict-identity.js';
import { computeFileQuoteEvidenceRecordId } from '../core/models/finding-evidence-record.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import {
  binarySortedUnique,
  computeLegacyProvisionalConflictBatchFingerprintDigest,
  computeProvisionalConflictDecisionDigest,
  computeProvisionalConflictFinalIntentDigest,
  computeProvisionalConflictNormalizationId,
  computeProvisionalConflictNormalizationSettlementId,
} from '../core/models/finding-contract-identity.js';
import {
  createFindingLifecycleEvent,
  createFindingLifecycleReservation,
  computeFindingLifecycleProjectionDigest,
  computeFindingLifecycleResultDigest,
} from '../core/models/finding-lifecycle-identity.js';
import {
  appendFreshConflictAdjudicationSnapshot,
  isConflictResolved,
} from '../core/workflow/findings/conflict-adjudication-model.js';
import { landUnownedConflictRawClaims } from '../core/workflow/findings/conflict-claim-landing.js';
import { hasUnsettledActiveConflictOwnership } from '../core/workflow/findings/conflict-ownership.js';
import { normalizeInheritedProvisionalTargetConflicts } from '../core/workflow/findings/provisional-conflict-normalization.js';
import { normalizeFindingLedger } from '../core/workflow/findings/ledger-mutation.js';
import { isTerminalAdjudicationCandidate } from '../core/workflow/findings/terminal-adjudication-candidates.js';
import type { ParsedLegacyFindingLedger } from '../infra/finding-storage/inherited-source-parser.js';
import { FindingDatabase } from '../infra/finding-storage/database.js';
import { FindingAuthorityRepository } from '../infra/finding-storage/repository.js';
import { FindingStorageResolver } from '../infra/finding-storage/resolver.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
} from './helpers/finding-lifecycle-fixture.js';

const OBSERVATION = {
  runId: 'destination-run',
  stepName: 'finding-requeue-normalization',
  timestamp: '2026-08-03T00:00:00.000Z',
};

function raw(
  index: number,
  role: 'target' | 'holding',
  identity: { index: number; role: 'target' | 'holding' } = { index, role },
) {
  return canonicalRawFindingFixture({
    rawFindingId: `raw-${role}-${index}`,
    stepName: 'reviewer',
    reviewer: `reviewer-${role}-${index}`,
    familyTag: 'bug',
    severity: 'high',
    title: `${identity.role} claim ${identity.index}`,
    description: `${identity.role} claim ${identity.index} has a deliberately distinct identity.`,
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: [`src/${identity.role}-${identity.index}.ts`] },
    evidence: [{
      kind: 'file_quote',
      path: `src/${identity.role}-${identity.index}.ts`,
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: `export const ${identity.role}${identity.index} = true;`,
      snapshotId: String(identity.index + (identity.role === 'target' ? 0 : 3)).repeat(64),
    }],
  });
}

function evidenceRecord(source: ReturnType<typeof raw>, index: number) {
  const evidence = source.evidence[0]!;
  if (evidence.kind !== 'file_quote') {
    throw new Error('Expected file quote evidence');
  }
  const payload = {
    ...evidence,
    claimIdentityHash: source.claimIdentityHash,
    fileHash: String(index).repeat(64),
  };
  return { evidenceId: computeFileQuoteEvidenceRecordId(payload), ...payload };
}

function legacyConflictLedger(input?: {
  holdingRaws?: ReturnType<typeof raw>[];
}): ParsedLegacyFindingLedger {
  const targetRaws = [1, 2, 3].map((index) => raw(index, 'target'));
  const holdingRaws = input?.holdingRaws ?? [1, 2, 3].map((index) => raw(index, 'holding'));
  const findings = targetRaws.map((source, offset) => ({
    id: `F-${String(offset + 1).padStart(4, '0')}`,
    status: 'open' as const,
    lifecycle: 'new' as const,
    revision: 1,
    severity: source.severity,
    title: source.title,
    description: source.description ?? undefined,
    target: source.target,
    targetIdentityHash: source.targetIdentityHash,
    claimIdentityHash: source.claimIdentityHash,
    semanticClaimIdentityHash: source.semanticClaimIdentityHash,
    evidenceIds: [],
    reviewers: [source.reviewer],
    rawFindingIds: [source.rawFindingId],
    firstSeen: OBSERVATION,
    lastSeen: OBSERVATION,
    provisional: {
      kind: 'raw-adjudication-unresolved' as const,
      stableKey: String(offset + 1).repeat(64),
      lineageKey: String(offset + 4).repeat(64),
      sourceRawFindingIds: [source.rawFindingId],
      reason: 'Legacy conflict target.',
      firstObservedAt: OBSERVATION,
      lastObservedAt: OBSERVATION,
      gateEffect: 'block' as const,
      firstObservedRound: 1,
    },
  }));
  const conflicts = findings.map((finding, offset) => {
    const shape = {
      findingIds: [finding.id],
      rawFindingIds: [holdingRaws[offset]!.rawFindingId],
    };
    return {
      id: formatConflictId(shape),
      ...shape,
      status: 'active' as const,
      revision: 1,
      description: `Legacy provisional conflict ${offset + 1}.`,
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
    };
  });
  let ledger = authorizeFindingLedgerFixture({
    workflowName: 'review',
    nextId: 4,
    updatedAt: OBSERVATION.timestamp,
    findings,
    evidenceRecords: [...targetRaws, ...holdingRaws].map((source, index) => (
      evidenceRecord(source, index + 1)
    )),
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawFindings: [...targetRaws, ...holdingRaws],
    conflicts,
  });
  ledger = landUnownedConflictRawClaims({ ledger, observation: OBSERVATION });
  for (const conflict of conflicts) {
    ledger = appendFreshConflictAdjudicationSnapshot({
      ledger,
      conflictId: conflict.id,
      originStep: OBSERVATION.stepName,
      createdAt: OBSERVATION,
    }).ledger;
  }
  const {
    provisionalConflictNormalizationSnapshots: _snapshots,
    provisionalConflictNormalizations: _records,
    ...legacy
  } = ledger;
  return legacy;
}

function legacyThreeConflictLedger(): ParsedLegacyFindingLedger {
  return legacyConflictLedger();
}

function readdressNormalizationLifecycle(
  ledger: FindingLedger,
  previousNormalizationId: string,
): FindingLedger {
  const record = ledger.provisionalConflictNormalizations[0]!;
  const reservationIndex = ledger.lifecycleReservations.findIndex(
    (reservation) => reservation.operation === 'normalize_provisional_conflicts',
  );
  const previousReservation = ledger.lifecycleReservations[reservationIndex]!;
  const reservation = createFindingLifecycleReservation({
    operation: previousReservation.operation,
    targets: previousReservation.targets,
    evidenceBindingIds: previousReservation.evidenceBindingIds,
    authority: {
      kind: 'provisional_conflict_normalization',
      normalizationId: record.normalizationId,
      normalizationSnapshotId: record.normalizationSnapshotId,
      decisionDigest: record.decisionDigest,
    },
    context: previousReservation.context,
    reservedAt: previousReservation.reservedAt,
  });
  ledger.lifecycleReservations[reservationIndex] = reservation;
  const eventIndex = ledger.lifecycleEvents.findIndex(
    (event) => event.operation === 'normalize_provisional_conflicts',
  );
  const previousEvent = ledger.lifecycleEvents[eventIndex]!;
  const transitionedFindings = previousEvent.transitions.flatMap((transition) => (
    transition.after.entityKind === 'finding'
      ? [ledger.findings.find((finding) => finding.id === transition.after.entityId)!]
      : []
  ));
  const transitionedConflicts = previousEvent.transitions.flatMap((transition) => (
    transition.after.entityKind === 'conflict'
      ? [ledger.conflicts.find((conflict) => conflict.id === transition.after.entityId)!]
      : []
  ));
  const event = createFindingLifecycleEvent({
    mutationId: reservation.mutationId,
    reservationId: reservation.reservationId,
    operation: previousEvent.operation,
    transitions: previousEvent.transitions.map((transition) => {
      const entity = transition.after.entityKind === 'finding'
        ? ledger.findings.find((finding) => finding.id === transition.after.entityId)!
        : ledger.conflicts.find((conflict) => conflict.id === transition.after.entityId)!;
      return {
        before: transition.before,
        after: {
          entityKind: transition.after.entityKind,
          entityId: transition.after.entityId,
          revision: entity.revision,
          projectionDigest: computeFindingLifecycleProjectionDigest(entity),
        },
      };
    }),
    evidenceBindingIds: previousEvent.evidenceBindingIds,
    outcome: previousEvent.outcome,
    resultDigest: computeFindingLifecycleResultDigest({
      findings: transitionedFindings,
      conflicts: transitionedConflicts,
    }),
    occurredAt: previousEvent.occurredAt,
  });
  ledger.lifecycleEvents[eventIndex] = event;
  ledger.conflictClaimSettlements = ledger.conflictClaimSettlements.map((settlement) => {
    if ('attemptId' in settlement || settlement.normalizationId !== previousNormalizationId) {
      return settlement;
    }
    return {
      ...settlement,
      normalizationId: record.normalizationId,
      settlementId: computeProvisionalConflictNormalizationSettlementId({
        normalizationId: record.normalizationId,
        conflictId: settlement.conflictId,
        subjectId: settlement.subjectId,
      }),
      lifecycleEventIds: [event.eventId],
    };
  });
  return ledger;
}

function omitBundledHoldingClaimFromProjection(source: FindingLedger): FindingLedger {
  const ledger = structuredClone(source);
  const record = ledger.provisionalConflictNormalizations[0]!;
  const bundled = record.decisions.find(
    (decision) => decision.outcome === 'bundled_into_provisional',
  );
  if (bundled?.outcome !== 'bundled_into_provisional') {
    throw new Error('Expected a bundled holding normalization decision');
  }
  const holding = ledger.findings.find((finding) => finding.id === bundled.findingId)!;
  const targetIndex = ledger.findings.findIndex(
    (finding) => finding.id === bundled.targetFindingId,
  );
  const target = ledger.findings[targetIndex]!;
  if (target.provisional === undefined) {
    throw new Error('Expected an open provisional bundle target');
  }
  const corruptedTarget = {
    ...target,
    rawFindingIds: target.rawFindingIds.filter((id) => !holding.rawFindingIds.includes(id)),
    reviewers: target.reviewers.filter((id) => !holding.reviewers.includes(id)),
    evidenceIds: target.evidenceIds.filter((id) => !holding.evidenceIds.includes(id)),
    provisional: {
      ...target.provisional,
      sourceRawFindingIds: target.provisional.sourceRawFindingIds.filter(
        (id) => !holding.rawFindingIds.includes(id),
      ),
    },
  };
  ledger.findings[targetIndex] = corruptedTarget;
  record.finalFindingProjections = record.finalFindingProjections.map((projection) => (
    projection.findingId === corruptedTarget.id
      ? {
          ...projection,
          after: corruptedTarget,
          projectionDigest: computeFindingLifecycleProjectionDigest(corruptedTarget),
        }
      : projection
  ));
  return readdressNormalizationLifecycle(ledger, record.normalizationId);
}

function omitBundledHoldingClaimWithRecomputedAddresses(source: FindingLedger): FindingLedger {
  const ledger = structuredClone(source);
  const record = ledger.provisionalConflictNormalizations[0]!;
  const snapshot = ledger.provisionalConflictNormalizationSnapshots[0]!;
  const bundled = record.decisions.find(
    (decision) => decision.outcome === 'bundled_into_provisional',
  );
  if (bundled?.outcome !== 'bundled_into_provisional') {
    throw new Error('Expected a bundled holding normalization decision');
  }
  const holding = ledger.findings.find((finding) => finding.id === bundled.findingId)!;
  const targetIndex = ledger.findings.findIndex(
    (finding) => finding.id === bundled.targetFindingId,
  );
  const target = ledger.findings[targetIndex]!;
  if (target.provisional === undefined) {
    throw new Error('Expected an open provisional bundle target');
  }
  const corruptedTarget = {
    ...target,
    rawFindingIds: target.rawFindingIds.filter((id) => !holding.rawFindingIds.includes(id)),
    reviewers: target.reviewers.filter((id) => !holding.reviewers.includes(id)),
    evidenceIds: target.evidenceIds.filter((id) => !holding.evidenceIds.includes(id)),
    provisional: {
      ...target.provisional,
      sourceRawFindingIds: target.provisional.sourceRawFindingIds.filter(
        (id) => !holding.rawFindingIds.includes(id),
      ),
    },
  };
  ledger.findings[targetIndex] = corruptedTarget;
  const intentByFindingId = new Map(record.finalFindingProjections.map((projection) => {
    const after = projection.findingId === corruptedTarget.id
      ? corruptedTarget
      : projection.after;
    const ownSubject = snapshot.subjects.find(
      (subject) => subject.findingId === projection.findingId,
    )!;
    if (after.status === 'superseded') {
      const withoutDigest = {
        kind: 'superseded' as const,
        findingId: after.id,
        expectedHead: projection.expectedHead,
        sourceSubjectIds: [ownSubject.subjectId],
        afterRevision: after.revision,
        afterLifecycle: 'superseded' as const,
        supersededByFindingId: after.supersededByFindingId!,
        provisionalAfter: null,
      };
      return [after.id, {
        ...withoutDigest,
        intentDigest: computeProvisionalConflictFinalIntentDigest(withoutDigest),
      }] as const;
    }
    if (after.provisional === undefined) {
      throw new Error('Expected provisional normalization projection');
    }
    const absorbed = record.decisions.filter((decision) => (
      decision.outcome === 'bundled_into_provisional'
      && decision.targetFindingId === after.id
    ));
    const withoutDigest = {
      kind: 'open_provisional' as const,
      findingId: after.id,
      expectedHead: projection.expectedHead,
      sourceSubjectIds: binarySortedUnique([
        ownSubject.subjectId,
        ...absorbed.map((decision) => decision.subjectId),
      ]),
      afterRevision: after.revision,
      afterLifecycle: 'persists' as const,
      stableKey: after.provisional.stableKey,
      lineageKey: after.provisional.lineageKey,
      rawFindingIds: binarySortedUnique(after.rawFindingIds),
      provisionalSourceRawFindingIds: binarySortedUnique(after.provisional.sourceRawFindingIds),
      reviewerIds: binarySortedUnique(after.reviewers),
      evidenceIds: binarySortedUnique(after.evidenceIds),
      absorbedFindingIds: binarySortedUnique(absorbed.map((decision) => decision.findingId)),
    };
    return [after.id, {
      ...withoutDigest,
      intentDigest: computeProvisionalConflictFinalIntentDigest(withoutDigest),
    }] as const;
  }));
  record.finalFindingProjections = record.finalFindingProjections.map((projection) => {
    const after = projection.findingId === corruptedTarget.id
      ? corruptedTarget
      : projection.after;
    return {
      ...projection,
      after,
      intentDigest: intentByFindingId.get(projection.findingId)!.intentDigest,
      projectionDigest: computeFindingLifecycleProjectionDigest(after),
    };
  });
  record.decisions = record.decisions.map((decision) => {
    const sourceIntent = intentByFindingId.get(decision.findingId)!;
    if (decision.outcome === 'retained_provisional') {
      return { ...decision, finalIntentDigest: sourceIntent.intentDigest };
    }
    if (decision.outcome === 'released_independent') {
      return { ...decision, finalIntentDigest: sourceIntent.intentDigest };
    }
    return {
      ...decision,
      sourceFinalIntentDigest: sourceIntent.intentDigest,
      targetFinalIntentDigest: intentByFindingId.get(decision.targetFindingId)!.intentDigest,
    };
  });
  record.decisionDigest = computeProvisionalConflictDecisionDigest({
    normalizationSnapshotId: record.normalizationSnapshotId,
    decisions: record.decisions,
    releaseWitnessIds: record.releaseWitnesses.map(({ releaseWitnessId }) => releaseWitnessId),
  });
  const previousNormalizationId = record.normalizationId;
  record.normalizationId = computeProvisionalConflictNormalizationId({
    normalizationSnapshotId: record.normalizationSnapshotId,
    decisionDigest: record.decisionDigest,
  });
  const finalFindingIntents = [...intentByFindingId.values()];
  record.batchFingerprintDigest = computeLegacyProvisionalConflictBatchFingerprintDigest({
    conflictIds: snapshot.conflicts.map(({ conflictId }) => conflictId),
    provisionalTargetFindingIds: snapshot.subjects.flatMap((subject) => (
      subject.role === 'provisional_target' ? [subject.findingId] : []
    )),
    holdingFindingIds: snapshot.subjects.flatMap((subject) => (
      subject.role === 'holding_provisional' ? [subject.findingId] : []
    )),
    holdingOwners: snapshot.subjects.flatMap((subject) => (
      subject.role === 'holding_provisional'
        ? [{
            holdingFindingId: subject.findingId,
            conflictId: subject.conflictId,
            rawClaimLandingIds: binarySortedUnique(subject.rawClaimLandingIds),
          }]
        : []
    )),
    verifiedIdentities: snapshot.subjects.map((subject) => ({
      findingId: subject.findingId,
      role: subject.role,
      targetIdentityHash: subject.targetIdentityHash!,
      claimIdentityHash: subject.claimIdentityHash!,
      semanticClaimIdentityHash: subject.semanticClaimIdentityHash!,
      claimSnapshotDigest: subject.claimSnapshotDigest,
      rawFindingIds: binarySortedUnique(subject.sourceRawFindingIds),
      rawCanonicalSnapshotIds: binarySortedUnique(subject.sourceRawFindingIds.map((rawFindingId) => (
        ledger.rawCanonicalSnapshots.find(
          (canonical) => canonical.rawFindingId === rawFindingId,
        )!.rawCanonicalSnapshotId
      ))),
    })),
    finalFindingIntents,
  });
  ledger.conflicts = ledger.conflicts.map((conflict) => (
    conflict.resolvedEvidence === `Provisional conflict normalization ${previousNormalizationId}`
      ? {
          ...conflict,
          resolvedEvidence: `Provisional conflict normalization ${record.normalizationId}`,
        }
      : conflict
  ));
  return readdressNormalizationLifecycle(ledger, previousNormalizationId);
}

function normalizedLedgerWithBundledHolding(): FindingLedger {
  const sharedIdentity = { index: 2, role: 'target' as const };
  const legacyLedger = legacyConflictLedger({
    holdingRaws: [
      raw(1, 'holding', sharedIdentity),
      raw(2, 'holding', sharedIdentity),
      raw(3, 'holding'),
    ],
  });
  return normalizeInheritedProvisionalTargetConflicts({
    source: {
      authorityKey: 'root',
      workflowName: 'review',
      revision: 7,
      ledgerJson: JSON.stringify(legacyLedger),
    },
    legacyLedger,
    destinationRunId: OBSERVATION.runId,
    recordedAt: OBSERVATION,
  }).ledger;
}

function expectDatabaseLoadAndRequeueToReject(input: {
  normalized: FindingLedger;
  corrupted: FindingLedger;
  directoryPrefix: string;
}): void {
  const root = mkdtempSync(join(tmpdir(), input.directoryPrefix));
  const sourcePath = join(root, 'source.sqlite');
  const targetPath = join(root, 'target.sqlite');
  const sourceDatabase = FindingDatabase.openTarget({
    databasePath: sourcePath,
    runId: OBSERVATION.runId,
  });
  try {
    const repository = new FindingAuthorityRepository(
      sourceDatabase,
      () => OBSERVATION.timestamp,
    );
    repository.ensureAuthority({
      authorityKey: 'root',
      workflowName: 'review',
      seed: () => ({ ledger: input.normalized }),
    });
    sourceDatabase.connection.prepare(`
      UPDATE finding_authorities SET ledger_json = ? WHERE authority_key = ?
    `).run(JSON.stringify(input.corrupted), 'root');
    expect(() => repository.load('root', 'review')).toThrow(/Normalization record/);
  } finally {
    sourceDatabase.close();
  }
  const resolver = new FindingStorageResolver({
    databasePath: targetPath,
    runId: 'requeue-run',
    source: {
      databasePath: sourcePath,
      runId: OBSERVATION.runId,
    },
    now: () => OBSERVATION.timestamp,
  });
  try {
    expect(() => resolver.resolveAuthority({
      authorityKey: 'root',
      workflowName: 'review',
      reportDir: join(root, 'reports'),
    })).toThrow(/Normalization record/);
  } finally {
    resolver.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe('provisional conflict normalization', () => {
  it('normalizes a three-conflict legacy batch into retained targets and released independent holdings', () => {
    const legacyLedger = legacyThreeConflictLedger();
    const result = normalizeInheritedProvisionalTargetConflicts({
      source: {
        authorityKey: 'root',
        workflowName: 'review',
        revision: 7,
        ledgerJson: JSON.stringify(legacyLedger),
      },
      legacyLedger,
      destinationRunId: OBSERVATION.runId,
      recordedAt: OBSERVATION,
    });

    expect(result.record.decisions.filter(
      ({ outcome }) => outcome === 'retained_provisional',
    )).toHaveLength(3);
    expect(result.record.decisions.filter(
      ({ outcome }) => outcome === 'released_independent',
    )).toHaveLength(3);
    expect(result.ledger.conflicts.every(({ status }) => status === 'resolved')).toBe(true);
    expect(result.ledger.conflicts.every((conflict) => (
      isConflictResolved(result.ledger, conflict.id)
    ))).toBe(true);
    const releasedFindingIds = result.record.decisions.flatMap((decision) => (
      decision.outcome === 'released_independent' ? [decision.findingId] : []
    ));
    expect(releasedFindingIds.every((findingId) => (
      !hasUnsettledActiveConflictOwnership(result.ledger, findingId)
    ))).toBe(true);
    expect(releasedFindingIds.every((findingId) => isTerminalAdjudicationCandidate({
      ledger: result.ledger,
      finding: result.ledger.findings.find((finding) => finding.id === findingId)!,
      currentRound: 2,
    }))).toBe(true);
    expect(result.ledger.lifecycleEvents.at(-1)?.operation).toBe(
      'normalize_provisional_conflicts',
    );
    expect(normalizeFindingLedger(
      JSON.parse(JSON.stringify(result.ledger)),
      'review',
    )).toEqual(result.ledger);
  });

  it('folds a holding association chain into the final canonical target without losing claims', () => {
    const sharedIdentity = { index: 2, role: 'target' as const };
    const legacyLedger = legacyConflictLedger({
      holdingRaws: [
        raw(1, 'holding', sharedIdentity),
        raw(2, 'holding', sharedIdentity),
        raw(3, 'holding'),
      ],
    });
    const result = normalizeInheritedProvisionalTargetConflicts({
      source: {
        authorityKey: 'root',
        workflowName: 'review',
        revision: 7,
        ledgerJson: JSON.stringify(legacyLedger),
      },
      legacyLedger,
      destinationRunId: OBSERVATION.runId,
      recordedAt: OBSERVATION,
    });
    const targetFindingId = legacyLedger.findings.find(
      (finding) => finding.title === 'target claim 2',
    )!.id;
    const chainedDecisions = result.record.decisions.filter((decision) => (
      decision.outcome === 'bundled_into_provisional'
      && decision.targetFindingId === targetFindingId
    ));
    expect(chainedDecisions).toHaveLength(2);
    const target = result.ledger.findings.find((finding) => finding.id === targetFindingId)!;
    expect(target.rawFindingIds).toEqual(expect.arrayContaining([
      'raw-target-2',
      'raw-holding-1',
      'raw-holding-2',
    ]));
    expect(target.provisional?.sourceRawFindingIds).toEqual(expect.arrayContaining([
      'raw-target-2',
      'raw-holding-1',
      'raw-holding-2',
    ]));
    for (const decision of chainedDecisions) {
      const source = result.ledger.findings.find((finding) => finding.id === decision.findingId)!;
      expect(source).toMatchObject({
        status: 'superseded',
        supersededByFindingId: targetFindingId,
      });
    }
  });

  it('rejects a mixed product/provisional legacy conflict fingerprint', () => {
    const legacy = legacyThreeConflictLedger();
    const targetId = legacy.conflicts[0]!.findingIds[0]!;
    const findings = legacy.findings.map((finding) => {
      if (finding.id !== targetId) return finding;
      const { provisional: _provisional, ...product } = finding;
      return product;
    });
    expect(() => normalizeInheritedProvisionalTargetConflicts({
      source: {
        authorityKey: 'root',
        workflowName: 'review',
        revision: 7,
        ledgerJson: '{}',
      },
      legacyLedger: { ...legacy, findings } as ParsedLegacyFindingLedger,
      destinationRunId: OBSERVATION.runId,
      recordedAt: OBSERVATION,
    })).toThrow(/not an open provisional/);
  });

  it('rejects normalization persistence when fingerprint, intent, settlement, or event bindings drift', () => {
    const legacyLedger = legacyThreeConflictLedger();
    const normalized = normalizeInheritedProvisionalTargetConflicts({
      source: {
        authorityKey: 'root',
        workflowName: 'review',
        revision: 7,
        ledgerJson: JSON.stringify(legacyLedger),
      },
      legacyLedger,
      destinationRunId: OBSERVATION.runId,
      recordedAt: OBSERVATION,
    }).ledger;
    const mutations: Array<(ledger: FindingLedger) => void> = [
      (ledger) => {
        ledger.provisionalConflictNormalizations[0]!.batchFingerprintDigest = '0'.repeat(64);
      },
      (ledger) => {
        ledger.provisionalConflictNormalizations[0]!.finalFindingProjections[0]!.intentDigest =
          '1'.repeat(64);
      },
      (ledger) => {
        const settlement = ledger.conflictClaimSettlements.find(
          (candidate) => !('attemptId' in candidate),
        )!;
        settlement.findingId = 'F-9999';
      },
      (ledger) => {
        const event = ledger.lifecycleEvents.find(
          (candidate) => candidate.operation === 'normalize_provisional_conflicts',
        )!;
        event.transitions[0]!.after.projectionDigest = '2'.repeat(64);
      },
    ];
    for (const mutate of mutations) {
      const corrupted = structuredClone(normalized);
      mutate(corrupted);
      expect(() => normalizeFindingLedger(corrupted, 'review')).toThrow();
    }
  });

  it('persists and reloads the normalized projection through SQLite invariants', () => {
    const legacyLedger = legacyThreeConflictLedger();
    const normalized = normalizeInheritedProvisionalTargetConflicts({
      source: {
        authorityKey: 'root',
        workflowName: 'review',
        revision: 7,
        ledgerJson: JSON.stringify(legacyLedger),
      },
      legacyLedger,
      destinationRunId: OBSERVATION.runId,
      recordedAt: OBSERVATION,
    }).ledger;
    const root = mkdtempSync(join(tmpdir(), 'takt-provisional-normalization-'));
    const database = FindingDatabase.openTarget({
      databasePath: join(root, 'finding-contract.sqlite'),
      runId: OBSERVATION.runId,
    });
    try {
      const repository = new FindingAuthorityRepository(
        database,
        () => OBSERVATION.timestamp,
      );
      repository.ensureAuthority({
        authorityKey: 'root',
        workflowName: 'review',
        seed: () => ({ ledger: normalized }),
      });
      expect(repository.load('root', 'review').ledger).toEqual(normalized);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a current DB that consistently readdresses a bundled target after dropping holding claims', () => {
    const normalized = normalizedLedgerWithBundledHolding();
    const corrupted = omitBundledHoldingClaimWithRecomputedAddresses(normalized);
    expectDatabaseLoadAndRequeueToReject({
      normalized,
      corrupted,
      directoryPrefix: 'takt-provisional-corrupt-source-',
    });
  });

  it('rejects load and requeue when only the bundled target projection drops holding claims', () => {
    const normalized = normalizedLedgerWithBundledHolding();
    const corrupted = omitBundledHoldingClaimFromProjection(normalized);
    const originalRecord = normalized.provisionalConflictNormalizations[0]!;
    const corruptedRecord = corrupted.provisionalConflictNormalizations[0]!;
    expect(corruptedRecord.finalFindingProjections.map(({ intentDigest }) => intentDigest)).toEqual(
      originalRecord.finalFindingProjections.map(({ intentDigest }) => intentDigest),
    );
    expect(corruptedRecord.decisionDigest).toBe(originalRecord.decisionDigest);
    expect(corruptedRecord.batchFingerprintDigest).toBe(originalRecord.batchFingerprintDigest);
    expectDatabaseLoadAndRequeueToReject({
      normalized,
      corrupted,
      directoryPrefix: 'takt-provisional-corrupt-projection-',
    });
  });
});
