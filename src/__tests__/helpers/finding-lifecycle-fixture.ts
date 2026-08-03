import { createHash } from 'node:crypto';
import {
  computeCandidateIdentityHash,
  computeClaimIdentityHash,
  computeSemanticClaimIdentityHash,
  computeTargetIdentityHash,
} from '../../core/models/finding-claim-identity.js';
import {
  computeRawCanonicalSnapshotId,
  computeRawPayloadDigest,
  findingContentAddress,
} from '../../core/models/finding-contract-identity.js';
import {
  computeFileQuoteEvidenceRecordId,
  createEngineProofRecord,
} from '../../core/models/finding-evidence-record.js';
import { computeRawFindingIntegrityDigest } from '../../core/models/finding-raw-integrity.js';
import {
  createFindingEvidenceBinding,
  createFindingLifecycleReservation,
} from '../../core/models/finding-lifecycle-identity.js';
import type {
  CandidateSourceBinding,
  FindingEvidenceRequest,
  FindingTarget,
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
  FindingEvidenceContributionOrigin,
  FindingLifecycleAuthority,
  FindingLifecycleOperation,
  FindingObservation,
  RawFinding,
  RawFindingEvidence,
} from '../../core/workflow/findings/types.js';
import {
  applyVerifiedLifecycleMutation,
  captureFindingLifecycleHead,
  reserveVerifiedLifecycleMutation,
} from '../../core/workflow/findings/lifecycle-mutation.js';
import { captureFindingMutationPrecondition } from '../../core/workflow/findings/finding-preconditions.js';
import { createEmptyFindingContractRegistries } from '../../core/models/finding-contract-seed.js';
import type { FindingContractLedgerRegistries } from '../../core/models/finding-contract-types.js';
import type { RawCanonicalSnapshot } from '../../core/models/finding-contract-types.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cloneFixture<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function rawCanonicalSnapshotFixture(
  rawFinding: RawFinding,
  capturedAt: FindingObservation,
): RawCanonicalSnapshot {
  const snapshotWithoutId = {
    rawFindingId: rawFinding.rawFindingId,
    rawPayloadDigest: computeRawPayloadDigest(rawFinding),
    reviewerStableKey: findingContentAddress('fixture-reviewer-stable-key', {
      rawFindingId: rawFinding.rawFindingId,
    }),
    lineageKey: findingContentAddress('fixture-lineage-key', {
      rawFindingId: rawFinding.rawFindingId,
    }),
    targetIdentityHash: rawFinding.targetIdentityHash,
    claimIdentityHash: rawFinding.claimIdentityHash,
    semanticClaimIdentityHash: rawFinding.semanticClaimIdentityHash,
    canonicalProvenance: {
      origin: 'system' as const,
      ambiguityOrigin: false,
      clarificationAttempted: false,
      ambiguityCodes: [],
    },
    canonicalizationContextDigest: findingContentAddress('fixture-canonicalization-context', {
      reviewer: rawFinding.reviewer,
      stepName: rawFinding.stepName,
      sourceBinding: rawFinding.sourceBinding,
    }),
    captureAdmissionSnapshotId: findingContentAddress('fixture-capture-admission', {
      rawFindingId: rawFinding.rawFindingId,
      evidence: rawFinding.evidence,
    }),
    captureDependencyDigests: [],
    canonicalIntegrityDigest: computeRawFindingIntegrityDigest(rawFinding),
  };
  return {
    rawCanonicalSnapshotId: computeRawCanonicalSnapshotId(snapshotWithoutId),
    ...snapshotWithoutId,
    capturedAt: cloneFixture(capturedAt),
  };
}

export function canonicalRawFindingFixture(
  input: Omit<
    RawFinding,
    | 'target'
    | 'targetIdentityHash'
    | 'claimIdentityHash'
    | 'semanticClaimIdentityHash'
    | 'candidateIdentityHash'
    | 'sourceBinding'
  > & {
    target?: FindingTarget;
    sourceBinding?: CandidateSourceBinding;
  },
): RawFinding {
  const evidence = input.evidence ?? [];
  const familyTag = input.familyTag ?? null;
  const severity = input.severity ?? null;
  const title = input.title ?? null;
  const description = input.description ?? null;
  const suggestion = input.suggestion ?? null;
  const quotePath = evidence.find(
    (evidence) => evidence.kind === 'file_quote',
  )?.path;
  const target = input.target ?? {
    kind: 'code',
    paths: [quotePath ?? `fixtures/${input.rawFindingId}.ts`],
  };
  const sourceText = description ?? title ?? input.rawFindingId;
  const sourceBinding = input.sourceBinding ?? {
    reportDigest: sha256(`fixture-report:${input.rawFindingId}:${sourceText}`),
    startByte: 0,
    endByte: Buffer.byteLength(sourceText),
    excerptDigest: sha256(sourceText),
  };
  const claimIdentityHash = computeClaimIdentityHash({
    target,
    familyTag,
    severity,
    title,
    description,
    suggestion,
  });
  const semanticClaimIdentityHash = computeSemanticClaimIdentityHash({
    target,
    title,
    description,
  });
  return {
    ...input,
    familyTag,
    severity,
    title,
    description,
    suggestion,
    evidence,
    target,
    targetIdentityHash: computeTargetIdentityHash(target),
    claimIdentityHash,
    semanticClaimIdentityHash,
    candidateIdentityHash: computeCandidateIdentityHash({
      claimIdentityHash,
      sourceBinding,
    }),
    sourceBinding,
  };
}

export function reviewerRawExtractionFixture(input: {
  rawFindingId: string | null;
  familyTag: string | null;
  severity: RawFinding['severity'];
  title: string | null;
  description: string | null;
  suggestion: string | null;
  relation: RawFinding['relation'] | null;
  targetFindingId: string | null;
  target?: FindingTarget;
  evidence?: RawFindingEvidence[];
  evidenceRequests?: FindingEvidenceRequest[];
  rawExcerpt?: string;
}) {
  const quoteRequests = (input.evidence ?? []).flatMap((evidence) => {
    if (evidence.kind !== 'file_quote') {
      return [];
    }
    const {
      snapshotId: _snapshotId,
      verbatimExcerpt: _verbatimExcerpt,
      ...request
    } = evidence;
    return [request];
  });
  const target = input.target ?? {
    kind: 'code' as const,
    paths: [...new Set(quoteRequests.map((request) => request.path))].sort(),
  };
  if (target.kind === 'code' && target.paths.length === 0) {
    target.paths.push(`fixtures/${input.rawFindingId ?? 'anonymous'}.ts`);
  }
  return {
    rawExcerpt: input.rawExcerpt
      ?? input.description
      ?? input.title
      ?? input.rawFindingId
      ?? 'Unstructured reviewer observation',
    candidate: {
      rawFindingId: input.rawFindingId,
      familyTag: input.familyTag,
      severity: input.severity,
      title: input.title,
      description: input.description,
      suggestion: input.suggestion === '' ? null : input.suggestion,
      relation: input.relation,
      targetFindingIds: input.targetFindingId === null ? [] : [input.targetFindingId],
      target,
      evidenceRequests: input.evidenceRequests ?? quoteRequests,
    },
  };
}

function fixtureObservation(
  entity: FindingLedgerEntry | FindingLedgerConflict,
): FindingObservation {
  return cloneFixture(entity.lastSeen);
}

export function applyFindingLedgerFixtureRevision(input: {
  ledger: FindingLedger;
  entityKind: 'finding' | 'conflict';
  entity: FindingLedgerEntry | FindingLedgerConflict;
  contributionOrigin?: FindingEvidenceContributionOrigin;
}): FindingLedger {
  const observation = fixtureObservation(input.entity);
  const finding = input.entityKind === 'finding'
    ? input.entity as FindingLedgerEntry
    : null;
  const findingDescription = finding?.description ?? finding?.title ?? '';
  const expectedHead = captureFindingLifecycleHead(
    input.ledger,
    input.entityKind,
    input.entity.id,
  ) ?? null;
  const operation: FindingLifecycleOperation = (() => {
    if (input.entityKind === 'conflict') {
      if (expectedHead === null) {
        return 'create_conflict';
      }
      return (input.entity as FindingLedgerConflict).status === 'resolved'
        ? 'resolve_conflict'
        : 'observe_conflict';
    }
    const desired = input.entity as FindingLedgerEntry;
    const current = input.ledger.findings.find((candidate) => candidate.id === desired.id);
    if (expectedHead === null) {
      return desired.provisional === undefined ? 'create_finding' : 'update_provisional';
    }
    if (current?.provisional !== undefined && desired.provisional === undefined) {
      return 'promote_provisional';
    }
    if (desired.provisional !== undefined) {
      return 'update_provisional';
    }
    if (desired.status !== current?.status || desired.lifecycle !== current.lifecycle) {
      if (desired.status === 'resolved') return 'resolve_finding';
      if (desired.status === 'waived') return 'waive_finding';
      if (desired.status === 'invalidated') return 'invalidate_finding';
      if (desired.status === 'dismissed') return 'dismiss_finding';
      if (desired.lifecycle === 'reopened') return 'reopen_finding';
    }
    return 'persist_finding';
  })();
  const authority: FindingLifecycleAuthority = (() => {
    switch (operation) {
      case 'waive_finding':
        return {
          kind: 'engine_policy',
          decisionKind: 'waive',
          decisionDigest: sha256(`fixture-policy:waive:${input.entity.id}:${input.entity.revision}`),
        };
      case 'dismiss_finding':
        throw new Error('Fixture dismissal requires a verified terminal adjudication transaction');
      case 'resolve_conflict':
        return {
          kind: 'verified_conflict_adjudication',
          conflictId: input.entity.id,
          conflictSnapshotId: sha256(
            `fixture-conflict-snapshot:${input.entity.id}:${input.entity.revision}`,
          ),
          attemptId: sha256(
            `fixture-conflict-attempt:${input.entity.id}:${input.entity.revision}`,
          ),
          verificationDigest: sha256(
            `fixture-conflict-verification:${input.entity.id}:${input.entity.revision}`,
          ),
          proofRecordIds: [...new Set(
            input.ledger.evidenceBindings
              .filter((binding) => (
                binding.target.entityKind === 'conflict'
                && binding.target.entityId === input.entity.id
              ))
              .map((binding) => binding.evidenceId),
          )].sort(),
        };
      default:
        return { kind: 'verified_evidence' };
    }
  })();
  const usesManagerProof = input.contributionOrigin === undefined
    && (
      operation === 'update_provisional'
      || operation === 'invalidate_finding'
    );
  const relation: RawFinding['relation'] = (() => {
    switch (operation) {
      case 'resolve_finding':
        return 'resolution_confirmation';
      case 'reopen_finding':
        return 'reopened';
      case 'persist_finding':
      case 'create_conflict':
      case 'observe_conflict':
        return 'persists';
      default:
        return 'new';
    }
  })();
  const rawTargetFindingId = input.entityKind === 'finding'
    ? (relation === 'new' ? null : input.entity.id)
    : (input.entity as FindingLedgerConflict).findingIds[0] ?? input.ledger.findings[0]?.id ?? 'F-0001';
  const retainedQuote = finding?.rawFindingIds
    .map((rawFindingId) => input.ledger.rawFindings.find(
      (candidate) => candidate.rawFindingId === rawFindingId,
    ))
    .flatMap((candidate) => candidate?.evidence ?? [])
    .find((evidence) => evidence.kind === 'file_quote');
  const retainedSourceRawIds = finding?.rawFindingIds
    ?? (input.contributionOrigin === undefined
      ? []
      : (input.entity as FindingLedgerConflict).rawFindingIds);
  const retainedSourceRaw = retainedSourceRawIds
    .map((rawFindingId) => input.ledger.rawFindings.find(
      (candidate) => candidate.rawFindingId === rawFindingId,
    ))
    .find((candidate) => candidate !== undefined);
  const retainedEvidenceQuote = finding?.evidenceIds
    .map((evidenceId) => input.ledger.evidenceRecords.find(
      (candidate) => candidate.evidenceId === evidenceId,
    ))
    .find((evidence) => evidence?.kind === 'file_quote');
  const quotePath = retainedEvidenceQuote?.path
    ?? retainedQuote?.path
    ?? `fixtures/${input.entity.id}-${input.entity.revision}.ts`;
  const quoteStartLine = retainedEvidenceQuote?.startLine
    ?? retainedQuote?.startLine
    ?? 1;
  const quoteEndLine = retainedEvidenceQuote?.endLine
    ?? retainedQuote?.endLine
    ?? quoteStartLine;
  const rawTarget = finding?.target
    ?? input.ledger.findings.find((candidate) => candidate.id === rawTargetFindingId)?.target
    ?? {
      kind: 'code' as const,
      paths: [quotePath],
    };
  const rawClaimIdentityHash = computeClaimIdentityHash({
    target: rawTarget,
    familyTag: retainedSourceRaw?.familyTag ?? 'fixture',
    severity: input.entityKind === 'finding'
      ? (input.entity as FindingLedgerEntry).severity
      : 'high',
    title: input.entityKind === 'finding'
      ? (input.entity as FindingLedgerEntry).title
      : `Conflict ${input.entity.id}`,
    description: input.entityKind === 'finding'
      ? findingDescription
      : input.entity.description ?? input.entity.id,
    suggestion: retainedSourceRaw?.suggestion ?? finding?.suggestion ?? null,
  });
  const reportExcerpt = input.entityKind === 'finding'
    ? findingDescription
    : input.entity.description ?? input.entity.id;
  const sourceBinding = {
    reportDigest: sha256(
      `fixture-report:${input.entityKind}:${input.entity.id}:${input.entity.revision}`,
    ),
    startByte: 0,
    endByte: Buffer.byteLength(reportExcerpt),
    excerptDigest: sha256(reportExcerpt),
  };
  const interpretedRetainedSource = retainedSourceRaw !== undefined
    && (
      input.contributionOrigin?.kind === 'interpretation_case'
      || input.ledger.interpretationRawObservations.some(
        (observation) => observation.rawFindingId === retainedSourceRaw.rawFindingId,
      )
    )
    ? retainedSourceRaw
    : undefined;
  const rawTargetPrecondition = rawTargetFindingId === null
    ? undefined
    : captureFindingMutationPrecondition(input.ledger, rawTargetFindingId);
  const raw: RawFinding | undefined = authority.kind === 'verified_evidence'
    && !usesManagerProof
    ? interpretedRetainedSource ?? {
        rawFindingId: `fixture-raw:${input.entityKind}:${input.entity.id}:${input.entity.revision}:${input.ledger.rawFindings.length}`,
        stepName: observation.stepName,
        reviewer: 'fixture-reviewer',
        familyTag: retainedSourceRaw?.familyTag ?? 'fixture',
        severity: input.entityKind === 'finding'
          ? (input.entity as FindingLedgerEntry).severity
          : 'high',
        title: input.entityKind === 'finding'
          ? (input.entity as FindingLedgerEntry).title
          : `Conflict ${input.entity.id}`,
        description: input.entityKind === 'finding'
          ? findingDescription
          : input.entity.description ?? input.entity.id,
        suggestion: retainedSourceRaw?.suggestion ?? finding?.suggestion ?? null,
        target: rawTarget,
        targetIdentityHash: computeTargetIdentityHash(rawTarget),
        claimIdentityHash: rawClaimIdentityHash,
        semanticClaimIdentityHash: computeSemanticClaimIdentityHash({
          target: rawTarget,
          title: input.entityKind === 'finding'
            ? (input.entity as FindingLedgerEntry).title
            : `Conflict ${input.entity.id}`,
          description: input.entityKind === 'finding'
            ? findingDescription
            : input.entity.description ?? input.entity.id,
        }),
        candidateIdentityHash: computeCandidateIdentityHash({
          claimIdentityHash: rawClaimIdentityHash,
          sourceBinding,
        }),
        sourceBinding,
        relation,
        targetFindingId: rawTargetFindingId,
        ...(rawTargetPrecondition === undefined
          ? {}
          : {
              targetPrecondition: rawTargetPrecondition,
            }),
        evidence: [{
          kind: 'file_quote',
          path: quotePath,
          startLine: quoteStartLine,
          endLine: quoteEndLine,
          verbatimExcerpt: input.entityKind === 'finding'
            ? findingDescription
            : input.entity.description ?? input.entity.id,
          snapshotId: sha256(
            `fixture-snapshot:${input.entityKind}:${input.entity.id}:${input.entity.revision}`,
          ),
        }],
      }
    : undefined;
  const claimIdentityHash = raw !== undefined
    ? raw.claimIdentityHash
    : input.entityKind === 'finding'
      ? finding!.provisional !== undefined && finding!.claimIdentityHash === null
        ? null
        : finding!.claimIdentityHash ?? rawClaimIdentityHash
      : sha256(`fixture-conflict:${input.entity.id}:${input.entity.revision}`);
  const invalidationEvidence = finding?.invalidatedEvidence
    ?? 'Fixture location is invalid.';
  const evidenceRecord = usesManagerProof
      ? createEngineProofRecord({
        kind: 'engine_proof',
        purpose: 'lifecycle_authority',
        verifierId: 'takt.finding-lifecycle-policy',
        verifierVersion: '1',
        workflowName: input.ledger.workflowName,
        runId: observation.runId,
        scopeIdentity: 'test-lifecycle-fixture',
        snapshotId: sha256(
          `fixture-snapshot:${input.entityKind}:${input.entity.id}:${input.entity.revision}`,
        ),
        claimIdentityHash,
        targetFindingId: expectedHead === null ? null : input.entity.id,
        subject: operation === 'invalidate_finding'
          ? {
              kind: 'finding_target_invalid',
              findingId: input.entity.id,
              reason: invalidationEvidence,
            }
          : {
              kind: 'finding_provisional_isolation',
              findingId: input.entity.id,
              provisionalKind: finding!.provisional!.kind,
              stableKey: finding!.provisional!.stableKey,
              claimBindingAuthorizationReferences: [],
            },
        dependencyDigests: expectedHead === null
          ? []
          : [expectedHead.projectionDigest],
        resultDigest: sha256(
          `fixture-result:${input.entityKind}:${input.entity.id}:${input.entity.revision}`,
        ),
        issuedAt: observation.timestamp,
      })
    : raw === undefined
      ? undefined
      : (() => {
          const quote = raw.evidence[0]!;
          if (quote.kind !== 'file_quote') {
            throw new Error('Expected fixture file quote');
          }
          const payload = {
            ...quote,
            claimIdentityHash: raw.claimIdentityHash,
            fileHash: sha256(`fixture-file:${input.entity.id}:${input.entity.revision}`),
          };
          return {
            evidenceId: computeFileQuoteEvidenceRecordId(payload),
            ...payload,
          };
        })();
  const target = {
    entityKind: input.entityKind,
    entityId: input.entity.id,
    expectedHead,
  };
  const interpretationObservation = raw === undefined
    ? undefined
    : input.ledger.interpretationRawObservations.find(
        (observation) => observation.rawFindingId === raw.rawFindingId,
      );
  const binding = evidenceRecord === undefined
    ? undefined
    : createFindingEvidenceBinding({
        evidenceId: evidenceRecord.evidenceId,
        claimIdentityHash,
        sourceRawFindingId: raw?.rawFindingId ?? null,
        sourceRawIntegrityDigest: raw === undefined
          ? null
          : computeRawFindingIntegrityDigest(raw),
        contributionOrigin: input.contributionOrigin ?? (interpretationObservation === undefined
          ? { kind: 'external' }
          : { kind: 'interpretation_case', caseId: interpretationObservation.caseId }),
        operation,
        target,
      });
  const reservation = createFindingLifecycleReservation({
    operation,
    targets: [target],
    evidenceBindingIds: binding === undefined ? [] : [binding.bindingId],
    authority,
    context: { kind: 'transaction' },
    reservedAt: observation,
  });
  const pending = reserveVerifiedLifecycleMutation({
    ...input.ledger,
    evidenceRecords: evidenceRecord === undefined
      ? input.ledger.evidenceRecords
      : input.ledger.evidenceRecords.some(
        (record) => record.evidenceId === evidenceRecord.evidenceId,
      )
        ? input.ledger.evidenceRecords
        : [...input.ledger.evidenceRecords, evidenceRecord],
    rawFindings: raw === undefined
      ? input.ledger.rawFindings
      : input.ledger.rawFindings.some(
        (candidate) => candidate.rawFindingId === raw.rawFindingId,
      )
        ? input.ledger.rawFindings
        : [...input.ledger.rawFindings, raw],
    rawCanonicalSnapshots: raw === undefined
      ? input.ledger.rawCanonicalSnapshots
      : input.ledger.rawCanonicalSnapshots.some(
          (snapshot) => snapshot.rawFindingId === raw.rawFindingId,
        )
        ? input.ledger.rawCanonicalSnapshots
        : [...input.ledger.rawCanonicalSnapshots, rawCanonicalSnapshotFixture(raw, observation)],
  }, {
    reservation,
    evidenceBindings: binding === undefined ? [] : [binding],
  });
  const currentFinding = input.entityKind === 'finding'
    ? input.ledger.findings.find((candidate) => candidate.id === input.entity.id)
    : undefined;
  const entity = finding === null
    ? input.entity
    : {
        ...finding,
        description: findingDescription,
        evidenceIds: [...new Set([
          ...(currentFinding?.evidenceIds ?? []),
          ...finding.evidenceIds,
          ...(evidenceRecord === undefined ? [] : [evidenceRecord.evidenceId]),
        ])].sort(),
        rawFindingIds: [...new Set([
          ...(currentFinding?.rawFindingIds ?? []),
          ...finding.rawFindingIds,
        ])],
        ...(operation === 'invalidate_finding'
          ? {
              invalidatedAt: finding.invalidatedAt ?? observation.timestamp,
              invalidatedEvidence: invalidationEvidence,
            }
          : {}),
      };
  return applyVerifiedLifecycleMutation(pending, {
    mutationId: reservation.mutationId,
    findings: input.entityKind === 'finding' ? [entity as FindingLedgerEntry] : [],
    conflicts: input.entityKind === 'conflict' ? [entity as FindingLedgerConflict] : [],
    occurredAt: observation,
  });
}

export function applyFindingLedgerFixtureSupersession(input: {
  ledger: FindingLedger;
  canonicalFindingId: string;
  duplicates: FindingLedgerEntry[];
}): FindingLedger {
  let ledger = input.ledger;
  let currentCanonical = ledger.findings.find(
    (finding) => finding.id === input.canonicalFindingId,
  );
  if (currentCanonical === undefined) {
    throw new Error(
      `Fixture supersession canonical "${input.canonicalFindingId}" is missing`,
    );
  }
  if (currentCanonical.lifecycle !== 'persists') {
    ledger = applyFindingLedgerFixtureRevision({
      ledger,
      entityKind: 'finding',
      entity: {
        ...currentCanonical,
        lifecycle: 'persists',
        revision: currentCanonical.revision + 1,
      },
    });
    currentCanonical = ledger.findings.find(
      (finding) => finding.id === input.canonicalFindingId,
    )!;
  }
  const currentDuplicates = input.duplicates.map((desired) => {
    const current = ledger.findings.find((finding) => finding.id === desired.id);
    if (current === undefined) {
      throw new Error(`Fixture supersession duplicate "${desired.id}" is missing`);
    }
    return { current, desired };
  });
  const targets = [
    {
      entityKind: 'finding' as const,
      entityId: currentCanonical.id,
      expectedHead: captureFindingLifecycleHead(
        ledger,
        'finding',
        currentCanonical.id,
      )!,
    },
    ...currentDuplicates.map(({ current }) => ({
      entityKind: 'finding' as const,
      entityId: current.id,
      expectedHead: captureFindingLifecycleHead(
        ledger,
        'finding',
        current.id,
      )!,
    })),
  ].sort((left, right) => (
    left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0
  ));
  const observation = fixtureObservation(input.duplicates[0]!);
  const reservation = createFindingLifecycleReservation({
    operation: 'supersede_findings',
    targets,
    evidenceBindingIds: [],
    authority: {
      kind: 'engine_policy',
      decisionKind: 'semantic_duplicate',
      decisionDigest: sha256(
        `fixture-policy:supersede:${targets.map((target) => target.entityId).join(':')}`,
      ),
    },
    context: { kind: 'transaction' },
    reservedAt: observation,
  });
  const pending = reserveVerifiedLifecycleMutation(ledger, {
    reservation,
    evidenceBindings: [],
  });
  return applyVerifiedLifecycleMutation(pending, {
    mutationId: reservation.mutationId,
    findings: [
      {
        ...currentCanonical,
        revision: currentCanonical.revision + 1,
      },
      ...currentDuplicates.map(({ current, desired }) => ({
        ...current,
        status: desired.status,
        lifecycle: desired.lifecycle,
        supersededByFindingId: desired.supersededByFindingId,
        revision: current.revision + 1,
      })),
    ],
    conflicts: [],
    occurredAt: observation,
  });
}

export function authorizeFindingLedgerFixture(input: FindingLedger): FindingLedger {
  const cloned = cloneFixture(input);
  const desired: FindingLedger = {
    ...createEmptyFindingContractRegistries(),
    ...cloned,
    findings: cloned.findings ?? [],
    evidenceRecords: cloned.evidenceRecords ?? [],
    rawFindings: cloned.rawFindings ?? [],
    conflicts: cloned.conflicts ?? [],
    evidenceBindings: cloned.evidenceBindings ?? [],
    lifecycleReservations: cloned.lifecycleReservations ?? [],
    lifecycleEvents: cloned.lifecycleEvents ?? [],
  };
  desired.rawFindings = desired.rawFindings.map((rawFinding) => {
    if (
      rawFinding.target !== undefined
      && rawFinding.targetIdentityHash !== undefined
      && rawFinding.claimIdentityHash !== undefined
      && rawFinding.semanticClaimIdentityHash !== undefined
      && rawFinding.candidateIdentityHash !== undefined
      && rawFinding.sourceBinding !== undefined
    ) {
      return rawFinding;
    }
    const {
      target,
      targetIdentityHash: _targetIdentityHash,
      claimIdentityHash: _claimIdentityHash,
      semanticClaimIdentityHash: _semanticClaimIdentityHash,
      candidateIdentityHash: _candidateIdentityHash,
      sourceBinding,
      ...legacy
    } = rawFinding;
    return canonicalRawFindingFixture({
      ...legacy,
      target,
      sourceBinding,
    });
  });
  const rawById = new Map(
    desired.rawFindings.map((rawFinding) => [rawFinding.rawFindingId, rawFinding]),
  );
  desired.findings = desired.findings.map((finding) => {
    const sourceRaw = (finding.rawFindingIds ?? [])
      .map((rawFindingId) => rawById.get(rawFindingId))
      .find((rawFinding) => rawFinding !== undefined);
    const normalizedBase = {
      ...finding,
      evidenceIds: finding.evidenceIds ?? [],
      reviewers: finding.reviewers ?? (
        sourceRaw === undefined ? [] : [sourceRaw.reviewer]
      ),
      rawFindingIds: finding.rawFindingIds ?? [],
    };
    if (finding.provisional !== undefined) {
      if (sourceRaw !== undefined) {
        return {
          ...normalizedBase,
          target: sourceRaw.target,
          targetIdentityHash: sourceRaw.targetIdentityHash,
          claimIdentityHash: sourceRaw.claimIdentityHash,
          semanticClaimIdentityHash: sourceRaw.semanticClaimIdentityHash,
        };
      }
      if (
        finding.target !== undefined
        && finding.targetIdentityHash !== undefined
        && finding.claimIdentityHash !== undefined
        && finding.semanticClaimIdentityHash !== undefined
      ) {
        return finding;
      }
      return {
        ...normalizedBase,
        target: null,
        targetIdentityHash: null,
        claimIdentityHash: null,
        semanticClaimIdentityHash: null,
      };
    }
    const target = sourceRaw?.target ?? finding.target ?? {
      kind: 'code' as const,
      paths: [`fixtures/${finding.id}.ts`],
    };
    return {
      ...normalizedBase,
      target,
      targetIdentityHash: computeTargetIdentityHash(target),
      claimIdentityHash: computeClaimIdentityHash({
        target,
        familyTag: sourceRaw?.familyTag ?? 'fixture',
        severity: finding.severity,
        title: finding.title,
        description: finding.description ?? finding.title,
        suggestion: sourceRaw?.suggestion ?? finding.suggestion ?? null,
      }),
      semanticClaimIdentityHash: computeSemanticClaimIdentityHash({
        target,
        title: finding.title,
        description: finding.description ?? finding.title,
      }),
    };
  });
  let ledger: FindingLedger = {
    ...desired,
    findings: [],
    conflicts: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawCanonicalSnapshots: desired.rawFindings.map((rawFinding) => (
      desired.rawCanonicalSnapshots.find(
        (snapshot) => snapshot.rawFindingId === rawFinding.rawFindingId,
      ) ?? rawCanonicalSnapshotFixture(rawFinding, {
        runId: 'fixture-run',
        stepName: rawFinding.stepName,
        timestamp: desired.updatedAt,
      })
    )),
  };
  for (const desiredFinding of desired.findings) {
    if (desiredFinding.status === 'superseded') {
      const baseline = cloneFixture({
        ...desiredFinding,
        status: 'open' as const,
        lifecycle: 'new' as const,
        revision: 1,
      });
      delete baseline.supersededByFindingId;
      ledger = applyFindingLedgerFixtureRevision({
        ledger,
        entityKind: 'finding',
        entity: baseline,
      });
      continue;
    }
    const needsPostCreateTransition = desiredFinding.provisional === undefined
      && (
        desiredFinding.status !== 'open'
        || desiredFinding.lifecycle !== 'new'
      );
    const finalRevision = Math.max(
      desiredFinding.revision,
      needsPostCreateTransition ? 2 : 1,
    );
    for (let revision = 1; revision <= finalRevision; revision += 1) {
      const entity = cloneFixture({ ...desiredFinding, revision });
      if (
        revision > 1
        && entity.provisional === undefined
        && entity.status === 'open'
        && entity.lifecycle === 'new'
      ) {
        entity.lifecycle = 'persists';
      }
      if (
        revision < finalRevision
        && desiredFinding.provisional === undefined
      ) {
        entity.status = 'open';
        entity.lifecycle = revision === 1
          ? 'new'
          : desiredFinding.lifecycle === 'reopened'
            ? 'reopened'
            : desiredFinding.lifecycle === 'new'
              ? 'new'
              : 'persists';
        delete entity.resolvedAt;
        delete entity.resolvedEvidence;
        delete entity.waivers;
        delete entity.invalidatedAt;
        delete entity.invalidatedEvidence;
        delete entity.supersededByFindingId;
        delete entity.dismissal;
      }
      ledger = applyFindingLedgerFixtureRevision({
        ledger,
        entityKind: 'finding',
        entity,
      });
    }
  }
  const supersededByCanonical = new Map<string, FindingLedgerEntry[]>();
  for (const finding of desired.findings) {
    if (
      finding.status !== 'superseded'
      || finding.supersededByFindingId === undefined
    ) {
      continue;
    }
    const duplicates = supersededByCanonical.get(finding.supersededByFindingId) ?? [];
    duplicates.push(finding);
    supersededByCanonical.set(finding.supersededByFindingId, duplicates);
  }
  for (const [canonicalFindingId, duplicates] of supersededByCanonical) {
    ledger = applyFindingLedgerFixtureSupersession({
      ledger,
      canonicalFindingId,
      duplicates,
    });
  }
  for (const desiredConflict of desired.conflicts) {
    const finalRevision = Math.max(
      desiredConflict.revision,
      desiredConflict.status === 'resolved' ? 2 : 1,
    );
    for (let revision = 1; revision <= finalRevision; revision += 1) {
      const entity = cloneFixture({ ...desiredConflict, revision });
      if (revision < finalRevision) {
        entity.status = 'active';
        delete entity.resolvedAt;
        delete entity.resolvedEvidence;
      }
      ledger = applyFindingLedgerFixtureRevision({
        ledger,
        entityKind: 'conflict',
        entity,
      });
    }
  }
  return {
    ...ledger,
    nextId: desired.nextId,
    updatedAt: desired.updatedAt,
  };
}

export function emptyFindingAuthorityProjection(): Pick<
  FindingLedger,
  | 'evidenceBindings'
  | 'lifecycleReservations'
  | 'lifecycleEvents'
> & FindingContractLedgerRegistries {
  return {
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    ...createEmptyFindingContractRegistries(),
  };
}
