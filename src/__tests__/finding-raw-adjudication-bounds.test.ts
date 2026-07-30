import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse, AgentWorkflowStep, WorkflowStep } from '../core/models/types.js';
import type {
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
  RawFinding,
} from '../core/workflow/findings/types.js';
import { computeClaimIdentityHash } from '../core/models/finding-claim-identity.js';
import {
  computeFileQuoteEvidenceRecordId,
  createEngineProofRecord,
} from '../core/models/finding-evidence-record.js';
import {
  createRawRecoveryAttempt,
  createRawRecoveryResult,
} from '../core/models/finding-raw-recovery.js';
import { computeRawFindingIntegrityDigest } from '../core/models/finding-raw-integrity.js';
import {
  createFindingEvidenceBinding,
  createFindingLifecycleReservation,
} from '../core/models/finding-lifecycle-identity.js';
import type {
  FindingManagerStore,
  FindingManagerValidationReport,
} from '../core/workflow/findings/store.js';
import type { RunFindingManagerForStepInput } from '../core/workflow/findings/manager-contracts.js';
import { applyRawAdjudicationRecovery } from '../core/workflow/findings/raw-adjudication-commit.js';
import { completeRawRecoveryAttempts } from '../core/workflow/findings/raw-recovery-result.js';
import { runRawAdjudicationRecovery } from '../core/workflow/findings/raw-adjudication-recovery.js';
import { reserveRawAdjudicationRecovery } from '../core/workflow/findings/raw-adjudication-reservation.js';
import {
  estimateTokens,
  findRawFieldLimitViolation,
  RAW_FINDING_LIMITS,
  RAW_ADJUDICATION_RECOVERY_LIMITS,
} from '../core/workflow/findings/raw-finding-limits.js';
import { classifyProvisionalRecovery } from '../core/workflow/findings/provisional-recovery.js';
import { runFindingManagerForStep } from '../core/workflow/findings/manager-runner.js';
import { buildManagerInputLedger } from '../core/workflow/findings/manager-agent.js';
import { StepExecutor } from '../core/workflow/engine/StepExecutor.js';
import { RawAdjudicationDecisionsJsonSchema } from '../core/workflow/findings/raw-adjudication-step.js';
import {
  candidateFromStoredRawFinding,
  canonicalizeReviewerRawFinding,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import { captureFindingPreconditions } from '../core/workflow/findings/finding-preconditions.js';
import { snapshotProvisionalRecoveryOrigin } from '../core/workflow/findings/provisional-recovery-origin.js';
import { createFindingManagerPublicationDouble, RevisionedFindingLedgerTestRepository } from './helpers/finding-manager-publication.js';
import { deduplicateRawEvidence } from '../core/workflow/findings/evidence-domain.js';
import {
  applyVerifiedLifecycleMutation,
  captureFindingLifecycleHead,
  reserveVerifiedLifecycleMutation,
} from '../core/workflow/findings/lifecycle-mutation.js';
import { canonicalRawFindingFixture } from './helpers/finding-lifecycle-fixture.js';
import { createAnchorAdjudication } from '../core/models/finding-anchor-relevance.js';

vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: vi.fn() }));
vi.mock('../core/workflow/findings/snapshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/snapshot.js')>();
  const reviewScopeSnapshotId = '1'.repeat(64);
  return {
    ...actual,
    computeReviewScopeSnapshotId: () => reviewScopeSnapshotId,
    captureReviewScopeProofSnapshot: () => ({
      reviewScopeSnapshotId,
      trackedDiff: undefined,
      untrackedEvidence: [],
      queryInventory: [],
    }),
  };
});
vi.mock('../core/workflow/findings/manager-output-validation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/manager-output-validation.js')>();
  return { ...actual, validateFindingManagerOutput: vi.fn(actual.validateFindingManagerOutput) };
});
vi.mock('../core/workflow/findings/mechanical-classification.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/mechanical-classification.js')>();
  return { ...actual, classifyRawFindingsMechanically: vi.fn(actual.classifyRawFindingsMechanically) };
});

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);
const validationModule = await import('../core/workflow/findings/manager-output-validation.js');
const actualValidationModule = await vi.importActual<typeof validationModule>(
  '../core/workflow/findings/manager-output-validation.js',
);
const validateManagerOutputMock = vi.mocked(validationModule.validateFindingManagerOutput);
const mechanicalModule = await import('../core/workflow/findings/mechanical-classification.js');
const actualMechanicalModule = await vi.importActual<typeof mechanicalModule>(
  '../core/workflow/findings/mechanical-classification.js',
);
const classifyRawFindingsMechanicallyMock = vi.mocked(mechanicalModule.classifyRawFindingsMechanically);
const REPORT_DIR = mkdtempSync(join(tmpdir(), 'takt-raw-adjudication-reports-'));

afterAll(() => {
  rmSync(REPORT_DIR, { recursive: true, force: true });
});

const observation = {
  runId: 'run-bounded',
  stepName: 'reviewers',
  timestamp: '2026-07-20T00:00:00.000Z',
};
const quote = {
  verbatimExcerpt: '{',
  snapshotId: '1'.repeat(64),
};
const reviewScopeSnapshot = {
  reviewScopeSnapshotId: quote.snapshotId,
  trackedDiff: undefined,
  untrackedEvidence: [],
  queryInventory: [],
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cloneFixture<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function findingId(index: number): string {
  return `F-${String(index).padStart(4, '0')}`;
}

function largeVerifiedEvidence(): RawFinding['evidence'] {
  const lines = readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8').split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  let lineIndex = 0;
  const evidence = Array.from({ length: 16 }, () => {
    const startLine = lineIndex + 1;
    const excerptLines: string[] = [];
    while (lineIndex < lines.length && excerptLines.length < 200) {
      const next = [...excerptLines, lines[lineIndex]!];
      if (next.join('\n').length > RAW_FINDING_LIMITS.maxVerbatimExcerptChars) {
        break;
      }
      excerptLines.push(lines[lineIndex]!);
      lineIndex += 1;
    }
    return {
      kind: 'file_quote' as const,
      path: 'package-lock.json',
      startLine,
      endLine: lineIndex,
      verbatimExcerpt: excerptLines.join('\n'),
      snapshotId: quote.snapshotId,
    };
  });
  return deduplicateRawEvidence(evidence);
}

function sourceRaw(
  index: number,
  descriptionChars = 0,
  evidenceExcerptChars = 0,
): RawFinding {
  const suffix = descriptionChars > 0 ? ` ${'x'.repeat(descriptionChars)}` : '';
  const evidence = evidenceExcerptChars > 0
    ? largeVerifiedEvidence()
    : [{
        kind: 'file_quote' as const,
        path: 'package.json',
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: quote.verbatimExcerpt,
        snapshotId: quote.snapshotId,
      }];
  return canonicalRawFindingFixture({
    rawFindingId: `source-${index}`,
    stepName: 'reviewer-a',
    reviewer: 'reviewer-a',
    familyTag: 'bug',
    severity: 'high',
    title: `Issue ${index}`,
    description: `Distinct issue ${index}.${suffix}`,
    suggestion: `Fix issue ${index}.`,
    relation: 'new',
    targetFindingId: null,
    target: {
      kind: 'code',
      paths: [evidenceExcerptChars > 0 ? 'package-lock.json' : 'package.json'],
    },
    evidence,
  });
}

function provisionalFinding(input: {
  index: number;
  source: RawFinding;
  firstObservedRound: number;
  firstObservedAt?: string;
}): FindingLedgerEntry {
  const firstObservedAt = {
    ...observation,
    timestamp: input.firstObservedAt ?? observation.timestamp,
  };
  return {
    id: findingId(input.index),
    status: 'open',
    lifecycle: 'new',
    target: input.source.target,
    targetIdentityHash: input.source.targetIdentityHash,
    claimIdentityHash: input.source.claimIdentityHash,
    semanticClaimIdentityHash: input.source.semanticClaimIdentityHash,
    severity: 'high',
    title: input.source.title,
    evidenceIds: [],
    description: input.source.description,
    reviewers: ['reviewer-a'],
    rawFindingIds: [input.source.rawFindingId],
    firstSeen: { ...firstObservedAt },
    lastSeen: { ...firstObservedAt },
    revision: 1,
    provisional: {
      kind: 'raw-adjudication-unresolved',
      stableKey: `stable-${input.index}`,
      lineageKey: `lineage-${input.index}`,
      sourceRawFindingIds: [input.source.rawFindingId],
      reason: 'pending raw adjudication',
      firstObservedAt: { ...firstObservedAt },
      lastObservedAt: { ...firstObservedAt },
      interpretationEpochs: 0,
      gateEffect: 'block',
      firstObservedRound: input.firstObservedRound,
      recoveryReviewerStableKey: 'reviewer-stable-a',
    },
  };
}

function authorizeInitialEntity(
  ledger: FindingLedger,
  entity: FindingLedgerEntry | FindingLedgerConflict,
  entityKind: 'finding' | 'conflict',
): FindingLedger {
  if (entity.revision !== 1) {
    throw new Error(`Initial fixture entity "${entity.id}" must start at revision 1`);
  }
  const isProvisional = entityKind === 'finding'
    && (entity as FindingLedgerEntry).provisional !== undefined;
  const normalizedEntity = entityKind === 'finding'
    ? (() => {
        const finding = entity as FindingLedgerEntry;
        if (
          isProvisional
          &&
          finding.target !== undefined
          && finding.targetIdentityHash !== undefined
          && finding.claimIdentityHash !== undefined
        ) {
          return finding;
        }
        const identitySource = canonicalRawFindingFixture({
          rawFindingId: `fixture-identity:${finding.id}`,
          stepName: observation.stepName,
          reviewer: 'fixture-reviewer',
          familyTag: 'fixture',
          severity: finding.severity,
          title: finding.title,
          description: finding.description ?? finding.title,
          suggestion: null,
          relation: 'new',
          targetFindingId: null,
          target: {
            kind: 'code',
            paths: [`fixtures/${finding.id}.ts`],
          },
          evidence: [],
        });
        return {
          ...finding,
          target: identitySource.target,
          targetIdentityHash: identitySource.targetIdentityHash,
          claimIdentityHash: identitySource.claimIdentityHash,
        };
      })()
    : entity;
  const operation = entityKind === 'conflict'
    ? 'create_conflict'
    : isProvisional
      ? 'update_provisional'
      : 'create_finding';
  const rawSource: RawFinding | undefined = isProvisional
    ? undefined
    : canonicalRawFindingFixture({
        rawFindingId: `fixture-raw:${entityKind}:${entity.id}`,
        stepName: observation.stepName,
        reviewer: 'fixture-reviewer',
        familyTag: 'fixture',
        severity: 'high',
        title: entityKind === 'finding' ? normalizedEntity.title : `Conflict ${entity.id}`,
        description: normalizedEntity.description ?? `Conflict ${entity.id}`,
        suggestion: null,
        relation: entityKind === 'finding' ? 'new' : 'persists',
        targetFindingId: entityKind === 'finding'
          ? null
          : (entity as FindingLedgerConflict).findingIds[0] ?? 'F-0001',
        target: entityKind === 'finding'
          ? (normalizedEntity as FindingLedgerEntry).target!
          : {
              kind: 'code',
              paths: [`fixtures/${entity.id}.ts`],
            },
        evidence: [{
          kind: 'file_quote',
          path: `fixtures/${entity.id}.ts`,
          startLine: 1,
          endLine: 1,
          verbatimExcerpt: entity.description ?? entity.id,
          snapshotId: sha256(`fixture-snapshot:${entityKind}:${entity.id}`),
        }],
      });
  const claimIdentityHash = rawSource === undefined
    ? (normalizedEntity as FindingLedgerEntry).claimIdentityHash!
    : rawSource.claimIdentityHash;
  const evidenceRecord = rawSource === undefined
    ? createEngineProofRecord({
        kind: 'engine_proof',
        verifierId: 'takt.finding-lifecycle-policy',
        verifierVersion: '1',
        workflowName: ledger.workflowName,
        runId: observation.runId,
        scopeIdentity: 'raw-adjudication-bounds',
        snapshotId: sha256(`fixture-snapshot:${entityKind}:${entity.id}`),
        purpose: 'lifecycle_authority',
        claimIdentityHash,
        targetFindingId: null,
        subject: {
          kind: 'finding_provisional_isolation',
          findingId: entity.id,
          provisionalKind: (normalizedEntity as FindingLedgerEntry).provisional!.kind,
          stableKey: (normalizedEntity as FindingLedgerEntry).provisional!.stableKey,
        },
        dependencyDigests: [],
        resultDigest: sha256(`fixture-result:${entityKind}:${entity.id}`),
        issuedAt: observation.timestamp,
      })
    : (() => {
        const quote = rawSource.evidence[0]!;
        if (quote.kind !== 'file_quote') {
          throw new Error('Expected fixture file quote');
        }
        const payload = {
          ...quote,
          claimIdentityHash,
          fileHash: sha256(`fixture-file:${entityKind}:${entity.id}`),
        };
        return {
          evidenceId: computeFileQuoteEvidenceRecordId(payload),
          ...payload,
        };
      })();
  const target = {
    entityKind,
    entityId: entity.id,
    expectedHead: null,
  } as const;
  const binding = createFindingEvidenceBinding({
    evidenceId: evidenceRecord.evidenceId,
    claimIdentityHash,
    sourceRawFindingId: rawSource?.rawFindingId ?? null,
    sourceRawIntegrityDigest: rawSource === undefined
      ? null
      : computeRawFindingIntegrityDigest(rawSource),
    operation,
    target,
  });
  const reservation = createFindingLifecycleReservation({
    operation,
    targets: [target],
    evidenceBindingIds: [binding.bindingId],
    authority: { kind: 'verified_evidence' },
    context: { kind: 'transaction' },
    reservedAt: observation,
  });
  const withReservation = reserveVerifiedLifecycleMutation({
    ...ledger,
    evidenceRecords: [...ledger.evidenceRecords, evidenceRecord],
    rawFindings: rawSource === undefined
      ? ledger.rawFindings
      : [...ledger.rawFindings, rawSource],
  }, {
    reservation,
    evidenceBindings: [binding],
  });
  const authorizedEntity = entityKind === 'finding'
    ? {
        ...(normalizedEntity as FindingLedgerEntry),
        evidenceIds: [
          ...(normalizedEntity as FindingLedgerEntry).evidenceIds,
          evidenceRecord.evidenceId,
        ],
      }
    : entity;
  return applyVerifiedLifecycleMutation(withReservation, {
    mutationId: reservation.mutationId,
    findings: entityKind === 'finding' ? [authorizedEntity as FindingLedgerEntry] : [],
    conflicts: entityKind === 'conflict' ? [authorizedEntity as FindingLedgerConflict] : [],
    occurredAt: observation,
  });
}

function authorizeInitialLedgerFixture(input: FindingLedger): FindingLedger {
  let ledger: FindingLedger = {
    ...cloneFixture(input),
    findings: [],
    conflicts: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawRecoveryAttempts: [],
    rawRecoveryResults: [],
  };
  for (const finding of input.findings) {
    if (
      finding.provisional === undefined
      && finding.status === 'resolved'
    ) {
      const genesis = cloneFixture({
        ...finding,
        status: 'open' as const,
        lifecycle: 'new' as const,
        revision: 1,
      });
      delete genesis.resolvedAt;
      delete genesis.resolvedEvidence;
      ledger = authorizeInitialEntity(ledger, genesis, 'finding');
      const expectedHead = captureFindingLifecycleHead(ledger, 'finding', finding.id)!;
      const currentFinding = ledger.findings.find(
        (candidate) => candidate.id === finding.id,
      )!;
      const raw: RawFinding = canonicalRawFindingFixture({
        rawFindingId: `fixture-resolution:${finding.id}`,
        stepName: observation.stepName,
        reviewer: 'fixture-reviewer',
        familyTag: 'fixture',
        severity: finding.severity,
        title: finding.title,
        description: finding.description ?? finding.title,
        suggestion: null,
        relation: 'resolution_confirmation',
        targetFindingId: finding.id,
        targetPrecondition: captureFindingPreconditions(ledger).get(finding.id)!.precondition,
        target: currentFinding.target!,
        evidence: [{
          kind: 'file_quote',
          path: `fixtures/${finding.id}-resolution.ts`,
          startLine: 1,
          endLine: 1,
          verbatimExcerpt: finding.description ?? finding.title,
          snapshotId: sha256(`fixture-resolution-snapshot:${finding.id}`),
        }],
      });
      const claimIdentityHash = raw.claimIdentityHash;
      const quote = raw.evidence[0]!;
      if (quote.kind !== 'file_quote') {
        throw new Error('Expected fixture resolution quote');
      }
      const recordPayload = {
        ...quote,
        claimIdentityHash,
        fileHash: sha256(`fixture-resolution-file:${finding.id}`),
      };
      const record = {
        evidenceId: computeFileQuoteEvidenceRecordId(recordPayload),
        ...recordPayload,
      };
      const target = {
        entityKind: 'finding' as const,
        entityId: finding.id,
        expectedHead,
      };
      const binding = createFindingEvidenceBinding({
        evidenceId: record.evidenceId,
        claimIdentityHash,
        sourceRawFindingId: raw.rawFindingId,
        sourceRawIntegrityDigest: computeRawFindingIntegrityDigest(raw),
        operation: 'resolve_finding',
        target,
      });
      const reservation = createFindingLifecycleReservation({
        operation: 'resolve_finding',
        targets: [target],
        evidenceBindingIds: [binding.bindingId],
        authority: { kind: 'verified_evidence' },
        context: { kind: 'transaction' },
        reservedAt: observation,
      });
      const pending = reserveVerifiedLifecycleMutation({
        ...ledger,
        evidenceRecords: [...ledger.evidenceRecords, record],
        rawFindings: [...ledger.rawFindings, raw],
      }, {
        reservation,
        evidenceBindings: [binding],
      });
      ledger = applyVerifiedLifecycleMutation(pending, {
        mutationId: reservation.mutationId,
        findings: [{
          ...cloneFixture(finding),
          target: currentFinding.target,
          targetIdentityHash: currentFinding.targetIdentityHash,
          claimIdentityHash: currentFinding.claimIdentityHash,
          revision: 2,
          resolvedAt: finding.resolvedAt ?? observation.timestamp,
          resolvedEvidence: finding.resolvedEvidence ?? 'Fixture resolution evidence.',
          evidenceIds: [...new Set([
            ...ledger.findings.find((candidate) => candidate.id === finding.id)!.evidenceIds,
            ...finding.evidenceIds,
            record.evidenceId,
          ])].sort(),
        }],
        conflicts: [],
        occurredAt: observation,
      });
      continue;
    }
    ledger = authorizeInitialEntity(ledger, cloneFixture(finding), 'finding');
  }
  for (const conflict of input.conflicts) {
    ledger = authorizeInitialEntity(ledger, cloneFixture(conflict), 'conflict');
  }
  return {
    ...ledger,
    nextId: input.nextId,
    updatedAt: input.updatedAt,
  };
}

function rawRecoveryAttemptsFor(
  ledger: FindingLedger,
  provisionalFindingId: string,
) {
  return ledger.rawRecoveryAttempts.filter(
    (attempt) => attempt.provisionalFindingId === provisionalFindingId,
  );
}

function rawRecoveryResultsFor(
  ledger: FindingLedger,
  provisionalFindingId: string,
) {
  const attemptIds = new Set(
    rawRecoveryAttemptsFor(ledger, provisionalFindingId)
      .map((attempt) => attempt.attemptId),
  );
  return ledger.rawRecoveryResults.filter((result) => attemptIds.has(result.attemptId));
}

function pendingRawRecoveryAttempts(ledger: FindingLedger) {
  const completedAttemptIds = new Set(
    ledger.rawRecoveryResults.map((result) => result.attemptId),
  );
  return ledger.rawRecoveryAttempts.filter(
    (attempt) => !completedAttemptIds.has(attempt.attemptId),
  );
}

function appendFailedRawRecoveryResults(
  ledger: FindingLedger,
  attemptIds: ReadonlySet<string>,
): FindingLedger {
  const completedAttemptIds = new Set(
    ledger.rawRecoveryResults.map((result) => result.attemptId),
  );
  return {
    ...ledger,
    rawRecoveryResults: [
      ...ledger.rawRecoveryResults,
      ...ledger.rawRecoveryAttempts
        .filter((attempt) => (
          attemptIds.has(attempt.attemptId)
          && !completedAttemptIds.has(attempt.attemptId)
        ))
        .map((attempt) => createRawRecoveryResult({
          attemptId: attempt.attemptId,
          replayRawFindingId: null,
          mutationIds: [],
          outcome: 'failed',
          completedAt: observation,
        })),
    ],
  };
}

function appendFailedRawRecoveryAttempt(
  ledger: FindingLedger,
  provisionalFindingId: string,
): FindingLedger {
  const finding = ledger.findings.find((candidate) => candidate.id === provisionalFindingId);
  const expectedHead = captureFindingLifecycleHead(ledger, 'finding', provisionalFindingId);
  if (finding?.provisional === undefined || expectedHead === undefined) {
    throw new Error(`Missing provisional fixture "${provisionalFindingId}"`);
  }
  const sourceRawFindingId = finding.provisional.sourceRawFindingIds[0]
    ?? `raw-adjudication:${finding.id}:missing-source`;
  const sourceRaw = ledger.rawFindings.find(
    (raw) => raw.rawFindingId === sourceRawFindingId,
  );
  const attempt = createRawRecoveryAttempt({
    provisionalFindingId,
    expectedHead,
    sourceRawFindingId,
    sourceRawIntegrityDigest: sourceRaw === undefined
      ? null
      : computeRawFindingIntegrityDigest(sourceRaw),
    promptSnapshotDigest: sha256(`fixture-prompt:${provisionalFindingId}`),
    attempt: rawRecoveryAttemptsFor(ledger, provisionalFindingId).length + 1,
    startedAt: observation,
  });
  return {
    ...ledger,
    rawRecoveryAttempts: [...ledger.rawRecoveryAttempts, attempt],
    rawRecoveryResults: [
      ...ledger.rawRecoveryResults,
      createRawRecoveryResult({
        attemptId: attempt.attemptId,
        replayRawFindingId: null,
        mutationIds: [],
        outcome: 'failed',
        completedAt: observation,
      }),
    ],
  };
}

function advanceFindingFixture(
  ledger: FindingLedger,
  provisionalFindingId: string,
): FindingLedger {
  const finding = ledger.findings.find((candidate) => candidate.id === provisionalFindingId);
  const expectedHead = captureFindingLifecycleHead(ledger, 'finding', provisionalFindingId);
  if (finding === undefined || expectedHead === undefined) {
    throw new Error(`Missing finding fixture "${provisionalFindingId}"`);
  }
  const reservation = createFindingLifecycleReservation({
    operation: 'record_recovery_attempt',
    targets: [{
      entityKind: 'finding',
      entityId: finding.id,
      expectedHead,
    }],
    evidenceBindingIds: [],
    authority: { kind: 'system', action: 'record_recovery_attempt' },
    context: { kind: 'transaction' },
    reservedAt: observation,
  });
  const pending = reserveVerifiedLifecycleMutation(ledger, {
    reservation,
    evidenceBindings: [],
  });
  return applyVerifiedLifecycleMutation(pending, {
    mutationId: reservation.mutationId,
    findings: [{ ...finding, revision: finding.revision + 1 }],
    conflicts: [],
    occurredAt: observation,
  });
}

function makeBacklog(input: {
  count: number;
  descriptionChars?: number;
  evidenceExcerptChars?: number;
  firstObservedRound: number;
  startIndex?: number;
}): FindingLedger {
  const startIndex = input.startIndex ?? 1;
  const raws = Array.from(
    { length: input.count },
    (_, offset) => sourceRaw(
      startIndex + offset,
      input.descriptionChars,
      input.evidenceExcerptChars,
    ),
  );
  return {
    workflowName: 'peer-review',
    nextId: startIndex + input.count + 1,
    updatedAt: observation.timestamp,
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawRecoveryAttempts: [],
    rawRecoveryResults: [],
    rawFindings: raws,
    conflicts: [],
    interpretations: [],
    findings: raws.map((source, offset) => provisionalFinding({
      index: startIndex + offset,
      source,
      firstObservedRound: input.firstObservedRound,
    })),
  };
}

function stampTargetRaw(
  source: RawFinding,
  relation: Exclude<RawFinding['relation'], 'new'>,
  targetFindingId: string,
  snapshot: FindingLedger,
): RawFinding {
  const targetPrecondition = captureFindingPreconditions(snapshot)
    .get(targetFindingId)?.precondition;
  if (targetPrecondition === undefined) {
    throw new Error(`Test target "${targetFindingId}" must exist in the observation snapshot`);
  }
  return {
    ...source,
    relation,
    targetFindingId,
    targetPrecondition,
  };
}

interface RecoveryHarness {
  store: FindingManagerStore;
  savedRawFindings: RawFinding[][];
  savedReports: FindingManagerValidationReport[];
  current: () => FindingLedger;
  replaceLedger: (replace: (ledger: FindingLedger) => FindingLedger) => Promise<void>;
  runInput: RunFindingManagerForStepInput;
  managerStep: AgentWorkflowStep;
  runRecovery: () => ReturnType<typeof runRawAdjudicationRecovery>;
}

function makeHarness(
  initialLedger: FindingLedger,
  options?: { provider: 'codex' | 'cursor' },
): RecoveryHarness {
  const ledgerRepository = new RevisionedFindingLedgerTestRepository(
    authorizeInitialLedgerFixture(initialLedger),
  );
  const provider = options?.provider ?? 'codex';
  const savedRawFindings: RawFinding[][] = [];
  const savedReports: FindingManagerValidationReport[] = [];
  const store: FindingManagerStore = {
    ledgerIdentity: '/test/finding-raw-adjudication-bounds/ledger.json',
    workflowName: initialLedger.workflowName,
    workflowTask: 'Review the supplied implementation.',
    loadLedger: () => ledgerRepository.loadLedger(),
    updateLedger: (mutator) => ledgerRepository.updateLedger(mutator),
    saveLedgerSnapshot: () => {},
    saveRawFindings: (_runId, _stepName, rawFindings) => {
      savedRawFindings.push(rawFindings);
    },
    saveManagerValidationReport: (report) => {
      savedReports.push(report);
    },
    ...createFindingManagerPublicationDouble((report) => {
      savedReports.push(report);
      return join(REPORT_DIR, `findings-manager-validation.${report.stepName}.json`);
    }, ledgerRepository),
  };
  const managerStep: AgentWorkflowStep = {
    kind: 'agent',
    name: 'findings-manager',
    persona: 'findings-manager',
    edit: false,
  };
  const phase1Executor = new StepExecutor({
    optionsBuilder: {
      resolveStepProviderModel: () => ({ provider, model: 'gpt-test' }),
    },
    getLanguage: () => 'en',
  } as never);
  const runInput = {
    contract: {
      ledgerPath: '.takt/findings/ledger.json',
      rawFindingsPath: '.takt/findings/raw',
      manager: {
        persona: 'findings-manager',
        instruction: 'Reconcile findings.',
        outputContract: 'Return JSON.',
      },
    },
    cwd: process.cwd(),
    ledgerStore: store,
    optionsBuilder: {
      buildAgentOptions: () => ({}),
      resolveStepProviderModel: () => ({ provider, model: 'gpt-test' }),
    },
    stepExecutor: {
      buildPhase1Instruction: phase1Executor.buildPhase1Instruction.bind(phase1Executor),
      normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
      recordSynthesizedAgentUsage: () => {},
    },
    parentStep: { kind: 'agent', name: observation.stepName, persona: 'reviewer', edit: false },
    stepIteration: 2,
    subResults: [],
    workflowName: initialLedger.workflowName,
    runId: observation.runId,
    callNamespace: '',
    timestamp: observation.timestamp,
  } as RunFindingManagerForStepInput;
  return {
    store,
    savedRawFindings,
    savedReports,
    current: () => ledgerRepository.loadLedger(),
    replaceLedger: async (replace) => {
      await ledgerRepository.updateLedger((ledger) => ({
        ledger: replace(ledger),
        result: undefined,
      }));
    },
    runInput,
    managerStep,
    runRecovery: () => runRawAdjudicationRecovery({
      runInput,
      previousLedger: ledgerRepository.loadLedger(),
      managerStep,
      observation,
      reviewScopeSnapshotId: quote.snapshotId,
      reviewScopeSnapshot,
    }),
  };
}

function rawBatchFromInstruction(instruction: string): RawFinding[] {
  const match = /Raw findings:\n(`{3,})json\n([\s\S]*?)\n\1/.exec(instruction);
  if (match?.[2] === undefined) {
    throw new Error('Raw findings block was not found in manager instruction');
  }
  return JSON.parse(match[2]) as RawFinding[];
}

function managerResponse(instruction: string, evidence = 'Independent issue.'): AgentResponse {
  const batch = rawBatchFromInstruction(instruction);
  return {
    status: 'done',
    content: '',
    structuredOutput: {
      rawDecisions: batch.map((raw) => ({
        rawFindingId: raw.rawFindingId,
        decision: 'new',
        findingId: '',
        anchorRelevance: 'not_applicable',
        evidence,
      })),
      disputeDecisions: [],
      conflictDecisions: [],
      invalidateDecisions: [],
      duplicateDecisions: [],
      dismissDecisions: [],
    },
  };
}

function applyRecovery(harness: RecoveryHarness, recovery: Awaited<ReturnType<RecoveryHarness['runRecovery']>>): FindingLedger {
  const before = harness.current();
  const applied = applyRawAdjudicationRecovery({
    freshLedger: before,
    recovery,
    runInput: harness.runInput,
    observation,
    reviewScopeSnapshotId: quote.snapshotId,
    reviewScopeSnapshot,
  });
  return completeRawRecoveryAttempts(
    before,
    applied.ledger,
    recovery.reservationTokens,
    new Map([...recovery.origins].map(([rawFindingId, origin]) => [
      origin.attemptId,
      rawFindingId,
    ])),
    observation,
  );
}

beforeEach(() => {
  executeAgentMock.mockReset();
  validateManagerOutputMock.mockReset();
  validateManagerOutputMock.mockImplementation(actualValidationModule.validateFindingManagerOutput);
  classifyRawFindingsMechanicallyMock.mockReset();
  classifyRawFindingsMechanicallyMock.mockImplementation(
    actualMechanicalModule.classifyRawFindingsMechanically,
  );
});

describe('bounded raw adjudication recovery', () => {
  it('keeps identity, source binding, proof details, and revision in compact manager views', () => {
    const ledger = authorizeInitialLedgerFixture(makeBacklog({
      count: 1,
      firstObservedRound: 1,
    }));
    const view = buildManagerInputLedger(ledger, new Set()) as {
      findings: Array<Record<string, unknown>>;
    };

    expect(view.findings[0]).toMatchObject({
      id: 'F-0001',
      revision: 1,
      target: ledger.findings[0]!.target,
      targetIdentityHash: ledger.findings[0]!.targetIdentityHash,
      claimIdentityHash: ledger.findings[0]!.claimIdentityHash,
      semanticClaimIdentityHash: ledger.findings[0]!.semanticClaimIdentityHash,
      projectionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sourceBindings: {
        items: [expect.objectContaining({
          rawFindingId: 'source-1',
          candidateIdentityHash: ledger.rawFindings[0]!.candidateIdentityHash,
          sourceBinding: ledger.rawFindings[0]!.sourceBinding,
        })],
        totalCount: 1,
        fullSetDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        truncated: false,
      },
      evidenceSummaries: {
        items: [expect.objectContaining({
          kind: 'engine_proof',
          purpose: 'lifecycle_authority',
        })],
        totalCount: 1,
        fullSetDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        truncated: false,
      },
    });
    expect(view.findings[0]).not.toHaveProperty('description');
    expect(view.findings[0]).not.toHaveProperty('rawFindings');
  });

  it('keeps 200 compact findings bounded when stored quote length increases', () => {
    const makeLedgerWithQuoteRecords = (verbatimExcerptChars: number): FindingLedger => {
      const ledger = makeBacklog({
        count: 200,
        firstObservedRound: 1,
      });
      const evidenceRecords = ledger.rawFindings.map((rawFinding, index) => {
        const payload = {
          kind: 'file_quote' as const,
          path: `src/compact-${index}.ts`,
          startLine: 1,
          endLine: 1,
          verbatimExcerpt: 'q'.repeat(verbatimExcerptChars),
          snapshotId: quote.snapshotId,
          claimIdentityHash: rawFinding.claimIdentityHash,
          fileHash: sha256(`compact-file-${index}`),
        };
        return {
          evidenceId: computeFileQuoteEvidenceRecordId(payload),
          ...payload,
        };
      });
      return {
        ...ledger,
        evidenceRecords,
        findings: ledger.findings.map((finding, index) => ({
          ...finding,
          evidenceIds: [evidenceRecords[index]!.evidenceId],
        })),
      };
    };

    const shortView = JSON.stringify(buildManagerInputLedger(
      makeLedgerWithQuoteRecords(32),
      new Set(),
    ));
    const longView = JSON.stringify(buildManagerInputLedger(
      makeLedgerWithQuoteRecords(RAW_FINDING_LIMITS.maxVerbatimExcerptChars),
      new Set(),
    ));

    expect(longView.length).toBe(shortView.length);
    expect(longView).not.toContain('q'.repeat(256));
    expect(longView.length).toBeLessThan(600_000);
  });

  it('bounds every historical collection for one compact finding with 1000 raw and evidence records', () => {
    const backlog = makeBacklog({
      count: 1000,
      firstObservedRound: 1,
    });
    const evidenceRecords = backlog.rawFindings.map((rawFinding, index) => {
      const payload = {
        kind: 'file_quote' as const,
        path: `src/history/${String(index).padStart(4, '0')}.ts`,
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: `historical quote ${index}`,
        snapshotId: quote.snapshotId,
        claimIdentityHash: rawFinding.claimIdentityHash,
        fileHash: sha256(`historical-file-${index}`),
      };
      return {
        evidenceId: computeFileQuoteEvidenceRecordId(payload),
        ...payload,
      };
    });
    const evidenceIds = evidenceRecords.map((record) => record.evidenceId).sort();
    const aggregateFinding = {
      ...backlog.findings[0]!,
      rawFindingIds: backlog.rawFindings.map((rawFinding) => rawFinding.rawFindingId),
      evidenceIds,
    };
    const aggregateLedger = {
      ...backlog,
      findings: [aggregateFinding],
      evidenceRecords,
    };
    const compactView = buildManagerInputLedger(aggregateLedger, new Set()) as {
      findings: Array<{
        sourceBindings: {
          items: Array<{ rawFindingId: string }>;
          totalCount: number;
          fullSetDigest: string;
          truncated: boolean;
        };
        evidenceSummaries: {
          items: Array<{ evidenceId: string }>;
          totalCount: number;
          fullSetDigest: string;
          truncated: boolean;
        };
        locations: {
          items: string[];
          totalCount: number;
          fullSetDigest: string;
          truncated: boolean;
        };
      }>;
    };
    const compactFinding = compactView.findings[0]!;

    expect(compactFinding.sourceBindings).toMatchObject({
      totalCount: 1000,
      fullSetDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      truncated: true,
    });
    expect(compactFinding.sourceBindings.items).toHaveLength(16);
    expect(compactFinding.evidenceSummaries).toMatchObject({
      totalCount: 1000,
      fullSetDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      truncated: true,
    });
    expect(compactFinding.evidenceSummaries.items).toHaveLength(16);
    expect(compactFinding.locations).toMatchObject({
      totalCount: 1000,
      fullSetDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      truncated: true,
    });
    expect(compactFinding.locations.items).toHaveLength(16);
    expect(JSON.stringify(compactView).length).toBeLessThan(50_000);
    expect(buildManagerInputLedger(aggregateLedger, new Set())).toEqual(compactView);
    const reorderedView = buildManagerInputLedger({
      ...aggregateLedger,
      findings: [{
        ...aggregateFinding,
        rawFindingIds: [...aggregateFinding.rawFindingIds].reverse(),
        evidenceIds: [...aggregateFinding.evidenceIds].reverse(),
      }],
    }, new Set()) as typeof compactView;
    expect(reorderedView.findings[0]?.sourceBindings).toEqual(compactFinding.sourceBindings);
    expect(reorderedView.findings[0]?.evidenceSummaries).toEqual(compactFinding.evidenceSummaries);
    expect(reorderedView.findings[0]?.locations).toEqual(compactFinding.locations);

    const fullDetailView = buildManagerInputLedger(
      aggregateLedger,
      new Set([aggregateFinding.id]),
    ) as {
      findings: Array<{
        rawFindings: unknown[];
        evidenceDetails: unknown[];
        locations: string[];
      }>;
    };
    expect(fullDetailView.findings[0]?.rawFindings).toHaveLength(1000);
    expect(fullDetailView.findings[0]?.evidenceDetails).toHaveLength(1000);
    expect(fullDetailView.findings[0]?.locations).toHaveLength(1000);
  });

  it('expands quote text only for findings selected into the current batch', () => {
    const ledger = makeBacklog({
      count: 2,
      firstObservedRound: 1,
    });
    const evidenceRecords = ledger.rawFindings.map((rawFinding, index) => {
      const payload = {
        kind: 'file_quote' as const,
        path: `src/batch-${index}.ts`,
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: `batch-sensitive-quote-${index}`,
        snapshotId: quote.snapshotId,
        claimIdentityHash: rawFinding.claimIdentityHash,
        fileHash: sha256(`batch-file-${index}`),
      };
      return {
        evidenceId: computeFileQuoteEvidenceRecordId(payload),
        ...payload,
      };
    });
    const view = buildManagerInputLedger({
      ...ledger,
      evidenceRecords,
      findings: ledger.findings.map((finding, index) => ({
        ...finding,
        evidenceIds: [evidenceRecords[index]!.evidenceId],
      })),
    }, new Set([ledger.findings[0]!.id])) as {
      findings: Array<Record<string, unknown>>;
    };

    expect(view.findings[0]).toHaveProperty(
      'evidenceDetails.0.verbatimExcerpt',
      'batch-sensitive-quote-0',
    );
    expect(view.findings[1]).not.toHaveProperty('evidenceDetails');
    expect(view.findings[1]).toHaveProperty('evidenceSummaries.items.0.path', 'src/batch-1.ts');
    expect(JSON.stringify(view.findings[1])).not.toContain('batch-sensitive-quote-1');
  });

  it('checks every nested evidence item instead of only the first quote', () => {
    const violation = findRawFieldLimitViolation({
      title: 'bounded claim',
      evidence: [
        {
          kind: 'file_quote',
          path: 'src/a.ts',
          verbatimExcerpt: 'ok',
          snapshotId: '1'.repeat(64),
        },
        {
          kind: 'file_quote',
          path: 'src/b.ts',
          verbatimExcerpt: 'x'.repeat(RAW_FINDING_LIMITS.maxVerbatimExcerptChars + 1),
          snapshotId: '1'.repeat(64),
        },
      ],
    });

    expect(violation).toContain('evidence[1].verbatimExcerpt');
  });

  it('does not apply prompt content limits to issuer-created engine proof references', () => {
    expect(findRawFieldLimitViolation({
      evidence: [{
        kind: 'engine_proof',
        proofId: 'a'.repeat(RAW_FINDING_LIMITS.maxProofIdChars + 1),
      }],
    })).toBeUndefined();
    expect(findRawFieldLimitViolation({
      evidence: [{
        kind: 'engine_proof',
        proofId: 'a'.repeat(RAW_FINDING_LIMITS.maxProofIdChars),
      }],
    })).toBeUndefined();
  });

  it('uses a dedicated schema whose worst-case structured output stays within budget', () => {
    const properties = RawAdjudicationDecisionsJsonSchema.properties;
    const rawProperties = properties.rawDecisions.items.properties;
    const disabledDecisionKeys = [
      'disputeDecisions',
      'conflictDecisions',
      'invalidateDecisions',
      'duplicateDecisions',
      'dismissDecisions',
    ] as const;
    const worstCaseOutput = {
      rawDecisions: Array.from(
        { length: RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayCandidatesPerBatch },
        (_, index) => ({
          rawFindingId: `replay-${index.toString(16).padStart(64, '0')}`,
          decision: 'unsupported',
          findingId: 'F-9999',
          anchorRelevance: 'not_applicable',
          evidence: '\u0000'.repeat(rawProperties.evidence.maxLength),
        }),
      ),
      disputeDecisions: [],
      conflictDecisions: [],
      invalidateDecisions: [],
      duplicateDecisions: [],
      dismissDecisions: [],
    };

    expect(properties.rawDecisions.maxItems).toBe(
      RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayCandidatesPerBatch,
    );
    expect(rawProperties.rawFindingId.maxLength).toBeDefined();
    expect(rawProperties.findingId.maxLength).toBeDefined();
    expect(rawProperties.evidence.maxLength).toBeDefined();
    for (const key of disabledDecisionKeys) {
      expect(properties[key].maxItems).toBe(0);
    }
    expect(estimateTokens(JSON.stringify(worstCaseOutput))).toBeLessThanOrEqual(
      RAW_ADJUDICATION_RECOVERY_LIMITS.maxOutputTokensPerCall,
    );
  });

  it('keeps the replay rationale limit independent from reviewer finding payload limits', () => {
    const replayEvidenceLimit = RawAdjudicationDecisionsJsonSchema
      .properties.rawDecisions.items.properties.evidence.maxLength;

    expect(replayEvidenceLimit).toBe(52);
    expect(RAW_FINDING_LIMITS.maxDescriptionChars).toBeGreaterThan(replayEvidenceLimit);
    expect(findRawFieldLimitViolation({
      description: 'x'.repeat(replayEvidenceLimit + 1),
      evidence: [],
    })).toBeUndefined();
  });

  it('claims only the target limit and leaves overflow candidates unchanged', async () => {
    const initial = makeBacklog({ count: 70, firstObservedRound: 1 });
    const harness = makeHarness(initial);

    const reservation = await reserveRawAdjudicationRecovery(
      harness.store,
      observation,
      quote.snapshotId,
    );

    expect(reservation.result).toHaveLength(RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayTargetsPerStep);
    expect(reservation.result.at(-1)?.provisionalFindingId).toBe(findingId(64));
    expect(harness.current().findings.slice(64).map((finding) => finding.id))
      .toEqual(initial.findings.slice(64).map((finding) => finding.id));
    expect(harness.current().rawRecoveryAttempts).toHaveLength(64);
    expect(harness.current().rawRecoveryResults).toEqual([]);
  });

  it('splits replay candidates across calls whose prompts stay within count and input limits', async () => {
    const harness = makeHarness(makeBacklog({ count: 20, firstObservedRound: 1 }));
    executeAgentMock.mockImplementation(async (_persona, instruction) => managerResponse(instruction as string));

    const recovery = await harness.runRecovery();
    const instructions = executeAgentMock.mock.calls.map((call) => call[1] as string);

    expect(instructions).toHaveLength(2);
    expect(instructions.map((instruction) => rawBatchFromInstruction(instruction).length)).toEqual([16, 4]);
    expect(instructions.every((instruction) => (
      rawBatchFromInstruction(instruction).length
        <= RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayCandidatesPerBatch
      && estimateTokens(instruction) <= RAW_ADJUDICATION_RECOVERY_LIMITS.maxInputTokensPerCall
    ))).toBe(true);
    expect(recovery.origins).toHaveLength(20);
  });

  it('records an unsplittable single-item input overflow as a consumed failure', async () => {
    const harness = makeHarness(makeBacklog({
      count: 1,
      evidenceExcerptChars: RAW_FINDING_LIMITS.maxVerbatimExcerptChars,
      firstObservedRound: 1,
    }));

    const recovery = await harness.runRecovery();
    const committed = applyRecovery(harness, recovery);

    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(recovery.origins).toHaveLength(1);
    expect(harness.current().rawRecoveryAttempts).toHaveLength(1);
    expect([...recovery.failures.values()][0]).toMatchObject({
      kind: 'input_budget_exceeded',
      outcome: 'audit_only',
      reason: expect.stringContaining('per-call budget'),
    });
    expect(applyRawAdjudicationRecovery({
      freshLedger: harness.current(),
      recovery,
      runInput: harness.runInput,
      observation,
      reviewScopeSnapshotId: quote.snapshotId,
      reviewScopeSnapshot,
    }).rawFindingDispositions).toEqual([
      expect.objectContaining({ outcome: 'audit_only' }),
    ]);
    expect(rawRecoveryAttemptsFor(committed, findingId(1))).toHaveLength(1);
    expect(rawRecoveryResultsFor(committed, findingId(1))).toEqual([
      expect.objectContaining({ outcome: 'failed' }),
    ]);
    expect(committed.findings[0]?.revision).toBe(1);
  });

  it('replays an already completed failure idempotently without duplicating its attempt or result', async () => {
    const harness = makeHarness(makeBacklog({
      count: 1,
      evidenceExcerptChars: RAW_FINDING_LIMITS.maxVerbatimExcerptChars,
      firstObservedRound: 1,
    }));
    const recovery = await harness.runRecovery();
    const firstCommit = applyRecovery(harness, recovery);
    await harness.replaceLedger(() => firstCommit);

    const duplicateResult = applyRawAdjudicationRecovery({
      freshLedger: harness.current(),
      recovery,
      runInput: harness.runInput,
      observation,
      reviewScopeSnapshotId: quote.snapshotId,
      reviewScopeSnapshot,
    });
    const duplicateCommit = duplicateResult.ledger;

    expect(rawRecoveryAttemptsFor(duplicateCommit, findingId(1))).toHaveLength(1);
    expect(rawRecoveryResultsFor(duplicateCommit, findingId(1))).toHaveLength(1);
    expect(duplicateCommit.findings[0]?.revision).toBe(1);
    expect(duplicateResult.rawFindingDispositions).toEqual([
      expect.objectContaining({ outcome: 'audit_only' }),
    ]);
  });

  it('records source-missing failures without replay payload once per attempt until the bound', async () => {
    const backlog = makeBacklog({ count: 1, firstObservedRound: 1 });
    const harness = makeHarness({ ...backlog, rawFindings: [] });

    const firstRecovery = await harness.runRecovery();
    expect(firstRecovery.intake.items).toEqual([]);
    expect(firstRecovery.failures).toHaveLength(1);

    const firstResult = applyRawAdjudicationRecovery({
      freshLedger: harness.current(),
      recovery: firstRecovery,
      runInput: harness.runInput,
      observation,
      reviewScopeSnapshotId: quote.snapshotId,
      reviewScopeSnapshot,
    });
    const firstCommit = completeRawRecoveryAttempts(
      harness.current(),
      firstResult.ledger,
      firstRecovery.reservationTokens,
      new Map([...firstRecovery.origins].map(([rawFindingId, origin]) => [
        origin.attemptId,
        rawFindingId,
      ])),
      observation,
    );
    expect(firstResult.rawFindingDispositions).toEqual([
      expect.objectContaining({ outcome: 'audit_only' }),
    ]);
    expect(rawRecoveryAttemptsFor(firstCommit, findingId(1))).toEqual([
      expect.objectContaining({ attempt: 1 }),
    ]);
    await harness.replaceLedger(() => firstCommit);

    const duplicateCommit = applyRecovery(harness, firstRecovery);
    expect(duplicateCommit).toEqual(firstCommit);
    await harness.replaceLedger(() => duplicateCommit);

    const secondRecovery = await harness.runRecovery();
    const secondCommit = applyRecovery(harness, secondRecovery);
    const provisional = secondCommit.findings[0]?.provisional;

    expect(rawRecoveryAttemptsFor(secondCommit, findingId(1))
      .map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(classifyProvisionalRecovery(provisional!, 2, 2)).toBe('terminal-adjudication');
  });

  it('persists a source-missing finite outcome in the final manager report without synthesizing replay payload', async () => {
    const backlog = makeBacklog({ count: 1, firstObservedRound: 1 });
    const harness = makeHarness({ ...backlog, rawFindings: [] });

    await runFindingManagerForStep(harness.runInput);

    expect(harness.savedRawFindings.flat()).toEqual([]);
    expect(harness.savedReports.at(-1)?.rawFindingDispositions).toEqual([
      expect.objectContaining({
        outcome: 'audit_only',
        reason: expect.stringContaining('missing raw finding'),
      }),
    ]);
  });

  it('measures and sends the schema-appended fallback prompt without transforming it twice', async () => {
    const harness = makeHarness(makeBacklog({ count: 1, firstObservedRound: 1 }), { provider: 'cursor' });
    executeAgentMock.mockImplementation(async (_persona, instruction) => managerResponse(instruction as string));

    await harness.runRecovery();
    const instruction = executeAgentMock.mock.calls[0]?.[1] as string;

    expect(instruction).toContain('Return exactly one fenced JSON block that matches this JSON schema:');
    expect(instruction).toContain('"maxItems": 16');
    expect(instruction.match(/Return exactly one fenced JSON block/g)).toHaveLength(1);
    expect(estimateTokens(instruction)).toBeLessThanOrEqual(
      RAW_ADJUDICATION_RECOVERY_LIMITS.maxInputTokensPerCall,
    );
  });

  it('processes the target limit within call and step budgets without stray pending attempts', async () => {
    const backlog = makeBacklog({ count: 64, descriptionChars: 600, firstObservedRound: 1 });
    const harness = makeHarness({
      ...backlog,
      findings: backlog.findings.map((finding) => ({ ...finding, rawFindingIds: [] })),
    });
    executeAgentMock.mockImplementation(async (_persona, instruction) => managerResponse(instruction as string));

    const recovery = await harness.runRecovery();
    const committed = applyRecovery(harness, recovery);
    const instructions = executeAgentMock.mock.calls.map((call) => call[1] as string);
    const completedAttempts = committed.rawRecoveryResults;

    expect(executeAgentMock.mock.calls.length).toBeGreaterThan(0);
    expect(executeAgentMock.mock.calls.length).toBeLessThanOrEqual(
      RAW_ADJUDICATION_RECOVERY_LIMITS.maxManagerCallsPerStep,
    );
    expect(instructions.reduce((total, instruction) => total + estimateTokens(instruction), 0))
      .toBeLessThanOrEqual(RAW_ADJUDICATION_RECOVERY_LIMITS.maxInputTokensPerStep);
    expect(recovery.origins.size).toBe(64);
    expect(pendingRawRecoveryAttempts(committed)).toHaveLength(64 - recovery.origins.size);
    expect(completedAttempts).toHaveLength(recovery.origins.size);
    expect(committed.findings.filter((finding) => finding.provisional !== undefined)).toHaveLength(
      64,
    );
  });

  it('stops after the first provider exception and records only the sent batch', async () => {
    const harness = makeHarness(makeBacklog({ count: 20, firstObservedRound: 1 }));
    executeAgentMock.mockRejectedValueOnce(new Error('provider unavailable'));

    const recovery = await harness.runRecovery();
    const committed = applyRecovery(harness, recovery);

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(recovery.origins).toHaveLength(16);
    expect(applyRawAdjudicationRecovery({
      freshLedger: harness.current(),
      recovery,
      runInput: harness.runInput,
      observation,
      reviewScopeSnapshotId: quote.snapshotId,
      reviewScopeSnapshot,
    }).rawFindingDispositions).toHaveLength(16);
    expect(committed.rawRecoveryResults).toHaveLength(16);
    expect(pendingRawRecoveryAttempts(committed)).toHaveLength(4);
    expect(committed.rawRecoveryResults.every((result) => result.outcome === 'failed')).toBe(true);
  });

  it('settles mechanical replay outcomes without adding failure attempts when a residual call fails', async () => {
    const targetRaw = sourceRaw(9000);
    const target: FindingLedgerEntry = {
      ...provisionalFinding({ index: 9000, source: targetRaw, firstObservedRound: 1 }),
      provisional: undefined,
    };
    const targetSnapshot: FindingLedger = {
      ...makeBacklog({ count: 0, firstObservedRound: 1 }),
      nextId: 9001,
      rawFindings: [targetRaw],
      findings: [target],
    };
    const mechanicalSource = stampTargetRaw(
      sourceRaw(1),
      'persists',
      target.id,
      targetSnapshot,
    );
    const residualSource = sourceRaw(2);
    const current: FindingLedger = {
      ...makeBacklog({ count: 0, firstObservedRound: 1 }),
      nextId: 9001,
      rawFindings: [targetRaw, mechanicalSource, residualSource],
      findings: [
        target,
        provisionalFinding({ index: 1, source: mechanicalSource, firstObservedRound: 1 }),
        provisionalFinding({ index: 2, source: residualSource, firstObservedRound: 1 }),
      ],
    };
    const harness = makeHarness(current);
    executeAgentMock.mockRejectedValueOnce(new Error('provider unavailable'));

    const recovery = await harness.runRecovery();
    const committed = applyRecovery(harness, recovery);
    const mechanicalOrigin = committed.findings.find((finding) => finding.id === findingId(1));
    const residualOrigin = committed.findings.find((finding) => finding.id === findingId(2));

    expect(recovery.output.matches.some((match) => match.findingId === target.id)).toBe(true);
    expect(mechanicalOrigin?.status).toBe('open');
    expect(mechanicalOrigin?.provisional).toBeDefined();
    expect(rawRecoveryResultsFor(committed, mechanicalOrigin!.id)).toEqual([
      expect.objectContaining({ outcome: 'failed', mutationIds: [] }),
    ]);
    expect(rawRecoveryResultsFor(committed, residualOrigin!.id)).toEqual([
      expect.objectContaining({ outcome: 'failed' }),
    ]);
  });

  it('classifies an explicit replay-manager unsupported decision as unsupported in both recovery audit views', async () => {
    const targetSource = sourceRaw(9000);
    const target: FindingLedgerEntry = {
      ...provisionalFinding({ index: 9000, source: targetSource, firstObservedRound: 1 }),
      status: 'resolved',
      lifecycle: 'resolved',
      revision: 2,
      provisional: undefined,
    };
    const targetSnapshot: FindingLedger = {
      ...makeBacklog({ count: 0, firstObservedRound: 1 }),
      nextId: 9001,
      rawFindings: [targetSource],
      findings: [target],
    };
    const replaySource = stampTargetRaw(
      sourceRaw(1),
      'reopened',
      target.id,
      targetSnapshot,
    );
    const current: FindingLedger = {
      ...makeBacklog({ count: 0, firstObservedRound: 1 }),
      nextId: 9001,
      rawFindings: [targetSource, replaySource],
      findings: [
        target,
        provisionalFinding({ index: 1, source: replaySource, firstObservedRound: 1 }),
      ],
    };
    const harness = makeHarness(current);
    const evidence = 'The replay evidence does not support the referenced target.';
    executeAgentMock.mockImplementationOnce(async (_persona, instruction) => {
      const [replayRaw] = rawBatchFromInstruction(instruction as string);
      return {
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [{
            rawFindingId: replayRaw!.rawFindingId,
            decision: 'unsupported',
            findingId: '',
            anchorRelevance: 'not_applicable',
            evidence,
          }],
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
        },
      } as unknown as AgentResponse;
    });

    const recovery = await harness.runRecovery();
    const [replayRawFindingId] = recovery.origins.keys();
    const committed = applyRawAdjudicationRecovery({
      freshLedger: harness.current(),
      recovery,
      runInput: harness.runInput,
      observation,
      reviewScopeSnapshotId: quote.snapshotId,
      reviewScopeSnapshot,
    });

    expect(recovery.failures.get(replayRawFindingId!)).toEqual({
      kind: 'manager_unsupported',
      outcome: 'unsupported',
      reason: evidence,
    });
    expect(recovery.unsupportedRawFindingReports).toEqual([{
      rawFindingId: replayRawFindingId,
      targetFindingId: target.id,
      evidence,
    }]);
    expect(committed.rawFindingDispositions).toEqual([{
      rawFindingId: replayRawFindingId,
      outcome: 'unsupported',
      reason: evidence,
    }]);
  });

  it.each(['oversized-output', 'whole-output-discard'] as const)(
    'limits %s failure to the sent batch and leaves later backlog untouched',
    async (failureKind) => {
      const harness = makeHarness(makeBacklog({ count: 20, firstObservedRound: 1 }));
      if (failureKind === 'oversized-output') {
        executeAgentMock.mockImplementationOnce(async (_persona, instruction) => (
          managerResponse(instruction as string, 'x'.repeat(9_000))
        ));
      } else {
        let validationCall = 0;
        validateManagerOutputMock.mockImplementation((...args) => {
          validationCall += 1;
          return validationCall === 2
            ? { ok: false, errors: ['synthetic whole-output discard'] }
            : actualValidationModule.validateFindingManagerOutput(...args);
        });
        executeAgentMock.mockImplementationOnce(async (_persona, instruction) => (
          managerResponse(instruction as string)
        ));
      }

      const recovery = await harness.runRecovery();
      const committed = applyRecovery(harness, recovery);

      expect(executeAgentMock).toHaveBeenCalledTimes(1);
      expect(recovery.origins).toHaveLength(16);
      expect(committed.rawRecoveryResults).toHaveLength(16);
      expect(pendingRawRecoveryAttempts(committed)).toHaveLength(4);
    },
  );

  it('stops after discarding a resolution-confirmation-only batch and releases the remaining queue', async () => {
    const targetSource = sourceRaw(9000);
    const target: FindingLedgerEntry = {
      ...provisionalFinding({ index: 9000, source: targetSource, firstObservedRound: 1 }),
      provisional: undefined,
    };
    const targetSnapshot: FindingLedger = {
      ...makeBacklog({ count: 0, firstObservedRound: 1 }),
      nextId: 9001,
      rawFindings: [targetSource],
      findings: [target],
    };
    const confirmations = Array.from({ length: 20 }, (_, offset): RawFinding => (
      stampTargetRaw({
        ...sourceRaw(offset + 1),
        rawFindingId: `confirmation-${offset + 1}`,
      }, 'resolution_confirmation', target.id, targetSnapshot)
    ));
    const harness = makeHarness({
      ...makeBacklog({ count: 0, firstObservedRound: 1 }),
      nextId: 9001,
      rawFindings: [targetSource, ...confirmations],
      findings: [
        target,
        ...confirmations.map((source, offset) => provisionalFinding({
          index: offset + 1,
          source,
          firstObservedRound: 1,
        })),
      ],
    });
    classifyRawFindingsMechanicallyMock.mockImplementationOnce((input) => ({
      output: {
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
      },
      residualRawFindings: input.rawFindings,
    }));
    let discardedFirstBatch = false;
    validateManagerOutputMock.mockImplementation((...args) => {
      if (!discardedFirstBatch && args[0].rawFindings.length === 16) {
        discardedFirstBatch = true;
        return { ok: false, errors: ['synthetic confirmation-only whole-output discard'] };
      }
      return actualValidationModule.validateFindingManagerOutput(...args);
    });
    executeAgentMock.mockImplementationOnce(async (_persona, instruction) => (
      managerResponse(instruction as string)
    ));

    const recovery = await harness.runRecovery();
    const committed = applyRecovery(harness, recovery);
    const replayed = committed.findings.filter((finding) => finding.id !== target.id).slice(0, 16);
    const untouched = committed.findings.filter((finding) => finding.id !== target.id).slice(16);

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(recovery.origins).toHaveLength(16);
    expect(committed.rawRecoveryResults).toHaveLength(16);
    expect(pendingRawRecoveryAttempts(committed)).toHaveLength(4);
    expect(replayed).toHaveLength(16);
    expect(untouched).toHaveLength(4);
  });

  it('normalizes same-identity new decisions once across the batch boundary', async () => {
    const backlog = makeBacklog({ count: 17, firstObservedRound: 1 });
    const firstDuplicateSource = backlog.rawFindings[15]!;
    const {
      targetIdentityHash: _targetIdentityHash,
      claimIdentityHash: _claimIdentityHash,
      candidateIdentityHash: _candidateIdentityHash,
      target,
      sourceBinding,
      ...secondDuplicateBase
    } = backlog.rawFindings[16]!;
    const secondDuplicateSource = canonicalRawFindingFixture({
      ...secondDuplicateBase,
      target,
      sourceBinding,
      title: firstDuplicateSource.title,
      description: firstDuplicateSource.description,
      suggestion: firstDuplicateSource.suggestion,
    });
    const harness = makeHarness({
      ...backlog,
      rawFindings: [...backlog.rawFindings.slice(0, 16), secondDuplicateSource],
      findings: backlog.findings.map((finding, index) => {
        if (index < 15) {
          return finding;
        }
        const source = index === 15 ? firstDuplicateSource : secondDuplicateSource;
        return {
          ...provisionalFinding({
            index: index + 1,
            source,
            firstObservedRound: index === 15 ? 2 : 1,
          }),
          title: `Provisional origin ${index + 1}`,
          description: `Distinct provisional origin ${index + 1}`,
        };
      }),
    });
    executeAgentMock.mockImplementation(async (_persona, instruction) => managerResponse(instruction as string));

    const recovery = await harness.runRecovery();
    const duplicateReplayIds = new Set([...recovery.origins]
      .filter(([, origin]) => origin.provisionalFindingId === findingId(16)
        || origin.provisionalFindingId === findingId(17))
      .map(([rawFindingId]) => rawFindingId));
    const grouped = recovery.output.matches.find((finding) => (
      finding.rawFindingIds.filter((rawFindingId) => duplicateReplayIds.has(rawFindingId)).length === 2
    ));
    const committed = applyRecovery(harness, recovery);

    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    expect(grouped?.rawFindingIds).toEqual(expect.arrayContaining([...duplicateReplayIds]));
    const canonicalOrigin = committed.findings.find((finding) => finding.id === findingId(16));
    const settledOrigin = committed.findings.find((finding) => finding.id === findingId(17));
    const normalFindingsForIdentity = committed.findings.filter((finding) => (
      finding.provisional === undefined
      && finding.rawFindingIds.some((rawFindingId) => duplicateReplayIds.has(rawFindingId))
    ));

    expect(normalFindingsForIdentity).toEqual([]);
    expect(canonicalOrigin?.status).toBe('open');
    expect(canonicalOrigin?.rawFindingIds).toEqual(expect.arrayContaining([...duplicateReplayIds]));
    expect(canonicalOrigin?.provisional).toBeDefined();
    expect(settledOrigin?.status).toBe('open');
    expect(settledOrigin?.provisional).toBeDefined();
    expect(rawRecoveryResultsFor(committed, settledOrigin!.id)).toEqual([
      expect.objectContaining({ outcome: 'failed', mutationIds: [] }),
    ]);
  });

  it('keeps never-selected findings replayable after two rounds and advances only twice-failed findings', async () => {
    const old = makeBacklog({ count: 70, firstObservedRound: 1 });
    const newer = makeBacklog({ count: 10, firstObservedRound: 2, startIndex: 71 });
    const harness = makeHarness({
      ...old,
      nextId: 82,
      rawFindings: [...old.rawFindings, ...newer.rawFindings],
      findings: [...old.findings, ...newer.findings],
    });
    const first = await reserveRawAdjudicationRecovery(
      harness.store,
      observation,
      quote.snapshotId,
    );
    await harness.replaceLedger((ledger) => appendFailedRawRecoveryResults(
      ledger,
      new Set(first.result.map((reservation) => reservation.attemptId)),
    ));
    const second = await reserveRawAdjudicationRecovery(
      harness.store,
      observation,
      quote.snapshotId,
    );
    await harness.replaceLedger((ledger) => appendFailedRawRecoveryResults(
      ledger,
      new Set(second.result.map((reservation) => reservation.attemptId)),
    ));

    const twiceFailed = harness.current().findings.filter(
      (finding) => rawRecoveryAttemptsFor(harness.current(), finding.id).length === 2,
    );
    const neverSelected = harness.current().findings.filter((finding) => Number(finding.id.slice(2)) > 70);
    expect(twiceFailed.length).toBeGreaterThan(0);
    expect(twiceFailed.every((finding) => (
      classifyProvisionalRecovery(finding.provisional!, 2, 2) === 'terminal-adjudication'
    ))).toBe(true);
    expect(neverSelected.every((finding) => (
      rawRecoveryAttemptsFor(harness.current(), finding.id).length === 1
      && classifyProvisionalRecovery(finding.provisional!, 2, 1) === 'raw-adjudication'
    ))).toBe(true);
  });

  it('reuses the same durable pending reservations across serialized concurrent callers', async () => {
    const harness = makeHarness(makeBacklog({ count: 100, firstObservedRound: 1 }));

    const [left, right] = await Promise.all([
      reserveRawAdjudicationRecovery(harness.store, observation, quote.snapshotId),
      reserveRawAdjudicationRecovery(harness.store, observation, quote.snapshotId),
    ]);
    const leftTokens = new Set(left.result.map((reservation) => reservation.reservationToken));
    const rightTokens = new Set(right.result.map((reservation) => reservation.reservationToken));

    expect(left.result.length).toBeLessThanOrEqual(RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayTargetsPerStep);
    expect(right.result.length).toBeLessThanOrEqual(RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayTargetsPerStep);
    expect(rightTokens).toEqual(leftTokens);
    expect(right.result.map((reservation) => reservation.provisionalFindingId))
      .toEqual(left.result.map((reservation) => reservation.provisionalFindingId));
    expect(harness.current().rawRecoveryAttempts).toHaveLength(
      RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayTargetsPerStep,
    );
  });

  it('rejects a stale full lifecycle head at commit and closes its durable attempt', async () => {
    const harness = makeHarness(makeBacklog({ count: 1, firstObservedRound: 1 }));
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      await harness.replaceLedger((ledger) => advanceFindingFixture(ledger, findingId(1)));
      return managerResponse(instruction as string);
    });

    const result = await runFindingManagerForStep(harness.runInput);
    const origin = result.ledger.findings.find((finding) => finding.id === findingId(1));

    expect(origin?.revision).toBe(2);
    expect(result.ledger.findings.some((finding) => finding.id !== findingId(1))).toBe(false);
    expect(rawRecoveryResultsFor(result.ledger, findingId(1))).toEqual([
      expect.objectContaining({ outcome: 'stale' }),
    ]);
  });

  it('rejects every replay entry that mixes a stale raw with a fresh raw across all landing arrays', async () => {
    const targetSources = Array.from({ length: 4 }, (_, offset) => sourceRaw(9000 + offset));
    const targets: FindingLedgerEntry[] = targetSources.map((source, offset) => ({
      ...provisionalFinding({ index: 9000 + offset, source, firstObservedRound: 1 }),
      status: offset === 3 ? 'resolved' : 'open',
      lifecycle: offset === 3 ? 'resolved' : 'new',
      revision: offset === 3 ? 2 : 1,
      provisional: undefined,
      ...(offset === 3
        ? { resolvedAt: observation.timestamp, resolvedEvidence: 'Previously fixed.' }
        : {}),
    }));
    const targetSnapshot: FindingLedger = {
      workflowName: 'peer-review',
      nextId: 9004,
      updatedAt: observation.timestamp,
      evidenceRecords: [],
      evidenceBindings: [],
      lifecycleReservations: [],
      lifecycleEvents: [],
      rawRecoveryAttempts: [],
      rawRecoveryResults: [],
      rawFindings: targetSources,
      conflicts: [],
      interpretations: [],
      findings: targets,
    };
    const actionSources: RawFinding[] = [
      sourceRaw(1),
      sourceRaw(2),
      stampTargetRaw(sourceRaw(3), 'persists', targets[0]!.id, targetSnapshot),
      stampTargetRaw(sourceRaw(4), 'persists', targets[0]!.id, targetSnapshot),
      stampTargetRaw(sourceRaw(5), 'resolution_confirmation', targets[1]!.id, targetSnapshot),
      stampTargetRaw(sourceRaw(6), 'resolution_confirmation', targets[1]!.id, targetSnapshot),
      stampTargetRaw(sourceRaw(7), 'reopened', targets[3]!.id, targetSnapshot),
      stampTargetRaw(sourceRaw(8), 'reopened', targets[3]!.id, targetSnapshot),
      sourceRaw(9),
      sourceRaw(10),
    ];
    const processes = actionSources.map((source, offset) => provisionalFinding({
      index: offset + 1,
      source,
      firstObservedRound: 1,
    }));
    const originalLedger: FindingLedger = {
      workflowName: 'peer-review',
      nextId: 9010,
      updatedAt: observation.timestamp,
      evidenceRecords: [],
      evidenceBindings: [],
      lifecycleReservations: [],
      lifecycleEvents: [],
      rawRecoveryAttempts: [],
      rawRecoveryResults: [],
      rawFindings: [...targetSources, ...actionSources],
      conflicts: [],
      interpretations: [],
      findings: [...processes, ...targets],
    };
    const replayItems = actionSources.map((source, offset) => {
      const replaySource = { ...source, rawFindingId: `replay-mixed-${offset + 1}` };
      const canonical = canonicalizeReviewerRawFinding(
        candidateFromStoredRawFinding(replaySource, 'reviewer-stable-a'),
        { ledger: originalLedger },
      ).canonical;
      return { canonical, wire: toLedgerRawFinding(canonical) };
    });
    const pairRawIds = (pairIndex: number): [string, string] => [
      replayItems[pairIndex * 2]!.wire.rawFindingId,
      replayItems[pairIndex * 2 + 1]!.wire.rawFindingId,
    ];
    const harness = makeHarness(originalLedger);
    const reservation = await reserveRawAdjudicationRecovery(
      harness.store,
      observation,
      quote.snapshotId,
    );
    const authorizedOriginalLedger = harness.current();
    const freshLedger = processes.reduce((ledger, process, processIndex) => (
      processIndex % 2 === 0
        ? advanceFindingFixture(ledger, process.id)
        : ledger
    ), authorizedOriginalLedger);
    const reservationByFindingId = new Map(reservation.result.map((item) => [
      item.provisionalFindingId,
      item,
    ]));
    const origins = new Map(replayItems.map((item, offset) => {
      const process = processes[offset]!;
      const reserved = reservationByFindingId.get(process.id);
      if (reserved === undefined) {
        throw new Error(`Missing raw recovery reservation for "${process.id}"`);
      }
      return [item.wire.rawFindingId, {
        attemptId: reserved.attemptId,
        provisionalFindingId: process.id,
        sourceRawFindingId: actionSources[offset]!.rawFindingId,
        expectedHead: reserved.expectedHead,
        expectedProvisionalRevision: process.revision,
        attempt: 1,
        recoveryOrigin: snapshotProvisionalRecoveryOrigin({
          ...process,
          provisional: process.provisional!,
        }),
      }] as const;
    }));
    const anchorAdjudications = [
      ...pairRawIds(0).map((rawFindingId) => createAnchorAdjudication({
        rawFindingId,
        decision: 'new',
        anchorRelevance: 'not_applicable',
        evidence: actionSources[0]!.title!,
      })),
      ...pairRawIds(1).map((rawFindingId) => createAnchorAdjudication({
        rawFindingId,
        decision: 'same',
        findingId: targets[0]!.id,
        anchorRelevance: 'not_applicable',
        evidence: 'The issue persists.',
      })),
      ...pairRawIds(2).map((rawFindingId) => createAnchorAdjudication({
        rawFindingId,
        decision: 'resolved',
        findingId: targets[1]!.id,
        anchorRelevance: 'not_applicable',
        evidence: 'The issue is fixed.',
      })),
      ...pairRawIds(3).map((rawFindingId) => createAnchorAdjudication({
        rawFindingId,
        decision: 'reopened',
        findingId: targets[3]!.id,
        anchorRelevance: 'not_applicable',
        evidence: 'The issue recurred.',
      })),
      ...pairRawIds(4).map((rawFindingId) => createAnchorAdjudication({
        rawFindingId,
        decision: 'conflict',
        findingId: targets[2]!.id,
        anchorRelevance: 'not_applicable',
        evidence: 'The evidence conflicts with the existing finding.',
      })),
    ];
    const output = {
      anchorAdjudications,
      matches: [{
        findingId: targets[0]!.id,
        rawFindingIds: pairRawIds(1),
        evidence: 'The issue persists.',
      }],
      newFindings: [{
        rawFindingIds: pairRawIds(0),
        title: actionSources[0]!.title,
        severity: actionSources[0]!.severity,
      }],
      resolvedFindings: [{
        findingId: targets[1]!.id,
        rawFindingIds: pairRawIds(2),
        evidence: 'The issue is fixed.',
      }],
      reopenedFindings: [{
        findingId: targets[3]!.id,
        rawFindingIds: pairRawIds(3),
        evidence: 'The issue recurred.',
      }],
      conflicts: [{
        findingIds: [targets[2]!.id],
        rawFindingIds: pairRawIds(4),
        description: 'The evidence conflicts with the existing finding.',
      }],
      resolvedConflicts: [],
      waivedFindings: [],
      disputeNotes: [],
      invalidatedFindings: [],
      duplicateFindings: [],
      dismissedFindings: [],
    };

    const committed = applyRawAdjudicationRecovery({
      freshLedger,
      recovery: {
        intake: {
          entityBindings: new Map(),
          items: replayItems,
          overflowRawFindingIds: new Set(),
          intakeProvisionalSpecs: [],
          intakeAnomalySpecs: [],
          overflowReports: [],
          clarifications: [],
          rawNormalizations: [],
          healthyReviewerStableKeys: new Set(),
        },
        output,
        origins,
        failures: new Map(),
        capturedPreconditions: captureFindingPreconditions(authorizedOriginalLedger),
        invalidAttempts: [],
        unsupportedRawFindingReports: [],
        cleanWireById: new Map(),
        cleanCanonicalById: new Map(),
        reservationTokens: new Set(),
      },
      runInput: harness.runInput,
      observation,
      reviewScopeSnapshotId: quote.snapshotId,
      reviewScopeSnapshot,
    });

    expect(committed.ledger.conflicts).toEqual([]);
    expect(committed.ledger.findings).toHaveLength(originalLedger.findings.length);
    for (const target of targets) {
      expect(committed.ledger.findings.find((finding) => finding.id === target.id))
        .toEqual(freshLedger.findings.find((finding) => finding.id === target.id));
    }
    for (const process of processes) {
      expect(committed.ledger.findings.find((finding) => finding.id === process.id)).toMatchObject({
        status: 'open',
        lifecycle: 'new',
        provisional: expect.objectContaining({ stableKey: process.provisional!.stableKey }),
      });
    }
    expect(committed.ledger.findings.filter((finding) => (
      processes.some((process) => process.id === finding.id)
    )).every((finding) => finding.provisional !== undefined)).toBe(true);
  });

  it('orders fewer attempts first, then older cohorts, observation time, and finding id', async () => {
    const sources = Array.from({ length: 7 }, (_, offset) => sourceRaw(offset + 1));
    const findings = [
      provisionalFinding({ index: 1, source: sources[0]!, firstObservedRound: 2 }),
      provisionalFinding({ index: 2, source: sources[1]!, firstObservedRound: 1 }),
      provisionalFinding({ index: 3, source: sources[2]!, firstObservedRound: 1 }),
      provisionalFinding({ index: 4, source: sources[3]!, firstObservedRound: 1 }),
      provisionalFinding({
        index: 5,
        source: sources[4]!,
        firstObservedRound: 1,
        firstObservedAt: '2026-07-19T00:00:00.000Z',
      }),
      provisionalFinding({
        index: 6,
        source: sources[5]!,
        firstObservedRound: 1,
        firstObservedAt: '2026-07-19T00:00:00.000Z',
      }),
      provisionalFinding({ index: 7, source: sources[6]!, firstObservedRound: 1 }),
    ];
    const harness = makeHarness({
      ...makeBacklog({ count: 0, firstObservedRound: 1 }),
      nextId: 8,
      rawFindings: sources,
      findings,
    });
    await harness.replaceLedger((ledger) => appendFailedRawRecoveryAttempt(
      appendFailedRawRecoveryAttempt(ledger, findingId(2)),
      findingId(5),
    ));

    const reservation = await reserveRawAdjudicationRecovery(
      harness.store,
      observation,
      quote.snapshotId,
    );

    expect(reservation.result.map((item) => item.provisionalFindingId)).toEqual([
      findingId(6),
      findingId(3),
      findingId(4),
      findingId(7),
      findingId(1),
      findingId(5),
      findingId(2),
    ]);
  });
});
