import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeClaimIdentityHash,
  computeSemanticClaimIdentityHash,
} from '../core/models/finding-claim-identity.js';
import {
  computeFileQuoteEvidenceRecordId,
  createEngineProofRecord,
} from '../core/models/finding-evidence-record.js';
import {
  createFindingEvidenceBinding,
  createFindingLifecycleReservation,
} from '../core/models/finding-lifecycle-identity.js';
import { assertFindingLifecycleAuthorityInvariant } from '../core/models/finding-lifecycle-invariants.js';
import { assertFindingLedgerProjectionInvariant } from '../core/models/finding-ledger-invariants.js';
import { computeRawFindingIntegrityDigest } from '../core/models/finding-raw-integrity.js';
import { FindingInterpretationRecordSchema } from '../core/models/finding-schemas.js';
import {
  createRawRecoveryAttempt,
  createRawRecoveryResult,
} from '../core/models/finding-raw-recovery.js';
import type {
  FindingEvidenceBinding,
  FindingEvidenceRecord,
  FindingLedger,
  FindingLedgerEntry,
  FindingLifecycleEntityHead,
  FindingLifecycleMutationTarget,
  FindingLifecycleOperation,
  FindingObservation,
  RawFinding,
} from '../core/workflow/findings/types.js';
import {
  applyVerifiedLifecycleMutation,
  reserveVerifiedLifecycleMutation,
  type VerifiedLifecycleMutation,
  type VerifiedLifecycleReservation,
} from '../core/workflow/findings/lifecycle-mutation.js';
import {
  applyFindingLifecycleCommands,
  mergeFindingLifecycleCommandState,
  reserveFindingConflictAdjudicationLifecycle,
} from '../core/workflow/findings/lifecycle-transaction.js';
import { applyFindingConflictAdjudication } from '../core/workflow/findings/adjudication-apply.js';
import { formatConflictId } from '../core/models/finding-conflict-identity.js';
import { reconcileFindingLedgerPlan } from '../core/workflow/findings/reconciler.js';
import { assembleAndApplyManagerLifecycleTransactions } from '../core/workflow/findings/manager-lifecycle-assembly.js';
import { issueManagerLifecycleAuthority } from '../core/workflow/findings/manager-lifecycle-authority.js';
import {
  computeLineageKey,
  computeReviewerStableKey,
} from '../core/workflow/findings/raw-canonicalization.js';
import { storedRawReconcileProvenance } from './helpers/finding-integrity.js';
import type { FindingManagerOutput } from '../core/workflow/findings/types.js';
import { assertFindingLedgerAppendOnlyTransition } from '../core/workflow/findings/finding-integrity.js';
import { createFindingLedgerStore } from '../core/workflow/findings/store.js';
import { reserveRawAdjudicationRecovery } from '../core/workflow/findings/raw-adjudication-reservation.js';
import { parseFindingConflictAdjudicationOutput } from '../core/workflow/findings/schemas.js';
import { applyInterpretationRecoveryFailures } from '../core/workflow/findings/interpretation-recovery.js';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
  resumeRealRunStorage,
} from './helpers/run-storage.js';
import { canonicalRawFindingFixture } from './helpers/finding-lifecycle-fixture.js';
import { createAnchorAdjudication } from '../core/models/finding-anchor-relevance.js';
import {
  captureFindingMutationPrecondition,
} from '../core/workflow/findings/finding-preconditions.js';
import {
  createFindingLedgerEntry,
  createProductFindingEntry,
} from '../core/workflow/findings/finding-entry.js';
import {
  issueProvisionalProductTransitionAuthorityProof,
} from '../core/workflow/findings/provisional-product-transition-proof.js';

const OBSERVATION: FindingObservation = {
  runId: 'run-1',
  stepName: 'findings-manager',
  timestamp: '2026-07-29T00:00:00.000Z',
};

const temporaryDirectories = new Set<string>();

afterEach(() => {
  cleanupRealRunStorages();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function loadRootFindingLedger(
  root: ReturnType<typeof createRealRunStorage>['root'],
  ownerKey: string,
): FindingLedger {
  const lease = root.claimLease({ ownerKey, leaseDurationMs: 10_000 });
  const runtime = root.runtime({ lease });
  const scope = runtime.scopes.get();
  const execution = runtime.execution.startStep({
    stepKey: `${ownerKey}-load`,
    expectedScopeRevision: scope.revision,
  });
  return runtime.findingManager({
    workflowName: 'default',
    producer: execution.handle,
  }).loadLedger();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface EvidenceSource {
  readonly raw: RawFinding;
  readonly record: FindingEvidenceRecord;
  readonly claimIdentityHash: string;
}

function evidenceSource(input: {
  rawFindingId: string;
  targetFindingId: string | null;
  title: string;
  description: string;
  relation?: RawFinding['relation'];
  targetPath?: string;
}): EvidenceSource {
  const path = input.targetPath ?? `src/${input.rawFindingId}.ts`;
  const raw = canonicalRawFindingFixture({
    rawFindingId: input.rawFindingId,
    stepName: OBSERVATION.stepName,
    reviewer: 'reviewer',
    familyTag: 'bug',
    severity: 'high',
    title: input.title,
    description: input.description,
    suggestion: null,
    relation: input.relation ?? (input.targetFindingId === null ? 'new' : 'persists'),
    targetFindingId: input.targetFindingId,
    target: { kind: 'code', paths: [path] },
    evidence: [],
  });
  const claimIdentityHash = raw.claimIdentityHash;
  const recordPayload = {
    kind: 'file_quote' as const,
    path,
    startLine: 1,
    endLine: 1,
    verbatimExcerpt: input.description,
    snapshotId: sha256(`snapshot:${input.rawFindingId}`),
    claimIdentityHash,
    fileHash: sha256(`file:${input.rawFindingId}`),
  };
  const record: FindingEvidenceRecord = {
    evidenceId: computeFileQuoteEvidenceRecordId(recordPayload),
    ...recordPayload,
  };
  return {
    claimIdentityHash,
    record,
    raw: {
      ...raw,
      evidence: [{
        kind: 'file_quote',
        path: record.path,
        startLine: record.startLine,
        endLine: record.endLine,
        verbatimExcerpt: record.verbatimExcerpt,
        snapshotId: record.snapshotId,
      }],
    },
  };
}

function incompleteEvidenceSource(input: {
  rawFindingId: string;
  targetPath: string;
}): EvidenceSource {
  const raw = canonicalRawFindingFixture({
    rawFindingId: input.rawFindingId,
    stepName: OBSERVATION.stepName,
    reviewer: 'reviewer',
    familyTag: null,
    severity: null,
    title: null,
    description: null,
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: [input.targetPath] },
    evidence: [],
  });
  const recordPayload = {
    kind: 'file_quote' as const,
    path: input.targetPath,
    startLine: 1,
    endLine: 1,
    verbatimExcerpt: 'The initial observation is incomplete.',
    snapshotId: sha256(`snapshot:${input.rawFindingId}`),
    claimIdentityHash: raw.claimIdentityHash,
    fileHash: sha256(`file:${input.rawFindingId}`),
  };
  const record: FindingEvidenceRecord = {
    evidenceId: computeFileQuoteEvidenceRecordId(recordPayload),
    ...recordPayload,
  };
  return {
    claimIdentityHash: raw.claimIdentityHash,
    record,
    raw: {
      ...raw,
      evidence: [{
        kind: 'file_quote',
        path: record.path,
        startLine: record.startLine,
        endLine: record.endLine,
        verbatimExcerpt: record.verbatimExcerpt,
        snapshotId: record.snapshotId,
      }],
    },
  };
}

function emptyLedger(sources: readonly EvidenceSource[]): FindingLedger {
  return {
    workflowName: 'default',
    nextId: 1,
    updatedAt: '1970-01-01T00:00:01.000Z',
    findings: [],
    evidenceRecords: sources.map((source) => source.record),
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawRecoveryAttempts: [],
    rawRecoveryResults: [],
    rawFindings: sources.map((source) => source.raw),
    conflicts: [],
    interpretations: [],
  };
}

function finding(input: {
  id: string;
  source: EvidenceSource;
  revision: number;
  evidenceIds?: string[];
  status?: FindingLedgerEntry['status'];
  lifecycle?: FindingLedgerEntry['lifecycle'];
}): FindingLedgerEntry {
  return {
    id: input.id,
    status: input.status ?? 'open',
    lifecycle: input.lifecycle ?? 'new',
    revision: input.revision,
    target: input.source.raw.target,
    targetIdentityHash: input.source.raw.targetIdentityHash,
    claimIdentityHash: input.source.raw.claimIdentityHash,
    semanticClaimIdentityHash: input.source.raw.semanticClaimIdentityHash,
    severity: 'high',
    title: input.source.raw.title,
    description: input.source.raw.description,
    evidenceIds: input.evidenceIds ?? [input.source.record.evidenceId],
    reviewers: ['reviewer'],
    rawFindingIds: [input.source.raw.rawFindingId],
    firstSeen: { ...OBSERVATION },
    lastSeen: { ...OBSERVATION },
    ...(input.status === 'resolved'
      ? {
          resolvedAt: OBSERVATION.timestamp,
          resolvedEvidence: 'verified evidence',
        }
      : {}),
  };
}

function reservation(input: {
  operation: FindingLifecycleOperation;
  targets: FindingLifecycleMutationTarget[];
  sources: EvidenceSource[];
}): VerifiedLifecycleReservation {
  const evidenceBindings = input.targets.map((target, index) => {
    const source = input.sources[index]!;
    return createFindingEvidenceBinding({
      evidenceId: source.record.evidenceId,
      claimIdentityHash: source.claimIdentityHash,
      sourceRawFindingId: source.raw.rawFindingId,
      sourceRawIntegrityDigest: computeRawFindingIntegrityDigest(source.raw),
      operation: input.operation,
      target,
    });
  }).sort((left, right) => left.bindingId.localeCompare(right.bindingId));
  return {
    reservation: createFindingLifecycleReservation({
      operation: input.operation,
      targets: input.targets,
      evidenceBindingIds: evidenceBindings.map((binding) => binding.bindingId),
      authority: { kind: 'verified_evidence' },
      context: { kind: 'transaction' },
      reservedAt: OBSERVATION,
    }),
    evidenceBindings,
  };
}

function oneTargetReservation(input: {
  operation: FindingLifecycleOperation;
  target: FindingLifecycleMutationTarget;
  sources: EvidenceSource[];
  authorityEvidenceRecords?: Extract<
    FindingEvidenceRecord,
    { kind: 'engine_proof' }
  >[];
}): VerifiedLifecycleReservation {
  const evidenceBindings = [
    ...input.sources.map((source) => (
      createFindingEvidenceBinding({
        evidenceId: source.record.evidenceId,
        claimIdentityHash: source.claimIdentityHash,
        sourceRawFindingId: source.raw.rawFindingId,
        sourceRawIntegrityDigest: computeRawFindingIntegrityDigest(source.raw),
        operation: input.operation,
        target: input.target,
      })
    )),
    ...(input.authorityEvidenceRecords ?? []).map((record) => (
      createFindingEvidenceBinding({
        evidenceId: record.evidenceId,
        claimIdentityHash: record.claimIdentityHash,
        sourceRawFindingId: null,
        sourceRawIntegrityDigest: null,
        operation: input.operation,
        target: input.target,
      })
    )),
  ].sort((left, right) => left.bindingId.localeCompare(right.bindingId));
  return {
    reservation: createFindingLifecycleReservation({
      operation: input.operation,
      targets: [input.target],
      evidenceBindingIds: evidenceBindings.map((binding) => binding.bindingId),
      authority: { kind: 'verified_evidence' },
      context: { kind: 'transaction' },
      reservedAt: OBSERVATION,
    }),
    evidenceBindings,
  };
}

function proofedProvisionalTransition(input: {
  ledger: FindingLedger;
  operation: 'promote_provisional' | 'reopen_finding';
  target: FindingLifecycleMutationTarget;
  sources: EvidenceSource[];
  product: FindingLedgerEntry;
}): {
  ledger: FindingLedger;
  reservation: VerifiedLifecycleReservation;
  product: FindingLedgerEntry;
} {
  const product = createProductFindingEntry(input.product);
  const proof = issueProvisionalProductTransitionAuthorityProof({
    observationLedger: input.ledger,
    intermediateLedger: input.ledger,
    operation: input.operation,
    findingId: product.id,
    transitionRawFindings: input.sources.map((source) => source.raw),
    product,
    workflowName: input.ledger.workflowName,
    runId: OBSERVATION.runId,
    scopeIdentity: 'formal-provisional-transition-test',
    reviewScopeSnapshotId: sha256('formal-provisional-transition-snapshot'),
    observation: OBSERVATION,
  });
  return {
    ledger: {
      ...input.ledger,
      evidenceRecords: [...input.ledger.evidenceRecords, proof],
    },
    reservation: oneTargetReservation({
      operation: input.operation,
      target: input.target,
      sources: input.sources,
      authorityEvidenceRecords: [proof],
    }),
    product: {
      ...product,
      evidenceIds: [...new Set([...product.evidenceIds, proof.evidenceId])].sort(),
    },
  };
}

function mutation(input: {
  reservation: VerifiedLifecycleReservation;
  findings: FindingLedgerEntry[];
}): VerifiedLifecycleMutation {
  return {
    mutationId: input.reservation.reservation.mutationId,
    findings: input.findings,
    conflicts: [],
    occurredAt: OBSERVATION,
  };
}

function latestHead(ledger: FindingLedger, entityId: string): FindingLifecycleEntityHead {
  const transition = [...ledger.lifecycleEvents].reverse().flatMap(
    (event) => event.transitions,
  ).find((candidate) => candidate.after.entityId === entityId);
  if (transition === undefined) {
    throw new Error(`Missing lifecycle head for "${entityId}"`);
  }
  return transition.after;
}

function promotionBoundaryFixture(input: {
  initialSource?: EvidenceSource;
  transitionPath?: string;
  stalePrecondition?: boolean;
  inconsistentTransitionClaim?: boolean;
  productSource?: EvidenceSource;
} = {}): {
  ledger: FindingLedger;
  reservation: VerifiedLifecycleReservation;
  product: FindingLedgerEntry;
  transitionSource: EvidenceSource;
} {
  const initialSource = input.initialSource ?? incompleteEvidenceSource({
    rawFindingId: 'raw-formal-provisional',
    targetPath: 'src/formal-provisional.ts',
  });
  const createTarget = {
    entityKind: 'finding' as const,
    entityId: 'F-0001',
    expectedHead: null,
  };
  const createReservation = reservation({
    operation: 'create_finding',
    targets: [createTarget],
    sources: [initialSource],
  });
  const {
    description: _description,
    ...nullableBase
  } = finding({
    id: createTarget.entityId,
    source: initialSource,
    revision: 1,
  });
  const provisional: FindingLedgerEntry = {
    ...nullableBase,
    severity: null,
    title: null,
    provisional: {
      kind: 'raw-adjudication-unresolved',
      stableKey: sha256('formal-promotion-stable'),
      lineageKey: sha256('formal-promotion-lineage'),
      sourceRawFindingIds: [initialSource.raw.rawFindingId],
      reason: 'The initial claim is incomplete.',
      firstObservedAt: { ...OBSERVATION },
      lastObservedAt: { ...OBSERVATION },
      interpretationEpochs: 0,
      gateEffect: 'block',
      firstObservedRound: 1,
    },
  };
  const provisionalLedger = applyVerifiedLifecycleMutation(
    reserveVerifiedLifecycleMutation(
      emptyLedger([initialSource]),
      createReservation,
    ),
    mutation({
      reservation: createReservation,
      findings: [provisional],
    }),
  );
  const transitionDraft = evidenceSource({
    rawFindingId: 'raw-formal-promotion',
    targetFindingId: provisional.id,
    title: 'Complete formal claim',
    description: 'The transition raw supplies the complete product claim.',
    relation: 'persists',
    targetPath: input.transitionPath ?? 'src/formal-provisional.ts',
  });
  const transitionSource: EvidenceSource = {
    ...transitionDraft,
    raw: {
      ...transitionDraft.raw,
      targetPrecondition: {
        ...captureFindingMutationPrecondition(provisionalLedger, provisional.id)!,
        targetRevision: provisional.revision + (input.stalePrecondition === true ? 1 : 0),
      },
    },
  };
  const inconsistentDraft = input.inconsistentTransitionClaim === true
    ? evidenceSource({
        rawFindingId: 'raw-formal-promotion-inconsistent',
        targetFindingId: provisional.id,
        title: 'Different formal claim',
        description: 'This transition raw describes a different product claim.',
        relation: 'persists',
        targetPath: input.transitionPath ?? 'src/formal-provisional.ts',
      })
    : undefined;
  const inconsistentSource: EvidenceSource | undefined = inconsistentDraft === undefined
    ? undefined
    : {
        ...inconsistentDraft,
        raw: {
          ...inconsistentDraft.raw,
          targetPrecondition: transitionSource.raw.targetPrecondition!,
        },
      };
  const sources = [
    transitionSource,
    ...(inconsistentSource === undefined ? [] : [inconsistentSource]),
  ];
  const ledger = {
    ...provisionalLedger,
    evidenceRecords: [
      ...provisionalLedger.evidenceRecords,
      ...sources.map((source) => source.record),
    ],
    rawFindings: [
      ...provisionalLedger.rawFindings,
      ...sources.map((source) => source.raw),
    ],
  };
  const target = {
    entityKind: 'finding' as const,
    entityId: provisional.id,
    expectedHead: latestHead(provisionalLedger, provisional.id),
  };
  const productSource = input.productSource ?? transitionSource;
  const product: FindingLedgerEntry = {
    ...finding({
      id: provisional.id,
      source: productSource,
      revision: provisional.revision + 1,
      lifecycle: 'persists',
      evidenceIds: [
        initialSource.record.evidenceId,
        ...sources.map((source) => source.record.evidenceId),
      ].sort(),
    }),
    rawFindingIds: [
      initialSource.raw.rawFindingId,
      ...sources.map((source) => source.raw.rawFindingId),
    ].sort(),
  };
  const proofed = proofedProvisionalTransition({
    ledger,
    operation: 'promote_provisional',
    target,
    sources,
    product,
  });
  return {
    ...proofed,
    transitionSource,
  };
}

function emptyManagerOutput(): FindingManagerOutput {
  return {
    anchorAdjudications: [],
    matches: [],
    newFindings: [],
    resolvedFindings: [],
    reopenedFindings: [],
    conflicts: [],
    resolvedConflicts: [],
    waivedFindings: [],
    disputeNotes: [],
    invalidatedFindings: [],
    duplicateFindings: [],
    dismissedFindings: [],
  };
}

function adjudicationLedger(): FindingLedger {
  const findingSources = [
    evidenceSource({
      rawFindingId: 'raw-adjudication-a',
      targetFindingId: null,
      title: 'Finding A',
      description: 'First adjudication target.',
    }),
    evidenceSource({
      rawFindingId: 'raw-adjudication-b',
      targetFindingId: null,
      title: 'Finding B',
      description: 'Second adjudication target.',
    }),
  ];
  const conflictSource = evidenceSource({
    rawFindingId: 'raw-adjudication-conflict',
    targetFindingId: 'F-0001',
    title: 'Conflicting observation',
    description: 'The findings have conflicting evidence.',
    relation: 'persists',
  });
  const sources = [...findingSources, conflictSource];
  const conflictId = formatConflictId({
    findingIds: ['F-0001', 'F-0002'],
    rawFindingIds: [conflictSource.raw.rawFindingId],
  });
  const conflict = {
    id: conflictId,
    status: 'active' as const,
    findingIds: ['F-0001', 'F-0002'],
    rawFindingIds: [conflictSource.raw.rawFindingId],
    description: 'The two findings require adjudication.',
    firstSeen: OBSERVATION,
    lastSeen: OBSERVATION,
  };
  return applyFindingLifecycleCommands({
    ledger: emptyLedger(sources),
    commands: [
      ...findingSources.map((source, index) => {
        const created = finding({
          id: `F-${String(index + 1).padStart(4, '0')}`,
          source,
          revision: 1,
        });
        const { revision: _revision, ...projection } = created;
        return {
          operation: 'create_finding' as const,
          changes: { findings: [projection], conflicts: [] },
          authority: { kind: 'verified_evidence' as const },
          evidenceSourcesByTarget: new Map([[
            `finding\0${created.id}`,
            {
              sourceRawFindingIds: [source.raw.rawFindingId],
              authorityEvidenceIds: [],
            },
          ]]),
        };
      }),
      {
        operation: 'create_conflict',
        changes: { findings: [], conflicts: [conflict] },
        authority: { kind: 'verified_evidence' },
        evidenceSourcesByTarget: new Map([[
          `conflict\0${conflictId}`,
          {
            sourceRawFindingIds: [conflictSource.raw.rawFindingId],
            authorityEvidenceIds: [],
          },
        ]]),
      },
    ],
    occurredAt: OBSERVATION,
  });
}

function semanticDuplicateLedger(count: number): FindingLedger {
  const sources = Array.from({ length: count }, (_, index) => evidenceSource({
    rawFindingId: `raw-semantic-duplicate-${index + 1}`,
    targetFindingId: null,
    title: 'Same duplicate claim',
    description: 'Every candidate has the same claim identity.',
    targetPath: 'src/shared-semantic-duplicate.ts',
  }));
  return applyFindingLifecycleCommands({
    ledger: emptyLedger(sources),
    commands: sources.map((source, index) => {
      const created = finding({
        id: `F-${String(index + 1).padStart(4, '0')}`,
        source,
        revision: 1,
      });
      const { revision: _revision, ...projection } = created;
      return {
        operation: 'create_finding' as const,
        changes: { findings: [projection], conflicts: [] },
        authority: { kind: 'verified_evidence' as const },
        evidenceSourcesByTarget: new Map([[
          `finding\0${created.id}`,
          {
            sourceRawFindingIds: [source.raw.rawFindingId],
            authorityEvidenceIds: [],
          },
        ]]),
      };
    }),
    occurredAt: OBSERVATION,
  });
}

function semanticManagerPlan(input: {
  current: FindingLedger;
  sources: readonly EvidenceSource[];
  managerOutput: FindingManagerOutput;
}) {
  const sourceById = new Map(input.sources.map((source) => [
    source.raw.rawFindingId,
    source.raw,
  ]));
  const landed = [
    ...input.managerOutput.matches.flatMap((entry) => entry.rawFindingIds.map((rawFindingId) => ({
      rawFindingId,
      decision: 'same' as const,
      findingId: entry.findingId,
      evidence: entry.evidence ?? 'Matched by the fixture manager.',
    }))),
    ...input.managerOutput.newFindings.flatMap((entry) => entry.rawFindingIds.map((rawFindingId) => ({
      rawFindingId,
      decision: 'new' as const,
      evidence: 'Created by the fixture manager.',
    }))),
    ...input.managerOutput.resolvedFindings.flatMap((entry) => entry.rawFindingIds.map((rawFindingId) => ({
      rawFindingId,
      decision: 'resolved' as const,
      findingId: entry.findingId,
      evidence: entry.evidence,
    }))),
    ...input.managerOutput.reopenedFindings.flatMap((entry) => entry.rawFindingIds.map((rawFindingId) => ({
      rawFindingId,
      decision: 'reopened' as const,
      findingId: entry.findingId,
      evidence: entry.evidence,
    }))),
    ...input.managerOutput.conflicts.flatMap((entry) => entry.rawFindingIds.map((rawFindingId) => ({
      rawFindingId,
      decision: 'conflict' as const,
      findingId: entry.findingIds[0],
      evidence: entry.description,
    }))),
  ];
  const managerOutput: FindingManagerOutput = {
    ...input.managerOutput,
    anchorAdjudications: landed.map((decision) => {
      const rawFinding = sourceById.get(decision.rawFindingId);
      if (rawFinding === undefined || rawFinding.target.kind === 'absence') {
        throw new Error(`Fixture manager cannot synthesize a non-absence anchor for "${decision.rawFindingId}"`);
      }
      return createAnchorAdjudication({
        ...decision,
        anchorRelevance: 'not_applicable',
      });
    }),
  };
  input.managerOutput.anchorAdjudications = managerOutput.anchorAdjudications;
  return reconcileFindingLedgerPlan({
    previousLedger: input.current,
    rawFindings: input.sources.map((source) => source.raw),
    managerOutput,
    entityProvisionalMutations: [],
    terminalEntityAttachmentFindingIds: new Set(),
    provisionalFindings: [],
    rawFindingDispositions: [],
    verifiedEvidenceRecordsByRawFindingId: new Map(input.sources.map((source) => [
      source.raw.rawFindingId,
      [source.record],
    ])),
    rawProvenanceByRawFindingId: new Map(input.sources.map((source) => [
      source.raw.rawFindingId,
      storedRawReconcileProvenance(
        source.raw,
        computeReviewerStableKey({
          workflowName: input.current.workflowName,
          callNamespace: '',
          parentStepName: OBSERVATION.stepName,
          reviewerPersonaKey: source.raw.reviewer,
        }),
        computeLineageKey({
          claimIdentityHash: computeClaimIdentityHash(source.raw),
          ...(source.raw.targetFindingId === null
            ? {}
            : { targetFindingId: source.raw.targetFindingId }),
        }),
      ),
    ])),
    context: {
      workflowName: input.current.workflowName,
      ...OBSERVATION,
    },
  });
}

function applySemanticManagerPlan(input: {
  current: FindingLedger;
  plan: ReturnType<typeof semanticManagerPlan>;
  managerOutput: FindingManagerOutput;
}): FindingLedger {
  return assembleAndApplyManagerLifecycleTransactions({
    current: input.current,
    managerDecisionProposed: input.plan.ledger,
    managerDecisionCommands: input.plan.lifecycleCommands,
    proposed: input.plan.ledger,
    managerOutput: input.managerOutput,
    provisionalProofIdsByFinding: new Map(),
    rawRecoveryProvisionalProofIdsByFinding: new Map(),
    invalidationProofIdsByFinding: new Map(),
    duplicateProofIdsByCommandKey: new Map(),
    managerDecisionProvisionalTransitionProofIdsByCommandKey: new Map(),
    provisionalTransitionProofIdsByCommandKey: new Map(),
    rawRecoveryManagerDecisionProvisionalTransitionProofIdsByCommandKey: new Map(),
    rawRecoveryProvisionalTransitionProofIdsByCommandKey: new Map(),
    invalidationReasonsByFinding: new Map(),
    resolutionRenotifications: [],
    settlementCommands: [],
    actionRecoveryPlan: null,
    occurredAt: OBSERVATION,
  });
}

function applyProofedSemanticManagerPlan(input: {
  current: FindingLedger;
  plan: ReturnType<typeof semanticManagerPlan>;
  managerOutput: FindingManagerOutput;
}): FindingLedger {
  const proofed = issueManagerLifecycleAuthority({
    current: input.current,
    rawRecoveryCurrent: input.current,
    rawRecoveryManagerDecisionProposed: input.current,
    rawRecoveryManagerDecisionCommands: [],
    rawRecoverySettlementCommands: [],
    managerDecisionProposed: input.plan.ledger,
    proposed: input.plan.ledger,
    managerDecisionCommands: input.plan.lifecycleCommands,
    settlementCommands: [],
    managerOutput: input.managerOutput,
    cwd: process.cwd(),
    workflowName: input.current.workflowName,
    runId: OBSERVATION.runId,
    scopeIdentity: 'semantic-command-production-test',
    reviewScopeSnapshotId: sha256('semantic-command-production-snapshot'),
    observation: OBSERVATION,
  });
  const managerDecisionProposed: FindingLedger = {
    ...proofed.ledger,
    findings: input.plan.ledger.findings.map((finding) => {
      const proofedFinding = proofed.ledger.findings.find(
        (candidate) => candidate.id === finding.id,
      )!;
      const proofEvidenceIds = proofedFinding.evidenceIds.filter((evidenceId) => (
        proofed.ledger.evidenceRecords.some((record) => (
          record.evidenceId === evidenceId && record.kind === 'engine_proof'
        ))
      ));
      return {
        ...finding,
        evidenceIds: [...new Set([...finding.evidenceIds, ...proofEvidenceIds])].sort(),
      };
    }),
    conflicts: input.plan.ledger.conflicts,
  };
  return assembleAndApplyManagerLifecycleTransactions({
    current: input.current,
    managerDecisionProposed,
    managerDecisionCommands: input.plan.lifecycleCommands,
    proposed: proofed.ledger,
    managerOutput: input.managerOutput,
    provisionalProofIdsByFinding: proofed.provisionalProofIdsByFinding,
    rawRecoveryProvisionalProofIdsByFinding:
      proofed.rawRecoveryProvisionalProofIdsByFinding,
    invalidationProofIdsByFinding: proofed.invalidationProofIdsByFinding,
    duplicateProofIdsByCommandKey: proofed.duplicateProofIdsByCommandKey,
    managerDecisionProvisionalTransitionProofIdsByCommandKey:
      proofed.managerDecisionProvisionalTransitionProofIdsByCommandKey,
    provisionalTransitionProofIdsByCommandKey:
      proofed.provisionalTransitionProofIdsByCommandKey,
    rawRecoveryManagerDecisionProvisionalTransitionProofIdsByCommandKey:
      proofed.rawRecoveryManagerDecisionProvisionalTransitionProofIdsByCommandKey,
    rawRecoveryProvisionalTransitionProofIdsByCommandKey:
      proofed.rawRecoveryProvisionalTransitionProofIdsByCommandKey,
    invalidationReasonsByFinding: proofed.invalidationReasonsByFinding,
    resolutionRenotifications: [],
    settlementCommands: [],
    actionRecoveryPlan: null,
    occurredAt: OBSERVATION,
  });
}

describe('verified finding lifecycle mutation', () => {
  it('omits explicit undefined optional finding fields from the persisted projection', () => {
    const source = evidenceSource({
      rawFindingId: 'raw-canonical-provisional',
      targetFindingId: null,
      title: 'Canonical provisional',
      description: 'The persisted projection must be JSON-roundtrippable.',
      targetPath: 'src/canonical-provisional.ts',
    });
    const canonical = createFindingLedgerEntry({
      ...finding({
        id: 'F-0001',
        source,
        revision: 1,
      }),
      suggestion: undefined,
      provisional: {
        kind: 'raw-adjudication-unresolved',
        stableKey: sha256('canonical-provisional-stable'),
        lineageKey: sha256('canonical-provisional-lineage'),
        sourceRawFindingIds: [source.raw.rawFindingId],
        reason: 'Awaiting a clean targeted re-observation.',
        firstObservedAt: { ...OBSERVATION },
        lastObservedAt: { ...OBSERVATION },
        interpretationEpochs: 0,
        gateEffect: 'block',
        firstObservedRound: 1,
        actionRecovery: undefined,
        actionRecoveryAttempts: undefined,
        recoveryReviewerStableKey: undefined,
      },
    });

    expect(Object.hasOwn(canonical, 'suggestion')).toBe(false);
    expect(Object.hasOwn(canonical.provisional!, 'actionRecovery')).toBe(false);
    expect(Object.hasOwn(canonical.provisional!, 'actionRecoveryAttempts')).toBe(false);
    expect(Object.hasOwn(canonical.provisional!, 'recoveryReviewerStableKey')).toBe(false);
    expect(JSON.parse(JSON.stringify(canonical))).toEqual(canonical);
  });

  it('authorizes provisional promotion only from clean persists evidence bound to the provisional target', () => {
    const provisionalSource = evidenceSource({
      rawFindingId: 'raw-provisional-source',
      targetFindingId: null,
      title: 'Provisional claim',
      description: 'The claim awaits a clean targeted re-observation.',
      targetPath: 'src/provisional.ts',
    });
    const createTarget = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: null,
    };
    const createReservation = reservation({
      operation: 'create_finding',
      targets: [createTarget],
      sources: [provisionalSource],
    });
    const provisional = applyVerifiedLifecycleMutation(
      reserveVerifiedLifecycleMutation(emptyLedger([provisionalSource]), createReservation),
      mutation({
        reservation: createReservation,
        findings: [{
          ...finding({
            id: createTarget.entityId,
            source: provisionalSource,
            revision: 1,
          }),
          provisional: {
            kind: 'raw-adjudication-unresolved',
            stableKey: sha256('promotion-stable-key'),
            lineageKey: sha256('promotion-lineage-key'),
            sourceRawFindingIds: [provisionalSource.raw.rawFindingId],
            reason: 'Awaiting a clean targeted re-observation.',
            firstObservedAt: { ...OBSERVATION },
            lastObservedAt: { ...OBSERVATION },
            interpretationEpochs: 0,
            gateEffect: 'block',
            firstObservedRound: 1,
            recoveryReviewerStableKey: 'reviewer',
          },
        }],
      }),
    );
    const promotionTarget = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: latestHead(provisional, 'F-0001'),
    };
    const source = (
      rawFindingId: string,
      relation: RawFinding['relation'],
      targetFindingId: string | null,
    ) => evidenceSource({
      rawFindingId,
      targetFindingId,
      title: 'Provisional claim',
      description: 'The claim awaits a clean targeted re-observation.',
      relation,
      targetPath: 'src/provisional.ts',
    });
    const valid = source('raw-promotion-valid', 'persists', 'F-0001');
    const relationNew = source('raw-promotion-new', 'new', null);
    const wrongTarget = source('raw-promotion-wrong-target', 'persists', 'F-0002');
    const withEvidence: FindingLedger = {
      ...provisional,
      evidenceRecords: [
        ...provisional.evidenceRecords,
        valid.record,
        relationNew.record,
        wrongTarget.record,
      ],
      rawFindings: [
        ...provisional.rawFindings,
        valid.raw,
        relationNew.raw,
        wrongTarget.raw,
      ],
    };

    expect(() => reserveVerifiedLifecycleMutation(withEvidence, reservation({
      operation: 'promote_provisional',
      targets: [promotionTarget],
      sources: [valid],
    }))).not.toThrow();
    expect(() => reserveVerifiedLifecycleMutation(withEvidence, reservation({
      operation: 'promote_provisional',
      targets: [promotionTarget],
      sources: [relationNew],
    }))).toThrow(/relation "new".*"promote_provisional"/);
    expect(() => reserveVerifiedLifecycleMutation(withEvidence, reservation({
      operation: 'promote_provisional',
      targets: [promotionTarget],
      sources: [wrongTarget],
    }))).toThrow(/relation "persists".*"promote_provisional"/);
    expect(() => reserveVerifiedLifecycleMutation(withEvidence, reservation({
      operation: 'promote_provisional',
      targets: [{
        ...promotionTarget,
        expectedHead: {
          ...promotionTarget.expectedHead!,
          revision: promotionTarget.expectedHead!.revision + 1,
        },
      }],
      sources: [valid],
    }))).toThrow(/stale full head/);
    expect(() => reserveVerifiedLifecycleMutation(withEvidence, reservation({
      operation: 'promote_provisional',
      targets: [{
        ...promotionTarget,
        expectedHead: {
          ...promotionTarget.expectedHead!,
          projectionDigest: sha256('resolved-status-projection'),
        },
      }],
      sources: [valid],
    }))).toThrow(/stale full head/);
  });

  it('commits a complete product claim when promoting a nullable provisional', () => {
    const provisionalSource = incompleteEvidenceSource({
      rawFindingId: 'raw-nullable-provisional',
      targetPath: 'src/nullable-provisional.ts',
    });
    const createTarget = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: null,
    };
    const createReservation = reservation({
      operation: 'create_finding',
      targets: [createTarget],
      sources: [provisionalSource],
    });
    const {
      description: _description,
      ...nullableBase
    } = finding({
      id: createTarget.entityId,
      source: provisionalSource,
      revision: 1,
    });
    const provisionalFinding: FindingLedgerEntry = {
      ...nullableBase,
      severity: null,
      title: null,
      provisional: {
        kind: 'raw-adjudication-unresolved',
        stableKey: sha256('nullable-promotion-stable'),
        lineageKey: sha256('nullable-promotion-lineage'),
        sourceRawFindingIds: [provisionalSource.raw.rawFindingId],
        reason: 'The initial claim is incomplete.',
        firstObservedAt: { ...OBSERVATION },
        lastObservedAt: { ...OBSERVATION },
        interpretationEpochs: 0,
        gateEffect: 'block',
        firstObservedRound: 1,
      },
    };
    const provisionalLedger = applyVerifiedLifecycleMutation(
      reserveVerifiedLifecycleMutation(
        emptyLedger([provisionalSource]),
        createReservation,
      ),
      mutation({
        reservation: createReservation,
        findings: [provisionalFinding],
      }),
    );
    const promotedSourceDraft = evidenceSource({
      rawFindingId: 'raw-nullable-promotion',
      targetFindingId: createTarget.entityId,
      title: 'Complete promoted claim',
      description: 'The later observation supplies the complete product claim.',
      relation: 'persists',
      targetPath: 'src/nullable-provisional.ts',
    });
    const promotedSource: EvidenceSource = {
      ...promotedSourceDraft,
      raw: {
        ...promotedSourceDraft.raw,
        targetPrecondition: captureFindingMutationPrecondition(
          provisionalLedger,
          createTarget.entityId,
        )!,
      },
    };
    const withPromotionEvidence: FindingLedger = {
      ...provisionalLedger,
      evidenceRecords: [
        ...provisionalLedger.evidenceRecords,
        promotedSource.record,
      ],
      rawFindings: [
        ...provisionalLedger.rawFindings,
        promotedSource.raw,
      ],
    };
    const promotionTarget = {
      entityKind: 'finding' as const,
      entityId: createTarget.entityId,
      expectedHead: latestHead(provisionalLedger, createTarget.entityId),
    };
    const productFinding: FindingLedgerEntry = {
      ...finding({
        id: createTarget.entityId,
        source: promotedSource,
        revision: 2,
        lifecycle: 'persists',
        evidenceIds: [
          provisionalSource.record.evidenceId,
          promotedSource.record.evidenceId,
        ].sort(),
      }),
      rawFindingIds: [
        provisionalSource.raw.rawFindingId,
        promotedSource.raw.rawFindingId,
      ].sort(),
    };
    const proofedPromotion = proofedProvisionalTransition({
      ledger: withPromotionEvidence,
      operation: 'promote_provisional',
      target: promotionTarget,
      sources: [promotedSource],
      product: productFinding,
    });
    const committed = applyVerifiedLifecycleMutation(
      reserveVerifiedLifecycleMutation(
        proofedPromotion.ledger,
        proofedPromotion.reservation,
      ),
      mutation({
        reservation: proofedPromotion.reservation,
        findings: [proofedPromotion.product],
      }),
    );

    expect(committed.findings[0]).toMatchObject({
      severity: 'high',
      title: 'Complete promoted claim',
      description: 'The later observation supplies the complete product claim.',
      targetIdentityHash: promotedSource.raw.targetIdentityHash,
      claimIdentityHash: promotedSource.raw.claimIdentityHash,
      semanticClaimIdentityHash: promotedSource.raw.semanticClaimIdentityHash,
      revision: 2,
    });
    expect(committed.findings[0]?.provisional).toBeUndefined();
    expect(committed.lifecycleEvents.at(-1)?.operation).toBe('promote_provisional');
  });

  it.each([
    {
      name: 'stale target precondition',
      fixture: () => promotionBoundaryFixture({ stalePrecondition: true }),
      error: /ineligible observed provisional transition source/,
    },
    {
      name: 'different target identity',
      fixture: () => promotionBoundaryFixture({
        transitionPath: 'src/different-target.ts',
      }),
      error: /ineligible observed provisional transition source/,
    },
    {
      name: 'inconsistent transition claim',
      fixture: () => promotionBoundaryFixture({
        inconsistentTransitionClaim: true,
      }),
      error: /inconsistent-transition-claim/,
    },
    {
      name: 'existing source claim conflict',
      fixture: () => promotionBoundaryFixture({
        initialSource: evidenceSource({
          rawFindingId: 'raw-formal-existing-claim',
          targetFindingId: null,
          title: 'Stored source claim',
          description: 'The stored source describes a different claim.',
          targetPath: 'src/formal-provisional.ts',
        }),
      }),
      error: /existing-source-claim-conflict/,
    },
    {
      name: 'product claim different from materialized evidence',
      fixture: () => promotionBoundaryFixture({
        productSource: evidenceSource({
          rawFindingId: 'raw-formal-product-rewrite',
          targetFindingId: 'F-0001',
          title: 'Rewritten product claim',
          description: 'The product projection does not match its transition raw.',
          relation: 'persists',
          targetPath: 'src/formal-provisional.ts',
        }),
      }),
      error: /product claim does not match materialized evidence/,
    },
  ])('rejects provisional promotion with $name', ({ fixture, error }) => {
    expect(fixture).toThrow(error);
  });

  it('rejects reuse of a provisional transition proof for another product claim', () => {
    const fixture = promotionBoundaryFixture();
    const reserved = reserveVerifiedLifecycleMutation(
      fixture.ledger,
      fixture.reservation,
    );

    expect(() => applyVerifiedLifecycleMutation(
      reserved,
      mutation({
        reservation: fixture.reservation,
        findings: [{
          ...fixture.product,
          title: 'A different product claim',
        }],
      }),
    )).toThrow(/proof does not match the product claim/);
  });

  it('rejects a product projection that drops the transition raw lineage', () => {
    const fixture = promotionBoundaryFixture();
    const reserved = reserveVerifiedLifecycleMutation(
      fixture.ledger,
      fixture.reservation,
    );

    expect(() => applyVerifiedLifecycleMutation(
      reserved,
      mutation({
        reservation: fixture.reservation,
        findings: [{
          ...fixture.product,
          rawFindingIds: fixture.ledger.findings[0]!.rawFindingIds,
        }],
      }),
    )).toThrow(/proof does not match the product raw lineage/);
  });

  it('materializes a dismissed provisional at the formal reopen boundary', () => {
    const fixture = promotionBoundaryFixture();
    const openProvisional = fixture.ledger.findings[0]!;
    const {
      revision: _openRevision,
      ...dismissedChange
    } = {
      ...openProvisional,
      status: 'dismissed' as const,
      lifecycle: 'dismissed' as const,
      revision: openProvisional.revision + 1,
      dismissal: {
        basis: 'unverifiable_claim' as const,
        reason: 'The incomplete claim was dismissed.',
        evidence: 'The claim contained no verifiable subject.',
        authority: 'standard' as const,
        decidedAt: { ...OBSERVATION },
      },
    };
    const dismissed = applyFindingLifecycleCommands({
      ledger: fixture.ledger,
      commands: [{
        operation: 'dismiss_finding',
        changes: {
          findings: [dismissedChange],
          conflicts: [],
        },
        authority: {
          kind: 'engine_policy',
          decisionKind: 'dismiss',
          decisionDigest: sha256('formal-reopen-dismiss'),
        },
        evidenceSourcesByTarget: new Map(),
      }],
      occurredAt: OBSERVATION,
    });
    const dismissedFinding = dismissed.findings[0]!;
    const reopenedDraft = evidenceSource({
      rawFindingId: 'raw-formal-reopen',
      targetFindingId: dismissedFinding.id,
      title: 'Complete reopened claim',
      description: 'The reopened observation supplies a complete product claim.',
      relation: 'reopened',
      targetPath: 'src/formal-provisional.ts',
    });
    const reopenedSource: EvidenceSource = {
      ...reopenedDraft,
      raw: {
        ...reopenedDraft.raw,
        targetPrecondition: captureFindingMutationPrecondition(
          dismissed,
          dismissedFinding.id,
        )!,
      },
    };
    const withReopenEvidence: FindingLedger = {
      ...dismissed,
      evidenceRecords: [...dismissed.evidenceRecords, reopenedSource.record],
      rawFindings: [...dismissed.rawFindings, reopenedSource.raw],
    };
    const reopenTarget = {
      entityKind: 'finding' as const,
      entityId: dismissedFinding.id,
      expectedHead: latestHead(dismissed, dismissedFinding.id),
    };
    const reopenedProduct: FindingLedgerEntry = {
      ...finding({
        id: dismissedFinding.id,
        source: reopenedSource,
        revision: dismissedFinding.revision + 1,
        lifecycle: 'reopened',
        evidenceIds: [
          ...dismissedFinding.evidenceIds,
          reopenedSource.record.evidenceId,
        ].sort(),
      }),
      rawFindingIds: [
        ...dismissedFinding.rawFindingIds,
        reopenedSource.raw.rawFindingId,
      ].sort(),
      reopenedEvidence: 'The complete claim was observed again.',
    };
    const proofedReopen = proofedProvisionalTransition({
      ledger: withReopenEvidence,
      operation: 'reopen_finding',
      target: reopenTarget,
      sources: [reopenedSource],
      product: reopenedProduct,
    });
    const committed = applyVerifiedLifecycleMutation(
      reserveVerifiedLifecycleMutation(
        proofedReopen.ledger,
        proofedReopen.reservation,
      ),
      mutation({
        reservation: proofedReopen.reservation,
        findings: [proofedReopen.product],
      }),
    );

    expect(committed.findings[0]).toMatchObject({
      status: 'open',
      lifecycle: 'reopened',
      title: 'Complete reopened claim',
    });
    expect(committed.findings[0]?.provisional).toBeUndefined();
  });

  it('rejects identity rewrites when reopening an ordinary product finding', () => {
    const source = evidenceSource({
      rawFindingId: 'raw-ordinary-product',
      targetFindingId: null,
      title: 'Ordinary product claim',
      description: 'The original product claim is complete.',
      targetPath: 'src/ordinary-product.ts',
    });
    const createTarget = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: null,
    };
    const createReservation = reservation({
      operation: 'create_finding',
      targets: [createTarget],
      sources: [source],
    });
    const open = applyVerifiedLifecycleMutation(
      reserveVerifiedLifecycleMutation(emptyLedger([source]), createReservation),
      mutation({
        reservation: createReservation,
        findings: [finding({
          id: createTarget.entityId,
          source,
          revision: 1,
        })],
      }),
    );
    const current = open.findings[0]!;
    const {
      revision: _revision,
      ...waivedProjection
    } = {
      ...current,
      status: 'waived' as const,
      lifecycle: 'waived' as const,
      revision: 2,
      waivers: [{
        reason: 'Prepare an ordinary reopen boundary.',
        evidence: 'Policy fixture.',
        decidedAt: { ...OBSERVATION },
      }],
    };
    const waived = applyFindingLifecycleCommands({
      ledger: open,
      commands: [{
        operation: 'waive_finding',
        changes: {
          findings: [waivedProjection],
          conflicts: [],
        },
        authority: {
          kind: 'engine_policy',
          decisionKind: 'waive',
          decisionDigest: sha256('ordinary-product-waive'),
        },
        evidenceSourcesByTarget: new Map(),
      }],
      occurredAt: OBSERVATION,
    });
    const rewriteSourceDraft = evidenceSource({
      rawFindingId: 'raw-ordinary-product-reopen',
      targetFindingId: current.id,
      title: 'Rewritten ordinary product claim',
      description: 'A reopen must not replace the product identity.',
      relation: 'reopened',
      targetPath: 'src/ordinary-product-rewrite.ts',
    });
    const waivedFinding = waived.findings[0]!;
    const rewriteSource: EvidenceSource = {
      ...rewriteSourceDraft,
      raw: {
        ...rewriteSourceDraft.raw,
        targetPrecondition: captureFindingMutationPrecondition(
          waived,
          waivedFinding.id,
        )!,
      },
    };
    const withReopenEvidence: FindingLedger = {
      ...waived,
      evidenceRecords: [...waived.evidenceRecords, rewriteSource.record],
      rawFindings: [...waived.rawFindings, rewriteSource.raw],
    };
    const reopenTarget = {
      entityKind: 'finding' as const,
      entityId: waivedFinding.id,
      expectedHead: latestHead(waived, waivedFinding.id),
    };
    const reopenReservation = reservation({
      operation: 'reopen_finding',
      targets: [reopenTarget],
      sources: [rewriteSource],
    });
    const rewritten: FindingLedgerEntry = {
      ...waivedFinding,
      status: 'open',
      lifecycle: 'reopened',
      revision: waivedFinding.revision + 1,
      target: rewriteSource.raw.target,
      targetIdentityHash: rewriteSource.raw.targetIdentityHash,
      claimIdentityHash: rewriteSource.raw.claimIdentityHash,
      semanticClaimIdentityHash: rewriteSource.raw.semanticClaimIdentityHash,
      severity: rewriteSource.raw.severity!,
      title: rewriteSource.raw.title!,
      description: rewriteSource.raw.description!,
      evidenceIds: [
        ...waivedFinding.evidenceIds,
        rewriteSource.record.evidenceId,
      ].sort(),
      rawFindingIds: [
        ...waivedFinding.rawFindingIds,
        rewriteSource.raw.rawFindingId,
      ].sort(),
      reopenedEvidence: 'The finding was observed again.',
    };
    const reserved = reserveVerifiedLifecycleMutation(
      withReopenEvidence,
      reopenReservation,
    );

    expect(() => applyVerifiedLifecycleMutation(
      reserved,
      mutation({
        reservation: reopenReservation,
        findings: [rewritten],
      }),
    )).toThrow(/rewrote immutable claim fields/);
  });

  it('retains manager proof evidence across update_provisional and promotion in one transaction', () => {
    // The transition raw is captured against the observed head. The proof also
    // binds the intermediate head produced by update_provisional.
    const fixture = promotionBoundaryFixture();
    const fixtureProofIds = new Set(fixture.ledger.evidenceRecords.flatMap((record) => (
      record.kind === 'engine_proof'
      && record.subject.kind === 'finding_provisional_product_transition'
        ? [record.evidenceId]
        : []
    )));
    const baseLedger: FindingLedger = {
      ...fixture.ledger,
      evidenceRecords: fixture.ledger.evidenceRecords.filter(
        (record) => !fixtureProofIds.has(record.evidenceId),
      ),
      findings: fixture.ledger.findings.map((finding) => ({
        ...finding,
        evidenceIds: finding.evidenceIds.filter(
          (evidenceId) => !fixtureProofIds.has(evidenceId),
        ),
      })),
    };
    const before = baseLedger.findings[0]!;
    const intermediate: FindingLedgerEntry = {
      ...before,
      revision: before.revision + 1,
    };
    const finalProduct: FindingLedgerEntry = {
      ...fixture.product,
      evidenceIds: fixture.product.evidenceIds.filter(
        (evidenceId) => !fixtureProofIds.has(evidenceId),
      ),
      revision: intermediate.revision + 1,
    };
    const {
      revision: _intermediateRevision,
      ...intermediateChange
    } = intermediate;
    const {
      revision: _productRevision,
      ...productChange
    } = finalProduct;
    const managerDecisionCommands = [{
      operation: 'update_provisional' as const,
      changes: {
        findings: [intermediateChange],
        conflicts: [],
      },
      authority: { kind: 'verified_evidence' as const },
      evidenceSourcesByTarget: new Map(),
    }];
    const managerDecisionProposed: FindingLedger = {
      ...baseLedger,
      findings: [intermediate],
    };
    const finalProposed: FindingLedger = {
      ...baseLedger,
      findings: [finalProduct],
    };
    const settlementCommands = [{
      operation: 'promote_provisional' as const,
      changes: {
        findings: [productChange],
        conflicts: [],
      },
      authority: { kind: 'verified_evidence' as const },
      evidenceSourcesByTarget: new Map([[
        `finding\0${before.id}`,
        {
          sourceRawFindingIds: [fixture.transitionSource.raw.rawFindingId],
          authorityEvidenceIds: [],
        },
      ]]),
    }];
    const managerOutput = emptyManagerOutput();
    const proofed = issueManagerLifecycleAuthority({
      current: baseLedger,
      rawRecoveryCurrent: baseLedger,
      rawRecoveryManagerDecisionProposed: baseLedger,
      rawRecoveryManagerDecisionCommands: [],
      rawRecoverySettlementCommands: [],
      managerDecisionProposed,
      proposed: finalProposed,
      managerDecisionCommands,
      settlementCommands,
      managerOutput,
      cwd: process.cwd(),
      workflowName: baseLedger.workflowName,
      runId: OBSERVATION.runId,
      scopeIdentity: 'same-transaction-promotion-proof',
      reviewScopeSnapshotId: sha256('same-transaction-promotion-snapshot'),
      observation: OBSERVATION,
    });
    const proofIds = proofed.provisionalProofIdsByFinding.get(before.id) ?? [];
    const proofedManagerDecisionProposed: FindingLedger = {
      ...managerDecisionProposed,
      evidenceRecords: proofed.ledger.evidenceRecords,
      findings: [{
        ...intermediate,
        evidenceIds: [...new Set([
          ...intermediate.evidenceIds,
          ...proofIds,
        ])].sort(),
      }],
    };
    const committed = assembleAndApplyManagerLifecycleTransactions({
      current: baseLedger,
      managerDecisionProposed: proofedManagerDecisionProposed,
      managerDecisionCommands,
      proposed: proofed.ledger,
      managerOutput,
      provisionalProofIdsByFinding: proofed.provisionalProofIdsByFinding,
      rawRecoveryProvisionalProofIdsByFinding:
        proofed.rawRecoveryProvisionalProofIdsByFinding,
      invalidationProofIdsByFinding: proofed.invalidationProofIdsByFinding,
      duplicateProofIdsByCommandKey: proofed.duplicateProofIdsByCommandKey,
      managerDecisionProvisionalTransitionProofIdsByCommandKey:
        proofed.managerDecisionProvisionalTransitionProofIdsByCommandKey,
      provisionalTransitionProofIdsByCommandKey:
        proofed.provisionalTransitionProofIdsByCommandKey,
      rawRecoveryProvisionalTransitionProofIdsByCommandKey:
        proofed.rawRecoveryProvisionalTransitionProofIdsByCommandKey,
      rawRecoveryManagerDecisionProvisionalTransitionProofIdsByCommandKey:
        proofed.rawRecoveryManagerDecisionProvisionalTransitionProofIdsByCommandKey,
      invalidationReasonsByFinding: proofed.invalidationReasonsByFinding,
      resolutionRenotifications: [],
      settlementCommands,
      actionRecoveryPlan: null,
      occurredAt: OBSERVATION,
    });

    expect(proofIds).toHaveLength(1);
    expect(proofed.provisionalTransitionProofIdsByCommandKey.size).toBe(1);
    expect(committed.findings[0]?.provisional).toBeUndefined();
    expect(committed.findings[0]?.evidenceIds).toEqual(
      expect.arrayContaining(proofIds),
    );
    expect(committed.lifecycleEvents.slice(-2).map((event) => event.operation))
      .toEqual(['update_provisional', 'promote_provisional']);
  });

  it('rejects lifecycle transaction projection deletion and orphan lifecycle heads', () => {
    const source = evidenceSource({
      rawFindingId: 'raw-delete-rejection',
      targetFindingId: null,
      title: 'Deletion must be explicit',
      description: 'Lifecycle projections cannot disappear without an event.',
    });
    const target = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: null,
    };
    const createReservation = reservation({
      operation: 'create_finding',
      targets: [target],
      sources: [source],
    });
    const current = applyVerifiedLifecycleMutation(
      reserveVerifiedLifecycleMutation(emptyLedger([source]), createReservation),
      mutation({
        reservation: createReservation,
        findings: [finding({ id: target.entityId, source, revision: 1 })],
      }),
    );

    expect(() => mergeFindingLifecycleCommandState(
      current,
      { ...current, findings: [] },
    )).toThrow(/cannot delete finding projection "F-0001"/);
    expect(() => assertFindingLifecycleAuthorityInvariant({
      ...current,
      findings: [],
    })).toThrow(/has no current entity projection/);
  });

  it('revalidates every reserved target before applying a partial multi-target result', () => {
    const sourceA = evidenceSource({
      rawFindingId: 'raw-create-a',
      targetFindingId: null,
      title: 'Finding A',
      description: 'The first reserved finding.',
    });
    const sourceB = evidenceSource({
      rawFindingId: 'raw-create-b',
      targetFindingId: null,
      title: 'Finding B',
      description: 'The second reserved finding.',
    });
    const createReservationA = reservation({
      operation: 'create_finding',
      targets: [{
        entityKind: 'finding',
        entityId: 'F-0001',
        expectedHead: null,
      }],
      sources: [sourceA],
    });
    const createdA = applyVerifiedLifecycleMutation(
      reserveVerifiedLifecycleMutation(
        emptyLedger([sourceA, sourceB]),
        createReservationA,
      ),
      mutation({
        reservation: createReservationA,
        findings: [finding({ id: 'F-0001', source: sourceA, revision: 1 })],
      }),
    );
    const createReservationB = reservation({
      operation: 'create_finding',
      targets: [{
        entityKind: 'finding',
        entityId: 'F-0002',
        expectedHead: null,
      }],
      sources: [sourceB],
    });
    const created = applyVerifiedLifecycleMutation(
      reserveVerifiedLifecycleMutation(createdA, createReservationB),
      mutation({
        reservation: createReservationB,
        findings: [finding({ id: 'F-0002', source: sourceB, revision: 1 })],
      }),
    );
    const supersedeReservation: VerifiedLifecycleReservation = {
      reservation: createFindingLifecycleReservation({
        operation: 'supersede_findings',
        targets: [
          {
            entityKind: 'finding',
            entityId: 'F-0001',
            expectedHead: latestHead(created, 'F-0001'),
          },
          {
            entityKind: 'finding',
            entityId: 'F-0002',
            expectedHead: latestHead(created, 'F-0002'),
          },
        ],
        evidenceBindingIds: [],
        authority: {
          kind: 'engine_policy',
          decisionKind: 'semantic_duplicate',
          decisionDigest: sha256('supersede-a-b'),
        },
        context: { kind: 'transaction' },
        reservedAt: OBSERVATION,
      }),
      evidenceBindings: [],
    };
    const pending = reserveVerifiedLifecycleMutation(created, supersedeReservation);
    const waiverReservation: VerifiedLifecycleReservation = {
      reservation: createFindingLifecycleReservation({
        operation: 'waive_finding',
        targets: [{
          entityKind: 'finding',
          entityId: 'F-0001',
          expectedHead: latestHead(created, 'F-0001'),
        }],
        evidenceBindingIds: [],
        authority: {
          kind: 'engine_policy',
          decisionKind: 'waive',
          decisionDigest: sha256('waive-a-before-persist'),
        },
        context: { kind: 'transaction' },
        reservedAt: OBSERVATION,
      }),
      evidenceBindings: [],
    };
    const withWaiverReservation = reserveVerifiedLifecycleMutation(
      pending,
      waiverReservation,
    );
    const findingA = withWaiverReservation.findings.find(
      (candidate) => candidate.id === 'F-0001',
    )!;
    const findingB = withWaiverReservation.findings.find(
      (candidate) => candidate.id === 'F-0002',
    )!;
    const changedA = applyVerifiedLifecycleMutation(
      withWaiverReservation,
      mutation({
        reservation: waiverReservation,
        findings: [{
          ...findingA,
          status: 'waived',
          lifecycle: 'waived',
          revision: 2,
          waivers: [{
            reason: 'Accepted for the CAS regression.',
            evidence: 'Policy decision.',
            decidedAt: OBSERVATION,
          }],
        }],
      }),
    );

    expect(() => applyVerifiedLifecycleMutation(
      changedA,
      mutation({
        reservation: supersedeReservation,
        findings: [{
          ...findingB,
          status: 'superseded',
          lifecycle: 'superseded',
          revision: 2,
          supersededByFindingId: 'F-0001',
        }],
      }),
    )).toThrow(/stale full head for "F-0001"/);
  });

  it('rejects a generic structural proof reused for an unrelated lifecycle operation', () => {
    const unrelatedTarget = {
      kind: 'code' as const,
      paths: ['src/unrelated-create.ts'],
    };
    const claimIdentityHash = computeClaimIdentityHash({
      target: unrelatedTarget,
      familyTag: 'bug',
      severity: 'high',
      title: 'Unrelated create',
      description: 'A provisional isolation proof cannot authorize creation.',
      suggestion: null,
    });
    const proof = createEngineProofRecord({
      kind: 'engine_proof',
      verifierId: 'takt.finding-lifecycle-policy',
      verifierVersion: '1',
      workflowName: 'default',
      runId: OBSERVATION.runId,
      scopeIdentity: 'lifecycle-test-scope',
      snapshotId: sha256('generic-proof-snapshot'),
      purpose: 'lifecycle_authority',
      claimIdentityHash,
      targetFindingId: null,
      subject: {
        kind: 'finding_provisional_isolation',
        findingId: 'F-unrelated',
        provisionalKind: 'interpretation-interrupted',
        stableKey: 'unrelated',
      },
      dependencyDigests: [sha256('generic-proof-dependency')],
      resultDigest: sha256('generic-proof-result'),
      issuedAt: OBSERVATION.timestamp,
    });
    const target = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: null,
    };
    const binding = createFindingEvidenceBinding({
      evidenceId: proof.evidenceId,
      claimIdentityHash,
      sourceRawFindingId: null,
      sourceRawIntegrityDigest: null,
      operation: 'create_finding',
      target,
    });
    const proofReservation = createFindingLifecycleReservation({
      operation: 'create_finding',
      targets: [target],
      evidenceBindingIds: [binding.bindingId],
      authority: { kind: 'verified_evidence' },
      context: { kind: 'transaction' },
      reservedAt: OBSERVATION,
    });

    expect(() => reserveVerifiedLifecycleMutation({
      ...emptyLedger([]),
      evidenceRecords: [proof],
    }, {
      reservation: proofReservation,
      evidenceBindings: [binding],
    })).toThrow(/is not eligible for lifecycle operation "create_finding"/);
  });

  it('rejects a resolution renotification without its exact finding-conflict pair', () => {
    const invalidReservation = createFindingLifecycleReservation({
      operation: 'apply_resolution_renotification',
      targets: [{
        entityKind: 'finding',
        entityId: 'F-0001',
        expectedHead: null,
      }],
      evidenceBindingIds: [],
      authority: { kind: 'verified_evidence' },
      context: { kind: 'transaction' },
      reservedAt: OBSERVATION,
    });

    expect(() => reserveVerifiedLifecycleMutation(emptyLedger([]), {
      reservation: invalidReservation,
      evidenceBindings: [],
    })).toThrow(/requires exactly one finding and one conflict target/);
  });

  it('rejects an engine policy projection delta that changes an unrelated title', () => {
    const source = evidenceSource({
      rawFindingId: 'raw-policy-title',
      targetFindingId: null,
      title: 'Original policy target',
      description: 'Policy authority must not rewrite this claim.',
    });
    const createReservation = reservation({
      operation: 'create_finding',
      targets: [{
        entityKind: 'finding',
        entityId: 'F-0001',
        expectedHead: null,
      }],
      sources: [source],
    });
    const created = applyVerifiedLifecycleMutation(
      reserveVerifiedLifecycleMutation(emptyLedger([source]), createReservation),
      mutation({
        reservation: createReservation,
        findings: [finding({ id: 'F-0001', source, revision: 1 })],
      }),
    );
    const waiverReservation: VerifiedLifecycleReservation = {
      reservation: createFindingLifecycleReservation({
        operation: 'waive_finding',
        targets: [{
          entityKind: 'finding',
          entityId: 'F-0001',
          expectedHead: latestHead(created, 'F-0001'),
        }],
        evidenceBindingIds: [],
        authority: {
          kind: 'engine_policy',
          decisionKind: 'waive',
          decisionDigest: sha256('policy-title-change'),
        },
        context: { kind: 'transaction' },
        reservedAt: OBSERVATION,
      }),
      evidenceBindings: [],
    };
    const pending = reserveVerifiedLifecycleMutation(created, waiverReservation);

    expect(() => applyVerifiedLifecycleMutation(pending, mutation({
      reservation: waiverReservation,
      findings: [{
        ...pending.findings[0]!,
        title: 'Policy-rewritten title',
        status: 'waived',
        lifecycle: 'waived',
        revision: 2,
        waivers: [{
          reason: 'Accepted risk.',
          evidence: 'Policy decision.',
          decidedAt: { ...OBSERVATION },
        }],
        lastSeen: { ...OBSERVATION },
      }],
    }))).toThrow(/changed forbidden projection fields.*title/);
  });

  it('detaches repeated observation references at the lifecycle transaction projection boundary', () => {
    const source = evidenceSource({
      rawFindingId: 'raw-shared-reference',
      targetFindingId: null,
      title: 'Shared reference finding',
      description: 'The proposal intentionally reuses one observation object.',
    });
    const target = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: null,
    };
    const createReservation = reservation({
      operation: 'create_finding',
      targets: [target],
      sources: [source],
    });
    const current = applyVerifiedLifecycleMutation(
      reserveVerifiedLifecycleMutation(emptyLedger([source]), createReservation),
      mutation({
        reservation: createReservation,
        findings: [finding({ id: target.entityId, source, revision: 1 })],
      }),
    );
    const sharedObservation = { ...OBSERVATION };
    const proposedFinding: FindingLedgerEntry = {
      ...current.findings[0]!,
      status: 'waived',
      lifecycle: 'waived',
      revision: 2,
      firstSeen: sharedObservation,
      lastSeen: sharedObservation,
      waivers: [{
        reason: 'Accepted operational risk.',
        evidence: 'Policy decision.',
        decidedAt: sharedObservation,
      }],
    };

    const { revision: _revision, ...findingChange } = proposedFinding;
    const next = applyFindingLifecycleCommands({
      ledger: current,
      commands: [{
        operation: 'waive_finding',
        changes: {
          findings: [findingChange],
          conflicts: [],
        },
        authority: {
          kind: 'engine_policy',
          decisionKind: 'waive',
          decisionDigest: sha256('waive-shared-reference'),
        },
        evidenceSourcesByTarget: new Map(),
      }],
      occurredAt: OBSERVATION,
    });

    const persisted = next.findings[0]!;
    expect(persisted.status).toBe('waived');
    expect(persisted.firstSeen).not.toBe(sharedObservation);
    expect(persisted.firstSeen).not.toBe(persisted.lastSeen);
    expect(persisted.lastSeen).not.toBe(persisted.waivers?.[0]?.decidedAt);
  });

  it('accepts only the closed conflict adjudication outcome contract', () => {
    expect(parseFindingConflictAdjudicationOutput({
      conflictId: 'C-123',
      outcome: 'finding_valid',
      actionableFix: 'Guard the nullable branch.',
      rationale: 'The bound inputs still demonstrate the defect.',
    })).toEqual({
      conflictId: 'C-123',
      outcome: 'finding_valid',
      actionableFix: 'Guard the nullable branch.',
      rationale: 'The bound inputs still demonstrate the defect.',
    });
    expect(() => parseFindingConflictAdjudicationOutput({
      conflictId: 'C-123',
      outcome: 'finding_stale',
      findingTransition: 'resolved',
      evidence: ['src/a.ts:5'],
    })).toThrow();
  });

  it.each([
    ['finding_stale', undefined, 2, 'resolved'],
    ['evidence_invalid', undefined, 2, 'invalidated'],
    ['finding_valid', 'Apply the concrete fix.', 2, 'open'],
    ['finding_valid', undefined, 0, 'open'],
    ['undetermined', undefined, 0, 'open'],
  ] as const)(
    'enforces the adjudication outcome mapping for %s',
    (outcome, actionableFix, expectedFindingTransitions, expectedStatus) => {
      const current = adjudicationLedger();
      const conflict = current.conflicts[0]!;
      const reserved = reserveFindingConflictAdjudicationLifecycle({
        ledger: current,
        conflictId: conflict.id,
        evidenceHash: sha256(`adjudication:${outcome}:${actionableFix ?? ''}`),
        originStep: 'reviewers',
        reservedAt: OBSERVATION,
      });
      const applied = applyFindingConflictAdjudication({
        ledger: reserved.ledger,
        output: {
          conflictId: conflict.id,
          outcome,
          ...(actionableFix === undefined ? {} : { actionableFix }),
        },
        evidenceHash: reserved.ledger.lifecycleReservations.at(-1)!.context.kind
          === 'conflict_adjudication'
          ? reserved.ledger.lifecycleReservations.at(-1)!.context.evidenceHash
          : '',
        cwd: process.cwd(),
        context: {
          workflowName: current.workflowName,
          ...OBSERVATION,
        },
      });
      const changedFindings = applied.ledger.findings.filter((finding) => (
        finding.revision
          !== reserved.ledger.findings.find((candidate) => candidate.id === finding.id)!.revision
      ));
      const changedConflict = applied.ledger.conflicts.find(
        (candidate) => candidate.id === conflict.id,
      )!;
      const result = applyVerifiedLifecycleMutation(reserved.ledger, {
        mutationId: reserved.mutationId,
        findings: changedFindings,
        conflicts: [changedConflict],
        occurredAt: OBSERVATION,
      });

      expect(changedFindings).toHaveLength(expectedFindingTransitions);
      expect(result.findings.map((finding) => finding.status))
        .toEqual([expectedStatus, expectedStatus]);
      expect(result.lifecycleEvents.at(-1)?.transitions).toHaveLength(
        expectedFindingTransitions + 1,
      );
    },
  );

  it('applies reopened + conflict through production assembly', () => {
    let current = adjudicationLedger();
    const resolutionSource = evidenceSource({
      rawFindingId: 'raw-semantic-resolution',
      targetFindingId: 'F-0001',
      title: 'Finding A was resolved',
      description: 'The original finding was fixed.',
      relation: 'resolution_confirmation',
    });
    const before = current.findings.find((finding) => finding.id === 'F-0001')!;
    current = applyFindingLifecycleCommands({
      ledger: {
        ...current,
        rawFindings: [...current.rawFindings, resolutionSource.raw],
        evidenceRecords: [...current.evidenceRecords, resolutionSource.record],
      },
      commands: [{
        operation: 'resolve_finding',
        changes: {
          findings: [{
            ...before,
            status: 'resolved',
            lifecycle: 'resolved',
            rawFindingIds: [...before.rawFindingIds, resolutionSource.raw.rawFindingId].sort(),
            evidenceIds: [...before.evidenceIds, resolutionSource.record.evidenceId].sort(),
            resolvedAt: OBSERVATION.timestamp,
            resolvedEvidence: 'Verified resolution.',
          }],
          conflicts: [],
        },
        authority: { kind: 'verified_evidence' },
        evidenceSourcesByTarget: new Map([[
          'finding\0F-0001',
          {
            sourceRawFindingIds: [resolutionSource.raw.rawFindingId],
            authorityEvidenceIds: [],
          },
        ]]),
      }],
      occurredAt: OBSERVATION,
    });
    const reopenedSource = evidenceSource({
      rawFindingId: 'raw-semantic-reopened',
      targetFindingId: 'F-0001',
      title: 'Finding A recurred',
      description: 'The resolved issue is observable again.',
      relation: 'reopened',
    });
    const conflictSource = evidenceSource({
      rawFindingId: 'raw-semantic-reopened-conflict',
      targetFindingId: 'F-0001',
      title: 'Reopened conflict',
      description: 'The reopened finding has conflicting evidence.',
      relation: 'persists',
    });
    const managerOutput: FindingManagerOutput = {
      anchorAdjudications: [],
      matches: [],
      newFindings: [],
      resolvedFindings: [],
      reopenedFindings: [{
        findingId: 'F-0001',
        rawFindingIds: [reopenedSource.raw.rawFindingId],
        evidence: 'The defect recurred.',
      }],
      conflicts: [{
        findingIds: ['F-0001'],
        rawFindingIds: [conflictSource.raw.rawFindingId],
        description: 'The reopened claim remains disputed.',
      }],
      resolvedConflicts: [],
      waivedFindings: [],
      disputeNotes: [],
      invalidatedFindings: [],
      duplicateFindings: [],
      dismissedFindings: [],
    };
    const plan = semanticManagerPlan({
      current,
      sources: [reopenedSource, conflictSource],
      managerOutput,
    });
    const applied = applySemanticManagerPlan({ current, plan, managerOutput });

    expect(applied.lifecycleEvents.slice(current.lifecycleEvents.length).map(
      (event) => event.operation,
    )).toEqual(['reopen_finding', 'create_conflict']);
  });

  it('rejects missing, extra, and revision-only adjudication finding deltas', () => {
    const current = adjudicationLedger();
    const conflict = current.conflicts[0]!;
    const evidenceHash = sha256('adjudication-invalid-deltas');
    const reserved = reserveFindingConflictAdjudicationLifecycle({
      ledger: current,
      conflictId: conflict.id,
      evidenceHash,
      originStep: 'reviewers',
      reservedAt: OBSERVATION,
    });
    const applied = applyFindingConflictAdjudication({
      ledger: reserved.ledger,
      output: { conflictId: conflict.id, outcome: 'finding_stale' },
      evidenceHash,
      cwd: process.cwd(),
      context: {
        workflowName: current.workflowName,
        ...OBSERVATION,
      },
    });
    const changedConflict = applied.ledger.conflicts[0]!;
    const changedFindings = applied.ledger.findings;

    expect(() => applyVerifiedLifecycleMutation(reserved.ledger, {
      mutationId: reserved.mutationId,
      findings: changedFindings.slice(0, 1),
      conflicts: [changedConflict],
      occurredAt: OBSERVATION,
    })).toThrow(/finding transitions do not match its outcome/);

    expect(() => applyVerifiedLifecycleMutation(reserved.ledger, {
      mutationId: reserved.mutationId,
      findings: [
        ...changedFindings,
        { ...changedFindings[0]!, id: 'F-9999' },
      ],
      conflicts: [changedConflict],
      occurredAt: OBSERVATION,
    })).toThrow(/outside its reservation/);

    expect(() => applyVerifiedLifecycleMutation(reserved.ledger, {
      mutationId: reserved.mutationId,
      findings: reserved.ledger.findings.map((finding) => ({
        ...finding,
        revision: finding.revision + 1,
      })),
      conflicts: [changedConflict],
      occurredAt: OBSERVATION,
    })).toThrow(/revision-only finding transition/);

    expect(() => applyVerifiedLifecycleMutation(reserved.ledger, {
      mutationId: reserved.mutationId,
      findings: changedFindings.map((finding, index) => (
        index === 0 ? { ...finding, suggestion: 'Unrelated mutation.' } : finding
      )),
      conflicts: [changedConflict],
      occurredAt: OBSERVATION,
    })).toThrow(/invalid finding delta/);
  });

  it.each([
    ['match + dispute', true, false, true],
    ['match + conflict', true, true, false],
    ['match + conflict + dispute', true, true, true],
  ] as const)(
    'applies %s as ordered semantic commands through production assembly',
    (_label, includeMatch, includeConflict, includeDispute) => {
      const current = adjudicationLedger();
      const matchSource = evidenceSource({
        rawFindingId: `raw-semantic-match-${includeConflict}-${includeDispute}`,
        targetFindingId: 'F-0001',
        title: 'Finding A persists',
        description: 'The first finding remains observable.',
        relation: 'persists',
      });
      const conflictSource = evidenceSource({
        rawFindingId: `raw-semantic-conflict-${includeDispute}`,
        targetFindingId: 'F-0001',
        title: 'Conflicting manager observation',
        description: 'A separate observation conflicts with F-0001.',
        relation: 'persists',
      });
      const sources = [
        ...(includeMatch ? [matchSource] : []),
        ...(includeConflict ? [conflictSource] : []),
      ];
      const managerOutput: FindingManagerOutput = {
        matches: includeMatch
          ? [{ findingId: 'F-0001', rawFindingIds: [matchSource.raw.rawFindingId] }]
          : [],
        newFindings: [],
        resolvedFindings: [],
        reopenedFindings: [],
        conflicts: includeConflict
          ? [{
              findingIds: ['F-0001'],
              rawFindingIds: [conflictSource.raw.rawFindingId],
              description: 'The manager retained both incompatible claims.',
            }]
          : [],
        resolvedConflicts: [],
        waivedFindings: [],
        disputeNotes: includeDispute
          ? [{
              findingId: 'F-0001',
              reason: 'The proposed dispute was rejected.',
              evidence: 'The persisted observation remains authoritative.',
            }]
          : [],
        invalidatedFindings: [],
        duplicateFindings: [],
        dismissedFindings: [],
      };
      const plan = semanticManagerPlan({ current, sources, managerOutput });
      const applied = applySemanticManagerPlan({ current, plan, managerOutput });
      const operations = applied.lifecycleEvents
        .slice(current.lifecycleEvents.length)
        .map((event) => event.operation);

      expect(operations).toEqual([
        ...(includeMatch ? ['persist_finding' as const] : []),
        ...(includeDispute ? ['record_dispute' as const] : []),
        ...(includeConflict ? ['create_conflict' as const] : []),
      ]);
      expect(applied.findings.find((finding) => finding.id === 'F-0001')?.disputes ?? [])
        .toHaveLength(includeDispute ? 1 : 0);
    },
  );

  it.each([
    ['canonical + match', 'match'],
    ['canonical + conflict', 'conflict'],
    ['canonical + canonical', 'canonical'],
  ] as const)(
    'applies %s without final-projection operation preemption',
    (_label, overlay) => {
      let current = adjudicationLedger();
      if (overlay === 'canonical') {
        const thirdSource = evidenceSource({
          rawFindingId: 'raw-semantic-third',
          targetFindingId: null,
          title: 'Finding C',
          description: 'Third duplicate candidate.',
        });
        const created = finding({ id: 'F-0003', source: thirdSource, revision: 1 });
        const { revision: _revision, ...projection } = created;
        current = applyFindingLifecycleCommands({
          ledger: {
            ...current,
            rawFindings: [...current.rawFindings, thirdSource.raw],
            evidenceRecords: [...current.evidenceRecords, thirdSource.record],
          },
          commands: [{
            operation: 'create_finding',
            changes: { findings: [projection], conflicts: [] },
            authority: { kind: 'verified_evidence' },
            evidenceSourcesByTarget: new Map([[
              'finding\0F-0003',
              {
                sourceRawFindingIds: [thirdSource.raw.rawFindingId],
                authorityEvidenceIds: [],
              },
            ]]),
          }],
          occurredAt: OBSERVATION,
        });
      }
      const overlaySource = evidenceSource({
        rawFindingId: `raw-semantic-${overlay}`,
        targetFindingId: 'F-0001',
        title: `Canonical ${overlay} observation`,
        description: `Canonical overlay for ${overlay}.`,
        relation: 'persists',
      });
      const sources = overlay === 'canonical' ? [] : [overlaySource];
      const managerOutput: FindingManagerOutput = {
        matches: overlay === 'match'
          ? [{ findingId: 'F-0001', rawFindingIds: [overlaySource.raw.rawFindingId] }]
          : [],
        newFindings: [],
        resolvedFindings: [],
        reopenedFindings: [],
        conflicts: overlay === 'conflict'
          ? [{
              findingIds: ['F-0001'],
              rawFindingIds: [overlaySource.raw.rawFindingId],
              description: 'Canonical finding also participates in a conflict.',
            }]
          : [],
        resolvedConflicts: [],
        waivedFindings: [],
        disputeNotes: [],
        invalidatedFindings: [],
        duplicateFindings: [
          { canonicalFindingId: 'F-0001', duplicateFindingIds: ['F-0002'] },
          ...(overlay === 'canonical'
            ? [{ canonicalFindingId: 'F-0001', duplicateFindingIds: ['F-0003'] }]
            : []),
        ],
        dismissedFindings: [],
      };
      const plan = semanticManagerPlan({ current, sources, managerOutput });
      const applied = applySemanticManagerPlan({ current, plan, managerOutput });
      const operations = applied.lifecycleEvents
        .slice(current.lifecycleEvents.length)
        .map((event) => event.operation);

      expect(operations.filter((operation) => operation === 'supersede_findings'))
        .toHaveLength(overlay === 'canonical' ? 2 : 1);
      expect(applied.findings.find((finding) => finding.id === 'F-0001')?.status)
        .toBe('open');
    },
  );

  it.each([
    ['canonical + canonical', false],
    ['canonical + match', true],
  ] as const)(
    'binds duplicate engine proofs to each exact command in %s production flow',
    (_label, includeMatch) => {
      const current = semanticDuplicateLedger(includeMatch ? 2 : 3);
      const matchSource = evidenceSource({
        rawFindingId: 'raw-semantic-proofed-match',
        targetFindingId: 'F-0001',
        title: 'Same duplicate claim',
        description: 'Every candidate has the same claim identity.',
        relation: 'persists',
        targetPath: 'src/shared-semantic-duplicate.ts',
      });
      const managerOutput: FindingManagerOutput = {
        matches: includeMatch
          ? [{ findingId: 'F-0001', rawFindingIds: [matchSource.raw.rawFindingId] }]
          : [],
        newFindings: [],
        resolvedFindings: [],
        reopenedFindings: [],
        conflicts: [],
        resolvedConflicts: [],
        waivedFindings: [],
        disputeNotes: [],
        invalidatedFindings: [],
        duplicateFindings: [
          { canonicalFindingId: 'F-0001', duplicateFindingIds: ['F-0002'] },
          ...(!includeMatch
            ? [{ canonicalFindingId: 'F-0001', duplicateFindingIds: ['F-0003'] }]
            : []),
        ],
        dismissedFindings: [],
      };
      const plan = semanticManagerPlan({
        current,
        sources: includeMatch ? [matchSource] : [],
        managerOutput,
      });
      const applied = applyProofedSemanticManagerPlan({ current, plan, managerOutput });
      const events = applied.lifecycleEvents.slice(current.lifecycleEvents.length);

      expect(events.map((event) => event.operation)).toEqual(
        includeMatch
          ? ['persist_finding', 'supersede_findings']
          : ['supersede_findings', 'supersede_findings'],
      );
      const supersedeEvents = events.filter(
        (event) => event.operation === 'supersede_findings',
      );
      const expectedTargetSets = includeMatch
        ? [['F-0001', 'F-0002']]
        : [['F-0001', 'F-0002'], ['F-0001', 'F-0003']];
      supersedeEvents.forEach((event, index) => {
        const proofSubjects = event.evidenceBindingIds.flatMap((bindingId) => {
          const binding = applied.evidenceBindings.find(
            (candidate) => candidate.bindingId === bindingId,
          )!;
          const record = applied.evidenceRecords.find(
            (candidate) => candidate.evidenceId === binding.evidenceId,
          )!;
          return record.kind === 'engine_proof'
            && record.subject.kind === 'finding_claim_sets_equal'
            ? [record.subject.findingIds]
            : [];
        });
        expect(proofSubjects).toHaveLength(2);
        expect(proofSubjects).toEqual([
          expectedTargetSets[index],
          expectedTargetSets[index],
        ]);
        expect(event.transitions.map((transition) => transition.after.entityId))
          .toEqual(expectedTargetSets[index]);
      });
      if (includeMatch) {
        const persistEvent = events[0]!;
        expect(persistEvent.evidenceBindingIds.some((bindingId) => {
          const binding = applied.evidenceBindings.find(
            (candidate) => candidate.bindingId === bindingId,
          )!;
          return applied.evidenceRecords.some((record) => (
            record.evidenceId === binding.evidenceId && record.kind === 'engine_proof'
          ));
        })).toBe(false);
      }
    },
  );

  it('records interpretation recovery failures in the WAL without mutating findings', () => {
    const baseInterpretationKey = sha256('interpretation-base');
    const firstFailure = {
      interpretationKey: sha256('interpretation-attempt-1'),
      baseInterpretationKey,
      attemptOrdinal: 1,
      reviewerStableKey: 'reviewer',
      lineageKey: 'lineage',
      candidateEvidenceHash: sha256('candidate'),
      canonicalIntegrityDigest: sha256('canonical'),
      startedAt: { ...OBSERVATION },
      promptPreconditions: [],
      stage: 'interpretation_retryable_failure' as const,
      failedAt: { ...OBSERVATION },
      failureCode: 'source_missing' as const,
      failureReason: 'The source was unavailable.',
      sourceRawFindingId: 'missing-raw',
      provisionalFindingId: 'F-0001',
    };
    const ledger = {
      ...emptyLedger([]),
      interpretations: [firstFailure],
    };
    const next = applyInterpretationRecoveryFailures({
      ledger,
      failures: [{
        kind: 'recovery_contract_mismatch',
        outcome: 'audit_only',
        recoveryOrigin: {
          provisionalFindingId: 'F-0001',
          expectedProvisionalRevision: 1,
          expectedProvisionalStableKey: 'stable',
          expectedProvisionalLineageKey: 'lineage',
          expectedRecoveryReviewerStableKey: 'reviewer',
        },
        sourceRawFindingId: 'missing-raw',
        reason: 'The recovered payload no longer matches its contract.',
      }],
      observation: { ...OBSERVATION, timestamp: '2026-07-29T00:01:00.000Z' },
    });

    expect(next.findings).toBe(ledger.findings);
    expect(next.interpretations).toHaveLength(2);
    expect(next.interpretations[1]).toMatchObject({
      attemptOrdinal: 2,
      stage: 'interpretation_terminal_failure',
      failureCode: 'recovery_contract_mismatch',
    });
    expect(() => FindingInterpretationRecordSchema.parse(next.interpretations[1])).not.toThrow();
  });

  it('persists a pending reservation before applying its decision exactly once', () => {
    const source = evidenceSource({
      rawFindingId: 'raw-create',
      targetFindingId: null,
      title: 'Created finding',
      description: 'Verified create claim.',
    });
    const target = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: null,
    };
    const reservedInput = reservation({
      operation: 'create_finding',
      targets: [target],
      sources: [source],
    });
    const base = emptyLedger([source]);
    const pending = reserveVerifiedLifecycleMutation(base, reservedInput);

    expect(pending.findings).toEqual([]);
    expect(pending.lifecycleReservations).toHaveLength(1);
    expect(pending.lifecycleEvents).toEqual([]);
    expect(reserveVerifiedLifecycleMutation(pending, {
      ...reservedInput,
      reservation: createFindingLifecycleReservation({
        operation: 'create_finding',
        targets: [target],
        evidenceBindingIds: reservedInput.reservation.evidenceBindingIds,
        authority: { kind: 'verified_evidence' },
        context: { kind: 'transaction' },
        reservedAt: { ...OBSERVATION, timestamp: '2026-07-29T00:01:00.000Z' },
      }),
    })).toBe(pending);

    const result = mutation({
      reservation: reservedInput,
      findings: [finding({
        id: target.entityId,
        source,
        revision: 1,
      })],
    });
    const applied = applyVerifiedLifecycleMutation(pending, result);

    expect(applied.lifecycleReservations).toHaveLength(1);
    expect(applied.lifecycleEvents).toHaveLength(1);
    expect(applyVerifiedLifecycleMutation(applied, result)).toBe(applied);
    expect(() => applyVerifiedLifecycleMutation(applied, {
      ...result,
      findings: [{ ...result.findings[0]!, title: 'Different result' }],
    })).toThrow(/changed its result payload/);
    expect(() => assertFindingLifecycleAuthorityInvariant(applied)).not.toThrow();
  });

  it('requires a full event head and rejects implicit genesis or stale premises', () => {
    const createSource = evidenceSource({
      rawFindingId: 'raw-create',
      targetFindingId: null,
      title: 'Finding',
      description: 'Finding description.',
    });
    const createTarget = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: null,
    };
    const createReservation = reservation({
      operation: 'create_finding',
      targets: [createTarget],
      sources: [createSource],
    });
    const created = applyVerifiedLifecycleMutation(
      reserveVerifiedLifecycleMutation(emptyLedger([createSource]), createReservation),
      mutation({
        reservation: createReservation,
        findings: [finding({
          id: createTarget.entityId,
          source: createSource,
          revision: 1,
        })],
      }),
    );
    const resolveSource = evidenceSource({
      rawFindingId: 'raw-resolve',
      targetFindingId: 'F-0001',
      title: 'Finding',
      description: 'Finding description.',
      relation: 'resolution_confirmation',
    });
    const withResolveEvidence: FindingLedger = {
      ...created,
      evidenceRecords: [...created.evidenceRecords, resolveSource.record],
      rawFindings: [...created.rawFindings, resolveSource.raw],
    };
    const resolveTarget = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: latestHead(created, 'F-0001'),
    };
    const resolveReservation = reservation({
      operation: 'resolve_finding',
      targets: [resolveTarget],
      sources: [resolveSource],
    });
    const pending = reserveVerifiedLifecycleMutation(
      withResolveEvidence,
      resolveReservation,
    );
    const resolved = applyVerifiedLifecycleMutation(pending, mutation({
      reservation: resolveReservation,
      findings: [finding({
        id: 'F-0001',
        source: createSource,
        revision: 2,
        evidenceIds: [
          createSource.record.evidenceId,
          resolveSource.record.evidenceId,
        ],
        status: 'resolved',
        lifecycle: 'resolved',
      })],
    }));

    expect(resolved.lifecycleEvents[1]?.transitions[0]?.before)
      .toEqual(resolveTarget.expectedHead);
    const persistSource = evidenceSource({
      rawFindingId: 'raw-persist',
      targetFindingId: 'F-0001',
      title: 'Finding',
      description: 'Finding description.',
      relation: 'persists',
    });
    const resolvedWithPersistEvidence = {
      ...resolved,
      evidenceRecords: [...resolved.evidenceRecords, persistSource.record],
      rawFindings: [...resolved.rawFindings, persistSource.raw],
    };
    expect(() => reserveVerifiedLifecycleMutation(resolvedWithPersistEvidence, reservation({
      operation: 'persist_finding',
      targets: [{
        ...resolveTarget,
        expectedHead: {
          ...latestHead(resolved, 'F-0001'),
          projectionDigest: sha256('stale-projection'),
        },
      }],
      sources: [persistSource],
    }))).toThrow(/stale full head/);
    expect(() => assertFindingLifecycleAuthorityInvariant({
      ...emptyLedger([createSource]),
      findings: [finding({
        id: 'F-0001',
        source: createSource,
        revision: 1,
      })],
    })).toThrow(/does not match the current entity projection/);
  });

  it('binds evidence to raw integrity, claim identity, and proof target semantics', () => {
    const source = evidenceSource({
      rawFindingId: 'raw-create',
      targetFindingId: null,
      title: 'Expected claim',
      description: 'Expected description.',
    });
    const target = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: null,
    };
    const valid = reservation({
      operation: 'create_finding',
      targets: [target],
      sources: [source],
    });
    const forgedBinding: FindingEvidenceBinding = {
      ...valid.evidenceBindings[0]!,
      sourceRawIntegrityDigest: sha256('stale-raw'),
    };
    const forged = {
      reservation: createFindingLifecycleReservation({
        operation: 'create_finding',
        targets: [target],
        evidenceBindingIds: [forgedBinding.bindingId],
        authority: { kind: 'verified_evidence' },
        context: { kind: 'transaction' },
        reservedAt: OBSERVATION,
      }),
      evidenceBindings: [forgedBinding],
    };
    expect(() => reserveVerifiedLifecycleMutation(emptyLedger([source]), forged))
      .toThrow(/canonical content address/);

    const pending = reserveVerifiedLifecycleMutation(emptyLedger([source]), valid);
    expect(() => applyVerifiedLifecycleMutation(pending, mutation({
      reservation: valid,
      findings: [{
        ...finding({
          id: 'F-0001',
          source,
          revision: 1,
        }),
        title: 'Unrelated claim',
        claimIdentityHash: computeClaimIdentityHash({
          target: source.raw.target,
          familyTag: source.raw.familyTag,
          severity: source.raw.severity,
          title: 'Unrelated claim',
          description: source.raw.description,
          suggestion: source.raw.suggestion,
        }),
        semanticClaimIdentityHash: computeSemanticClaimIdentityHash({
          target: source.raw.target,
          title: 'Unrelated claim',
          description: source.raw.description,
        }),
      }],
    }))).toThrow(/does not match the created finding claim/);
  });

  it('enforces the closed operation-authority allowlist and empty policy bindings', () => {
    const source = evidenceSource({
      rawFindingId: 'raw-create',
      targetFindingId: null,
      title: 'Policy target',
      description: 'Policy target description.',
    });
    const createTarget = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: null,
    };
    const createReservation = reservation({
      operation: 'create_finding',
      targets: [createTarget],
      sources: [source],
    });
    const created = applyVerifiedLifecycleMutation(
      reserveVerifiedLifecycleMutation(emptyLedger([source]), createReservation),
      mutation({
        reservation: createReservation,
        findings: [finding({ id: 'F-0001', source, revision: 1 })],
      }),
    );
    const target = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: latestHead(created, 'F-0001'),
    };
    const policyReservation = createFindingLifecycleReservation({
      operation: 'waive_finding',
      targets: [target],
      evidenceBindingIds: [],
      authority: {
        kind: 'engine_policy',
        decisionKind: 'waive',
        decisionDigest: sha256('waive-policy'),
      },
      context: { kind: 'transaction' },
      reservedAt: OBSERVATION,
    });
    expect(() => reserveVerifiedLifecycleMutation(created, {
      reservation: policyReservation,
      evidenceBindings: [],
    })).not.toThrow();

    const mismatchedPolicy = createFindingLifecycleReservation({
      operation: 'waive_finding',
      targets: [target],
      evidenceBindingIds: [],
      authority: {
        kind: 'engine_policy',
        decisionKind: 'dismiss',
        decisionDigest: sha256('dismiss-policy'),
      },
      context: { kind: 'transaction' },
      reservedAt: OBSERVATION,
    });
    expect(() => reserveVerifiedLifecycleMutation(created, {
      reservation: mismatchedPolicy,
      evidenceBindings: [],
    })).toThrow(/rejects authority "engine_policy:dismiss"/);

    const policySource = evidenceSource({
      rawFindingId: 'raw-policy',
      targetFindingId: 'F-0001',
      title: source.raw.title,
      description: source.raw.description,
      relation: 'persists',
    });
    const binding = createFindingEvidenceBinding({
      evidenceId: policySource.record.evidenceId,
      claimIdentityHash: policySource.claimIdentityHash,
      sourceRawFindingId: policySource.raw.rawFindingId,
      sourceRawIntegrityDigest: computeRawFindingIntegrityDigest(policySource.raw),
      operation: 'waive_finding',
      target,
    });
    const withPolicySource = {
      ...created,
      evidenceRecords: [...created.evidenceRecords, policySource.record],
      rawFindings: [...created.rawFindings, policySource.raw],
    };
    const boundPolicy = createFindingLifecycleReservation({
      operation: 'waive_finding',
      targets: [target],
      evidenceBindingIds: [binding.bindingId],
      authority: {
        kind: 'engine_policy',
        decisionKind: 'waive',
        decisionDigest: sha256('bound-policy'),
      },
      context: { kind: 'transaction' },
      reservedAt: OBSERVATION,
    });
    expect(() => reserveVerifiedLifecycleMutation(withPolicySource, {
      reservation: boundPolicy,
      evidenceBindings: [binding],
    })).toThrow(/ineligible operation|must not carry evidence bindings/);

    const wrongSystemOperation = createFindingLifecycleReservation({
      operation: 'waive_finding',
      targets: [target],
      evidenceBindingIds: [],
      authority: { kind: 'system', action: 'record_recovery_attempt' },
      context: { kind: 'transaction' },
      reservedAt: OBSERVATION,
    });
    expect(() => reserveVerifiedLifecycleMutation(created, {
      reservation: wrongSystemOperation,
      evidenceBindings: [],
    })).toThrow(/rejects authority "system:record_recovery_attempt"/);
  });

  it('rejects reservation or event history reordering and noncanonical binding order', () => {
    const sources = ['F-0001', 'F-0002'].map((entityId, index) => evidenceSource({
      rawFindingId: `raw-${index + 1}`,
      targetFindingId: null,
      title: `Finding ${entityId}`,
      description: `Description ${entityId}.`,
    }));
    const inputs = sources.map((source, index) => {
      const target = {
        entityKind: 'finding' as const,
        entityId: `F-${String(index + 1).padStart(4, '0')}`,
        expectedHead: null,
      };
      const reserved = reservation({
        operation: 'create_finding',
        targets: [target],
        sources: [source],
      });
      return {
        reserved,
        result: mutation({
          reservation: reserved,
          findings: [finding({
            id: target.entityId,
            source,
            revision: 1,
          })],
        }),
      };
    });
    const firstPending = reserveVerifiedLifecycleMutation(
      emptyLedger(sources),
      inputs[0]!.reserved,
    );
    const bothPending = reserveVerifiedLifecycleMutation(
      firstPending,
      inputs[1]!.reserved,
    );
    expect(() => assertFindingLedgerAppendOnlyTransition(firstPending, {
      ...bothPending,
      lifecycleReservations: [...bothPending.lifecycleReservations].reverse(),
    })).toThrow(/registry prefix changed/);
    expect(() => assertFindingLedgerAppendOnlyTransition(firstPending, {
      ...bothPending,
      evidenceBindings: [...bothPending.evidenceBindings].reverse(),
    })).toThrow(/canonical binary-sorted set/);

    const firstApplied = applyVerifiedLifecycleMutation(bothPending, inputs[0]!.result);
    const bothApplied = applyVerifiedLifecycleMutation(firstApplied, inputs[1]!.result);
    expect(() => assertFindingLedgerAppendOnlyTransition(firstApplied, {
      ...bothApplied,
      lifecycleEvents: [...bothApplied.lifecycleEvents].reverse(),
    })).toThrow(/registry prefix changed/);
  });

  it('durably reuses a pending raw recovery attempt bound to the full lifecycle head', async () => {
    const source = evidenceSource({
      rawFindingId: 'raw-provisional',
      targetFindingId: null,
      title: 'Ambiguous finding',
      description: 'Needs replay adjudication.',
    });
    const target = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: null,
    };
    const createReservation = reservation({
      operation: 'create_finding',
      targets: [target],
      sources: [source],
    });
    const provisionalFinding: FindingLedgerEntry = {
      ...finding({ id: 'F-0001', source, revision: 1 }),
      provisional: {
        kind: 'raw-adjudication-unresolved',
        stableKey: sha256('stable-key'),
        lineageKey: sha256('lineage-key'),
        sourceRawFindingIds: [source.raw.rawFindingId],
        reason: 'The raw claim needs another bounded interpretation.',
        firstObservedAt: { ...OBSERVATION },
        lastObservedAt: { ...OBSERVATION },
        interpretationEpochs: 0,
        gateEffect: 'block',
        firstObservedRound: 1,
        recoveryReviewerStableKey: 'reviewer',
      },
    };
    const created = applyVerifiedLifecycleMutation(
      reserveVerifiedLifecycleMutation(emptyLedger([source]), createReservation),
      mutation({
        reservation: createReservation,
        findings: [provisionalFinding],
      }),
    );
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-raw-recovery-'));
    temporaryDirectories.add(projectCwd);
    const reportDir = join(projectCwd, '.takt', 'runs', 'run-1', 'reports');
    mkdirSync(reportDir, { recursive: true });
    const store = createFindingLedgerStore({
      projectCwd,
      reportDir,
      runId: 'run-1',
      workflowName: 'default',
      ledgerPath: '.takt/findings/default.json',
      rawFindingsPath: '.takt/findings/raw',
    });
    await store.updateLedger(() => ({ ledger: created, result: undefined }));

    const first = await reserveRawAdjudicationRecovery(
      store,
      OBSERVATION,
      sha256('review-scope'),
    );
    const second = await reserveRawAdjudicationRecovery(store, {
      ...OBSERVATION,
      runId: 'run-resumed',
      timestamp: '2026-07-29T00:05:00.000Z',
    }, sha256('review-scope'));

    expect(first.result).toHaveLength(1);
    expect(second.result).toHaveLength(1);
    expect(second.result[0]?.attemptId).toBe(first.result[0]?.attemptId);
    expect(second.ledger.rawRecoveryAttempts).toHaveLength(1);
    expect(second.result[0]?.expectedHead).toEqual(latestHead(created, 'F-0001'));
  });

  it('keeps File and SQLite authority equivalent across pending, apply, stage, and resume', async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-lifecycle-file-'));
    temporaryDirectories.add(projectCwd);
    const reportDir = join(projectCwd, '.takt', 'runs', 'run-1', 'reports');
    mkdirSync(reportDir, { recursive: true });
    const fileStore = createFindingLedgerStore({
      projectCwd,
      reportDir,
      runId: 'run-1',
      workflowName: 'default',
      ledgerPath: '.takt/findings/default.json',
      rawFindingsPath: '.takt/findings/raw',
    });
    const sqlite = createRealRunStorage({ findingContractEnabled: true });
    sqlite.clock.set(Date.parse(OBSERVATION.timestamp));
    const owner = sqlite.root.claimLease({
      ownerKey: 'lifecycle-parity',
      leaseDurationMs: 10_000,
    });
    const runtime = sqlite.root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'lifecycle-parity',
      expectedScopeRevision: 0,
    });
    const sqliteStore = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    const source = evidenceSource({
      rawFindingId: 'raw-create',
      targetFindingId: null,
      title: 'Stored finding',
      description: 'Stored description.',
    });
    for (const store of [fileStore, sqliteStore]) {
      await store.updateLedger((current) => ({
        ledger: {
          ...current,
          evidenceRecords: [source.record],
          rawFindings: [source.raw],
        },
        result: undefined,
      }));
    }
    const target = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: null,
    };
    const reservedInput = reservation({
      operation: 'create_finding',
      targets: [target],
      sources: [source],
    });
    const result = mutation({
      reservation: reservedInput,
      findings: [finding({
        id: 'F-0001',
        source,
        revision: 1,
      })],
    });
    for (const store of [fileStore, sqliteStore]) {
      await store.updateLedger((current) => ({
        ledger: reserveVerifiedLifecycleMutation(current, reservedInput),
        result: undefined,
      }));
      expect(store.loadLedger().lifecycleEvents).toEqual([]);
      await store.updateLedger((current) => ({
        ledger: applyVerifiedLifecycleMutation(current, result),
        result: undefined,
      }));
      await store.updateLedger((current) => {
        const attempt = createRawRecoveryAttempt({
          provisionalFindingId: 'F-0001',
          expectedHead: latestHead(current, 'F-0001'),
          sourceRawFindingId: source.raw.rawFindingId,
          sourceRawIntegrityDigest: computeRawFindingIntegrityDigest(source.raw),
          promptSnapshotDigest: sha256('raw-recovery-prompt'),
          attempt: 1,
          startedAt: OBSERVATION,
        });
        return {
          ledger: {
            ...current,
            rawRecoveryAttempts: [...current.rawRecoveryAttempts, attempt],
            rawRecoveryResults: [
              ...current.rawRecoveryResults,
              createRawRecoveryResult({
                attemptId: attempt.attemptId,
                replayRawFindingId: null,
                mutationIds: [],
                outcome: 'failed',
                completedAt: OBSERVATION,
              }),
            ],
          },
          result: undefined,
        };
      });
    }
    const authority = (ledger: FindingLedger) => ({
      findings: ledger.findings,
      evidenceBindings: ledger.evidenceBindings,
      lifecycleReservations: ledger.lifecycleReservations,
      lifecycleEvents: ledger.lifecycleEvents,
      rawRecoveryAttempts: ledger.rawRecoveryAttempts,
      rawRecoveryResults: ledger.rawRecoveryResults,
    });
    expect(authority(sqliteStore.loadLedger())).toEqual(authority(fileStore.loadLedger()));

    const roundMarker = 'lifecycle-pending-round';
    for (const store of [fileStore, sqliteStore]) {
      await store.commitManagerLedger((current) => ({
        ledger: {
          ...current,
          stopBudget: {
            roundMarkers: [roundMarker],
            firstRoundAt: current.updatedAt,
            exhausted: false,
          },
        },
        publication: {
          roundMarker,
          report: {
            version: 1,
            runId: store.runId,
            stepName: 'findings-manager',
            retryCount: 0,
            ledgerUpdated: true,
            finalErrors: [],
            attempts: [],
          },
        },
        result: undefined,
      }));
    }
    expect(sqliteStore.loadLedger().pendingManagerCommit?.completed.lifecycleEvents)
      .toEqual(fileStore.loadLedger().pendingManagerCommit?.completed.lifecycleEvents);

    const resumed = resumeRealRunStorage(sqlite.root, {
      slug: 'lifecycle-resume',
      findingContractEnabled: true,
    });
    const resumedLedger = loadRootFindingLedger(
      resumed.root,
      'lifecycle-resume-load',
    );
    expect(authority(resumedLedger)).toEqual(authority(sqliteStore.loadLedger()));
    expect(resumedLedger.pendingManagerCommit?.completed.lifecycleEvents)
      .toEqual(sqliteStore.loadLedger().pendingManagerCommit?.completed.lifecycleEvents);
  });

  it('resumes a nullable provisional from SQLite', async () => {
    const sqlite = createRealRunStorage({ findingContractEnabled: true });
    sqlite.clock.set(Date.parse(OBSERVATION.timestamp));
    const owner = sqlite.root.claimLease({
      ownerKey: 'nullable-provisional-resume',
      leaseDurationMs: 10_000,
    });
    const runtime = sqlite.root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'nullable-provisional-resume',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    const source = evidenceSource({
      rawFindingId: 'raw-sqlite-nullable',
      targetFindingId: null,
      title: 'Incomplete SQLite claim',
      description: 'The stored provisional remains incomplete.',
    });
    const target = {
      entityKind: 'finding' as const,
      entityId: 'F-0001',
      expectedHead: null,
    };
    const createReservation = reservation({
      operation: 'create_finding',
      targets: [target],
      sources: [source],
    });
    const provisional: FindingLedgerEntry = {
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      target: source.raw.target,
      targetIdentityHash: source.raw.targetIdentityHash,
      claimIdentityHash: source.raw.claimIdentityHash,
      semanticClaimIdentityHash: source.raw.semanticClaimIdentityHash,
      severity: null,
      title: null,
      evidenceIds: [source.record.evidenceId],
      reviewers: ['reviewer'],
      rawFindingIds: [source.raw.rawFindingId],
      firstSeen: { ...OBSERVATION },
      lastSeen: { ...OBSERVATION },
      revision: 1,
      provisional: {
        kind: 'raw-meaning-ambiguous',
        stableKey: sha256('sqlite-nullable-stable'),
        lineageKey: sha256('sqlite-nullable-lineage'),
        sourceRawFindingIds: [source.raw.rawFindingId],
        reason: 'The persisted claim is intentionally incomplete.',
        firstObservedAt: { ...OBSERVATION },
        lastObservedAt: { ...OBSERVATION },
        interpretationEpochs: 0,
        gateEffect: 'block',
        firstObservedRound: 1,
      },
    };
    const authorized = applyVerifiedLifecycleMutation(
      reserveVerifiedLifecycleMutation(
        emptyLedger([source]),
        createReservation,
      ),
      mutation({
        reservation: createReservation,
        findings: [provisional],
      }),
    );
    await store.updateLedger(() => ({
      ledger: {
        ...authorized,
        nextId: 2,
      },
      result: undefined,
    }));

    const roundMarker = 'sqlite-nullable-resume-round';
    await store.commitManagerLedger((current) => ({
      ledger: {
        ...current,
        stopBudget: {
          roundMarkers: [roundMarker],
          firstRoundAt: current.updatedAt,
          exhausted: false,
        },
      },
      publication: {
        roundMarker,
        report: {
          version: 1,
          runId: store.runId,
          stepName: 'findings-manager',
          retryCount: 0,
          ledgerUpdated: true,
          finalErrors: [],
          attempts: [],
        },
      },
      result: undefined,
    }));
    const resumed = resumeRealRunStorage(sqlite.root, {
      slug: 'nullable-provisional-resume',
      findingContractEnabled: true,
    });
    const resumedFinding = loadRootFindingLedger(
      resumed.root,
      'nullable-provisional-resume-load',
    ).findings[0];

    expect(resumedFinding).toMatchObject({
      id: provisional.id,
      target: provisional.target,
      targetIdentityHash: provisional.targetIdentityHash,
      claimIdentityHash: provisional.claimIdentityHash,
      semanticClaimIdentityHash: provisional.semanticClaimIdentityHash,
      severity: null,
      title: null,
      provisional: {
        stableKey: provisional.provisional!.stableKey,
        gateEffect: 'block',
      },
    });
  });

  it('resumes a durable provisional product transition proof from SQLite', async () => {
    const fixture = promotionBoundaryFixture();
    const proof = fixture.ledger.evidenceRecords.find((record) => (
      record.kind === 'engine_proof'
      && record.subject.kind === 'finding_provisional_product_transition'
    ));
    expect(proof).toBeDefined();
    const sqlite = createRealRunStorage({ findingContractEnabled: true });
    sqlite.clock.set(Date.parse(OBSERVATION.timestamp));
    const owner = sqlite.root.claimLease({
      ownerKey: 'provisional-transition-proof-resume',
      leaseDurationMs: 10_000,
    });
    const runtime = sqlite.root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'provisional-transition-proof-resume',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    await store.updateLedger(() => ({
      ledger: fixture.ledger,
      result: undefined,
    }));

    const resumed = resumeRealRunStorage(sqlite.root, {
      slug: 'provisional-transition-proof-resume',
      findingContractEnabled: true,
    });
    const resumedProof = loadRootFindingLedger(
      resumed.root,
      'provisional-proof-resume-load',
    ).evidenceRecords.find(
        (record) => record.evidenceId === proof?.evidenceId,
      );
    expect(resumedProof).toEqual(proof);
  });

  it('rejects a raw recovery result that borrows an unrelated lifecycle event', () => {
    const source = evidenceSource({
      rawFindingId: 'raw-recovery-source',
      targetFindingId: null,
      title: 'Recovery source',
      description: 'The provisional finding under recovery.',
    });
    const provisionalReservation = reservation({
      operation: 'create_finding',
      targets: [{
        entityKind: 'finding',
        entityId: 'F-0001',
        expectedHead: null,
      }],
      sources: [source],
    });
    const provisional = applyVerifiedLifecycleMutation(
      reserveVerifiedLifecycleMutation(emptyLedger([source]), provisionalReservation),
      mutation({
        reservation: provisionalReservation,
        findings: [{
          ...finding({ id: 'F-0001', source, revision: 1 }),
          provisional: {
            kind: 'raw-adjudication-unresolved',
            stableKey: sha256('raw-recovery-stable'),
            lineageKey: sha256('raw-recovery-lineage'),
            sourceRawFindingIds: [source.raw.rawFindingId],
            reason: 'Needs replay.',
            firstObservedAt: { ...OBSERVATION },
            lastObservedAt: { ...OBSERVATION },
            interpretationEpochs: 0,
            gateEffect: 'block',
            firstObservedRound: 1,
            recoveryReviewerStableKey: 'reviewer',
          },
        }],
      }),
    );
    const attempt = createRawRecoveryAttempt({
      provisionalFindingId: 'F-0001',
      expectedHead: latestHead(provisional, 'F-0001'),
      sourceRawFindingId: source.raw.rawFindingId,
      sourceRawIntegrityDigest: computeRawFindingIntegrityDigest(source.raw),
      promptSnapshotDigest: sha256('raw-recovery-unrelated-event-prompt'),
      attempt: 1,
      startedAt: OBSERVATION,
    });
    const replaySource: EvidenceSource = {
      ...source,
      raw: {
        ...source.raw,
        rawFindingId: 'replay-unrelated-event',
      },
    };
    const unrelatedReservation = reservation({
      operation: 'create_finding',
      targets: [{
        entityKind: 'finding',
        entityId: 'F-0002',
        expectedHead: null,
      }],
      sources: [replaySource],
    });
    const withReplayRaw = {
      ...provisional,
      rawFindings: [...provisional.rawFindings, replaySource.raw],
      rawRecoveryAttempts: [attempt],
    };
    const unrelated = applyVerifiedLifecycleMutation(
      reserveVerifiedLifecycleMutation(withReplayRaw, unrelatedReservation),
      mutation({
        reservation: unrelatedReservation,
        findings: [finding({
          id: 'F-0002',
          source: replaySource,
          revision: 1,
        })],
      }),
    );
    const unrelatedMutationId = unrelated.lifecycleEvents.at(-1)!.mutationId;
    const forged = {
      ...unrelated,
      rawRecoveryResults: [createRawRecoveryResult({
        attemptId: attempt.attemptId,
        replayRawFindingId: replaySource.raw.rawFindingId,
        mutationIds: [unrelatedMutationId],
        outcome: 'applied',
        completedAt: OBSERVATION,
      })],
    };

    expect(() => assertFindingLedgerProjectionInvariant(forged))
      .toThrow(/broken target transition chain/);
  });
});
