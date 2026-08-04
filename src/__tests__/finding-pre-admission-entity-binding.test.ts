import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentResponse,
  AgentWorkflowStep,
  FindingContractConfig,
  WorkflowStep,
} from '../core/models/types.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingProvisionalClaimBindingAuthorization,
  FindingTarget,
  RawFinding,
} from '../core/workflow/findings/types.js';
import type { RunFindingManagerForStepInput } from '../core/workflow/findings/manager-contracts.js';
import {
  evaluateRawAdmission,
  type ReviewerIntakeResult,
} from '../core/workflow/findings/manager-admission.js';
import { bindPreAdmissionEntities } from '../core/workflow/findings/pre-admission-entity-binding.js';
import { entityBindingDigest } from '../core/workflow/findings/pre-admission-entity-binding-identity.js';
import {
  applyPreAdmissionEntityProvisionalMutationsToLedger,
  type ProvisionalFindingSpec,
} from '../core/workflow/findings/reconciler.js';
import { reconcileCommitPlan } from '../core/workflow/findings/manager-commit-finalization.js';
import { createEmptyManagerOutput } from '../core/workflow/findings/manager-output.js';
import { applyRejectedObservationAttachments } from '../core/workflow/findings/manager-provisional-settlement.js';
import {
  candidateFromStoredRawFinding,
  canonicalizeReviewerRawFinding,
  computeLineageKey,
  computeReviewerStableKey,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import { captureFindingPreconditions } from '../core/workflow/findings/finding-preconditions.js';
import { createAnchorAdjudication } from '../core/models/finding-anchor-relevance.js';
import {
  provisionalClaimBindingAuthorizationReference,
} from '../core/models/finding-provisional-claim-authorization.js';
import type { ReviewScopeProofSnapshot } from '../core/workflow/findings/snapshot.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
  emptyFindingAuthorityProjection,
  rawCanonicalSnapshotFixture,
} from './helpers/finding-lifecycle-fixture.js';
import { storedRawReconcileProvenance } from './helpers/finding-integrity.js';
import { MAIN_MANAGER_INPUT_MAX_BYTES } from '../core/workflow/findings/manager-task-contracts.js';
import { issueManagerLifecycleAuthority } from '../core/workflow/findings/manager-lifecycle-authority.js';
import {
  assembleAndApplyManagerLifecycleTransactions,
} from '../core/workflow/findings/manager-lifecycle-assembly.js';

vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: vi.fn() }));

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

const contract: FindingContractConfig = {
  manager: {
    persona: 'findings-manager',
    instruction: 'Reconcile only the supplied task.',
    outputContract: 'Return structured JSON.',
  },
};

const managerStep: AgentWorkflowStep = {
  kind: 'agent',
  name: 'findings-manager',
  persona: 'findings-manager',
  edit: false,
};

const reviewScopeSnapshot: ReviewScopeProofSnapshot = {
  reviewScopeSnapshotId: 'scope-snapshot',
  trackedDiff: undefined,
  untrackedEvidence: [],
  queryInventory: [],
};

function runInput(options: Record<string, unknown> = {}) {
  return {
    optionsBuilder: {
      buildAgentOptions: () => options,
    },
    stepExecutor: {
      buildPhase1Instruction: (instruction: string) => instruction,
      normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
      recordSynthesizedAgentUsage: () => {},
    },
  } as Pick<RunFindingManagerForStepInput, 'optionsBuilder' | 'stepExecutor'>;
}

function emptyLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  const ledger = {
    workflowName: 'entity-binding',
    nextId: 1,
    updatedAt: '2026-07-30T00:00:00.000Z',
    findings: [],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawFindings: [],
    conflicts: [],
    ...emptyFindingAuthorityProjection(),
    ...overrides,
  };
  return {
    ...ledger,
    rawCanonicalSnapshots: overrides.rawCanonicalSnapshots
      ?? ledger.rawFindings.map((raw) => rawCanonicalSnapshotFixture(raw, {
        runId: 'run-0',
        stepName: 'reviewers',
        timestamp: ledger.updatedAt,
      })),
  };
}

function rawFinding(input: {
  rawFindingId: string;
  reviewer?: string;
  title: string;
  description: string;
  target?: FindingTarget;
}): RawFinding {
  const reviewer = input.reviewer ?? 'reviewer';
  return canonicalRawFindingFixture({
    rawFindingId: input.rawFindingId,
    stepName: reviewer,
    reviewer,
    target: input.target ?? { kind: 'code', paths: ['src/shared.ts'] },
    familyTag: 'correctness',
    severity: 'high',
    title: input.title,
    description: input.description,
    suggestion: 'Fix the defect.',
    relation: 'new',
    targetFindingId: null,
    evidence: [],
  });
}

function intakeFor(ledger: FindingLedger, raws: readonly RawFinding[]): ReviewerIntakeResult {
  return {
    items: raws.map((raw, index) => {
      const canonical = canonicalizeReviewerRawFinding(
        candidateFromStoredRawFinding(raw, `reviewer-stable-${index}`),
        { ledger },
      ).canonical;
      return { canonical, wire: toLedgerRawFinding(canonical) };
    }),
    entityBindings: new Map(),
    overflowRawFindingIds: new Set(),
    intakeProvisionalSpecs: [],
    intakeAnomalySpecs: [],
    overflowReports: [],
    clarifications: [],
    rawNormalizations: [],
    healthyReviewerStableKeys: new Set(),
  };
}

function sectionJson<T>(instruction: string, heading: string): T {
  const start = instruction.indexOf(`${heading}\n`);
  const rest = instruction.slice(start + heading.length + 1);
  const match = /^(`{3,})json\n([\s\S]*?)\n\1/m.exec(rest);
  if (start < 0 || match?.[2] === undefined) {
    throw new Error(`Missing JSON block after ${heading}`);
  }
  return JSON.parse(match[2]) as T;
}

function response(structuredOutput: Record<string, unknown>): AgentResponse {
  return {
    persona: 'findings-manager',
    status: 'done',
    content: '',
    timestamp: new Date('2026-07-30T00:00:00.000Z'),
    structuredOutput,
  };
}

function mockGroupedDecision(
  groupForRaw: (rawFindingId: string, owned: string[]) => {
    decision: 'bind_existing' | 'new_entity' | 'ambiguous';
    findingId?: string;
    groupRawFindingId?: string;
  },
): void {
  executeAgentMock.mockImplementation(async (_persona, instruction) => {
    const manifest = sectionJson<{
      taskId: string;
      ownedRawFindingIds: string[];
    }>(instruction, '## Task manifest');
    return response({
      taskId: manifest.taskId,
      decisions: manifest.ownedRawFindingIds.map((rawFindingId) => {
        const planned = groupForRaw(rawFindingId, manifest.ownedRawFindingIds);
        return {
          rawFindingId,
          decision: planned.decision,
          findingId: planned.findingId ?? '',
          groupRawFindingId: planned.groupRawFindingId ?? '',
          reason: 'Semantic entity classification.',
        };
      }),
    });
  });
}

async function bind(input: {
  ledger: FindingLedger;
  intake: ReviewerIntakeResult;
  roundMarker?: string;
  options?: Record<string, unknown>;
}) {
  return bindPreAdmissionEntities({
    contract,
    previousLedger: input.ledger,
    intake: input.intake,
    managerStep,
    roundMarker: input.roundMarker ?? 'round-1',
    runInput: runInput(input.options),
  });
}

function evaluate(ledger: FindingLedger, intake: ReviewerIntakeResult) {
  return evaluateRawAdmission({
    cwd: process.cwd(),
    reviewScopeSnapshotId: reviewScopeSnapshot.reviewScopeSnapshotId,
    runId: 'run-1',
    scopeIdentity: 'scope',
    previousLedger: ledger,
    intake,
    reviewScopeSnapshot,
    workflowTask: 'Review the project.',
  });
}

function applyMutations(
  ledger: FindingLedger,
  intake: ReviewerIntakeResult,
): FindingLedger {
  const evaluation = evaluate(ledger, intake);
  const applied = applyPreAdmissionEntityProvisionalMutationsToLedger(
    ledger,
    evaluation.preAdmissionEntityMutations,
    {
      workflowName: ledger.workflowName,
      stepName: 'reviewers',
      runId: 'run-1',
      timestamp: '2026-07-30T00:00:00.000Z',
    },
  );
  return {
    ...applied,
    rawFindings: [
      ...ledger.rawFindings,
      ...intake.items.map((item) => item.wire),
    ],
  };
}

function reconcileEntityCommit(input: {
  ledger: FindingLedger;
  rawFindings: RawFinding[];
  managerOutput?: ReturnType<typeof createEmptyManagerOutput>;
  mutations: ReturnType<typeof evaluate>['preAdmissionEntityMutations'];
  provisionalSpecs?: ProvisionalFindingSpec[];
  cleanWire?: RawFinding[];
}) {
  const timestamp = '2026-07-30T00:00:00.000Z';
  return reconcileCommitPlan({
    runInput: {
      workflowName: input.ledger.workflowName,
      callNamespace: '',
      cwd: process.cwd(),
      runId: 'run-1',
      timestamp,
      parentStep: managerStep,
    } as never,
    freshLedger: input.ledger,
    rawFindings: input.rawFindings,
    managerOutput: input.managerOutput ?? createEmptyManagerOutput(),
    provisionalSpecs: input.provisionalSpecs ?? [],
    entityProvisionalMutations: input.mutations,
    anomalySpecs: [],
    pendingRejectedObservations: [],
    rawProvenanceByRawFindingId: new Map(input.rawFindings.map((raw) => {
      const reviewerStableKey = computeReviewerStableKey({
        workflowName: input.ledger.workflowName,
        callNamespace: '',
        parentStepName: managerStep.name,
        reviewerPersonaKey: raw.reviewer,
      });
      return [raw.rawFindingId, storedRawReconcileProvenance(
        raw,
        reviewerStableKey,
        computeLineageKey({
          claimIdentityHash: raw.claimIdentityHash,
          ...(raw.targetFindingId === null
            ? {}
            : { targetFindingId: raw.targetFindingId }),
        }),
      )] as const;
    })),
    cleanWire: input.cleanWire ?? [],
    explicitResolvedByMapping: new Map(),
    explicitPromotedFindingIds: new Set(),
    recoveryProvisionalRawFindingIds: new Set(),
    staleRawFindingIds: new Set(),
    deferredRawFindingIds: new Set(),
    resolutionRenotifications: [],
    unsupportedRawFindingReports: [],
    healthyReviewerStableKeys: new Set(),
    verifiedEvidenceRecordsByRawFindingId: new Map(),
  });
}

function issueAndAssembleEntityPlan(input: {
  current: FindingLedger;
  plan: ReturnType<typeof reconcileEntityCommit>;
  commands?: ReturnType<typeof reconcileEntityCommit>['managerDecisionCommands'];
}) {
  const observation = {
    runId: 'run-1',
    stepName: managerStep.name,
    timestamp: '2026-07-30T00:00:00.000Z',
  };
  const commands = input.commands ?? input.plan.managerDecisionCommands;
  const proofed = issueManagerLifecycleAuthority({
    current: input.current,
    managerDecisionProposed: input.plan.managerDecisionLedger,
    proposed: input.plan.ledger,
    managerDecisionCommands: commands,
    settlementCommands: input.plan.settlementCommands,
    managerOutput: input.plan.managerOutput,
    cwd: process.cwd(),
    workflowName: input.current.workflowName,
    runId: observation.runId,
    scopeIdentity: 'finding-storage:test:entity-binding',
    reviewScopeSnapshotId: 'a'.repeat(64),
    observation,
  });
  const committed = assembleAndApplyManagerLifecycleTransactions({
    current: input.current,
    managerDecisionProposed: input.plan.managerDecisionLedger,
    managerDecisionCommands: commands,
    proposed: proofed.ledger,
    managerOutput: input.plan.managerOutput,
    provisionalProofIdsByFinding: proofed.provisionalProofIdsByFinding,
    invalidationProofIdsByFinding: proofed.invalidationProofIdsByFinding,
    duplicateProofIdsByCommandKey: proofed.duplicateProofIdsByCommandKey,
    managerDecisionProvisionalTransitionProofIdsByCommandKey:
      proofed.managerDecisionProvisionalTransitionProofIdsByCommandKey,
    provisionalTransitionProofIdsByCommandKey:
      proofed.provisionalTransitionProofIdsByCommandKey,
    invalidationReasonsByFinding: proofed.invalidationReasonsByFinding,
    resolutionRenotifications: [],
    settlementCommands: input.plan.settlementCommands,
    actionRecoveryPlan: null,
    occurredAt: observation,
  });
  return { committed, proofed };
}

async function existingAmbiguityAttachmentPlan() {
  const priorRaw = rawFinding({
    rawFindingId: 'raw-prior',
    title: 'Existing ambiguity claim',
    description: 'The existing ambiguity episode has its original claim.',
  });
  const initial = emptyLedger({
    findings: [provisionalFinding({
      id: 'F-0001',
      raw: priorRaw,
      kind: 'raw-meaning-ambiguous',
    })],
    rawFindings: [priorRaw],
    nextId: 2,
  });
  const ledger = authorizeFindingLedgerFixture(initial);
  const attachedRaw = rawFinding({
    rawFindingId: 'raw-attached',
    reviewer: 'later-reviewer',
    title: 'Different ambiguity claim',
    description: 'A different claim shares the unresolved target locus.',
  });
  const intake = intakeFor(ledger, [attachedRaw]);
  executeAgentMock.mockRejectedValue(new Error('provider unavailable'));
  const bound = await bind({ ledger, intake, roundMarker: 'round-2' });
  const evaluation = evaluate(ledger, bound.intake);
  const plan = reconcileEntityCommit({
    ledger,
    rawFindings: [intake.items[0]!.wire],
    mutations: evaluation.preAdmissionEntityMutations,
  });
  return { ledger, plan };
}

function provisionalFinding(input: {
  id: string;
  raw: RawFinding;
  kind: 'raw-adjudication-unresolved' | 'raw-meaning-ambiguous';
  status?: FindingLedgerEntry['status'];
}): FindingLedgerEntry {
  const observation = {
    runId: 'run-0',
    stepName: input.raw.stepName,
    timestamp: '2026-07-29T00:00:00.000Z',
  };
  return {
    id: input.id,
    status: input.status ?? 'open',
    lifecycle: input.status === 'dismissed' ? 'dismissed' : 'new',
    revision: 1,
    target: input.raw.target,
    targetIdentityHash: input.raw.targetIdentityHash,
    claimIdentityHash: input.raw.claimIdentityHash,
    semanticClaimIdentityHash: input.raw.semanticClaimIdentityHash,
    severity: input.raw.severity,
    title: input.raw.title,
    description: input.raw.description ?? undefined,
    suggestion: input.raw.suggestion ?? undefined,
    evidenceIds: [],
    reviewers: [input.raw.reviewer],
    rawFindingIds: [input.raw.rawFindingId],
    firstSeen: { ...observation },
    lastSeen: { ...observation },
    provisional: {
      kind: input.kind,
      stableKey: entityBindingDigest('finding-provisional-entity-v1', input.id),
      lineageKey: entityBindingDigest('finding-provisional-lineage-v1', input.id),
      sourceRawFindingIds: [input.raw.rawFindingId],
      reason: 'Existing provisional.',
      firstObservedAt: { ...observation },
      lastObservedAt: { ...observation },
      gateEffect: 'block',
      firstObservedRound: 1,
    },
  };
}

function productFinding(raw: RawFinding, id = 'F-0001'): FindingLedgerEntry {
  const finding = provisionalFinding({
    id,
    raw,
    kind: 'raw-adjudication-unresolved',
  });
  const { provisional: _provisional, ...product } = finding;
  return product;
}

beforeEach(() => {
  executeAgentMock.mockReset();
});

describe('pre-admission semantic entity binding', () => {
  it('creates one entity for same-round paraphrases and strips permissionResolution', async () => {
    const ledger = emptyLedger();
    const intake = intakeFor(ledger, [
      rawFinding({
        rawFindingId: 'raw-a',
        reviewer: 'reviewer-a',
        title: 'Cache invalidation skips renamed files',
        description: 'A renamed source file keeps stale cache state.',
      }),
      rawFinding({
        rawFindingId: 'raw-b',
        reviewer: 'reviewer-b',
        title: 'Renames leave an obsolete cache entry',
        description: 'Moving a source path leaves the old cached value.',
      }),
    ]);
    mockGroupedDecision((_rawFindingId, owned) => ({
      decision: 'new_entity',
      groupRawFindingId: owned[0],
    }));

    const bound = await bind({
      ledger,
      intake,
      options: {
        permissionMode: 'edit',
        permissionResolution: 'edit',
        allowedTools: ['write'],
      },
    });
    const committed = applyMutations(ledger, bound.intake);
    const options = executeAgentMock.mock.calls[0]?.[2] as Record<string, unknown>;

    expect(options).toMatchObject({ permissionMode: 'readonly', allowedTools: [] });
    expect(options).not.toHaveProperty('permissionResolution');
    expect(committed.findings).toHaveLength(1);
    expect(committed.findings[0]?.provisional?.sourceRawFindingIds)
      .toEqual(['raw-a', 'raw-b']);
    expect(committed.findings[0]?.provisional).toMatchObject({
      stableKey: entityBindingDigest('finding-provisional-entity-v1', 'F-0001'),
      lineageKey: entityBindingDigest('finding-provisional-lineage-v1', 'F-0001'),
    });
  });

  it('commits one provisional for distinct claims with binding provenance for every raw', async () => {
    const ledger = emptyLedger();
    const intake = intakeFor(ledger, [
      rawFinding({
        rawFindingId: 'raw-a',
        reviewer: 'reviewer-a',
        title: 'Cache invalidation skips renamed files',
        description: 'A renamed source file keeps stale cache state.',
      }),
      rawFinding({
        rawFindingId: 'raw-b',
        reviewer: 'reviewer-b',
        title: 'Cache invalidation skips deleted files',
        description: 'A deleted source file keeps stale cache state.',
      }),
    ]);
    mockGroupedDecision((_rawFindingId, owned) => ({
      decision: 'ambiguous',
      groupRawFindingId: owned[0],
    }));
    const bound = await bind({ ledger, intake });
    const evaluation = evaluate(ledger, bound.intake);
    const plan = reconcileEntityCommit({
      ledger,
      rawFindings: intake.items.map((item) => item.wire),
      mutations: evaluation.preAdmissionEntityMutations,
    });
    const observation = {
      runId: 'run-1',
      stepName: managerStep.name,
      timestamp: '2026-07-30T00:00:00.000Z',
    };
    const proofed = issueManagerLifecycleAuthority({
      current: ledger,
      managerDecisionProposed: plan.managerDecisionLedger,
      proposed: plan.ledger,
      managerDecisionCommands: plan.managerDecisionCommands,
      settlementCommands: plan.settlementCommands,
      managerOutput: plan.managerOutput,
      cwd: process.cwd(),
      workflowName: ledger.workflowName,
      runId: observation.runId,
      scopeIdentity: 'finding-storage:test:multi-claim-provisional',
      reviewScopeSnapshotId: 'a'.repeat(64),
      observation,
    });
    const committed = assembleAndApplyManagerLifecycleTransactions({
      current: ledger,
      managerDecisionProposed: plan.managerDecisionLedger,
      managerDecisionCommands: plan.managerDecisionCommands,
      proposed: proofed.ledger,
      managerOutput: plan.managerOutput,
      provisionalProofIdsByFinding: proofed.provisionalProofIdsByFinding,
      invalidationProofIdsByFinding: proofed.invalidationProofIdsByFinding,
      duplicateProofIdsByCommandKey: proofed.duplicateProofIdsByCommandKey,
      managerDecisionProvisionalTransitionProofIdsByCommandKey:
        proofed.managerDecisionProvisionalTransitionProofIdsByCommandKey,
      provisionalTransitionProofIdsByCommandKey:
        proofed.provisionalTransitionProofIdsByCommandKey,
      invalidationReasonsByFinding: proofed.invalidationReasonsByFinding,
      resolutionRenotifications: [],
      settlementCommands: plan.settlementCommands,
      actionRecoveryPlan: null,
      occurredAt: observation,
    });
    const finding = committed.findings[0]!;
    const proofIds = proofed.provisionalProofIdsByFinding.get(finding.id) ?? [];
    const event = committed.lifecycleEvents.find(
      (candidate) => candidate.operation === 'update_provisional',
    )!;
    const eventRawFindingIds = event.evidenceBindingIds.flatMap((bindingId) => {
      const binding = committed.evidenceBindings.find(
        (candidate) => candidate.bindingId === bindingId,
      );
      return binding?.sourceRawFindingId === null || binding === undefined
        ? []
        : [binding.sourceRawFindingId];
    });
    const proofClaimIdentityHashes = proofIds.map((proofId) => (
      proofed.ledger.evidenceRecords.find((record) => record.evidenceId === proofId)!
        .claimIdentityHash
    ));
    const bundleAuthorization = plan.managerDecisionCommands[0]
      ?.provisionalClaimBindingAuthorizationsByTarget
      ?.get(`finding\0${finding.id}`)?.[0];
    const proofAuthorizationIds = proofIds.map((proofId) => {
      const proof = proofed.ledger.evidenceRecords.find(
        (record) => record.evidenceId === proofId,
      );
      return proof?.kind === 'engine_proof'
        && proof.subject.kind === 'finding_provisional_isolation'
        ? proof.subject.claimBindingAuthorizationReferences.map(
            (authorization) => authorization.authorizationId,
          )
        : [];
    });

    expect(finding.provisional?.sourceRawFindingIds).toEqual(['raw-a', 'raw-b']);
    expect(bundleAuthorization?.reference).toMatchObject({
      kind: 'new_provisional_bundle',
      expectedHead: null,
      sourceRawFindingIds: ['raw-a', 'raw-b'],
    });
    expect(proofAuthorizationIds).toEqual([
      [bundleAuthorization?.reference.authorizationId],
      [bundleAuthorization?.reference.authorizationId],
    ]);
    expect(proofClaimIdentityHashes.sort()).toEqual(
      intake.items.map((item) => item.wire.claimIdentityHash).sort(),
    );
    expect(eventRawFindingIds.sort()).toEqual(['raw-a', 'raw-b']);
  });

  it('commits a distinct-claim attach_existing through proof issuance and lifecycle assembly', async () => {
    const { ledger, plan } = await existingAmbiguityAttachmentPlan();
    const { committed, proofed } = issueAndAssembleEntityPlan({ current: ledger, plan });
    const command = plan.managerDecisionCommands[0]!;
    const authorization = command.provisionalClaimBindingAuthorizationsByTarget
      ?.get('finding\0F-0001')?.[0];
    const proof = proofed.ledger.evidenceRecords.find((record) => (
      record.kind === 'engine_proof'
      && record.subject.kind === 'finding_provisional_isolation'
      && record.claimIdentityHash === plan.ledger.rawFindings.find(
        (raw) => raw.rawFindingId === 'raw-attached',
      )?.claimIdentityHash
    ));
    const event = committed.lifecycleEvents.at(-1)!;

    expect(authorization?.reference).toMatchObject({
      kind: 'pre_admission_attach_existing',
      findingId: 'F-0001',
      expectedProvisionalKind: 'raw-meaning-ambiguous',
      sourceRawFindingIds: ['raw-attached'],
    });
    expect(proof).toMatchObject({
      subject: {
        claimBindingAuthorizationReferences: [{
          authorizationId: authorization?.reference.authorizationId,
        }],
      },
    });
    expect(committed.findings[0]?.provisional?.sourceRawFindingIds)
      .toEqual(['raw-attached', 'raw-prior']);
    expect(event.operation).toBe('update_provisional');
    expect(event.evidenceBindingIds.some((bindingId) => (
      committed.evidenceBindings.find((binding) => binding.bindingId === bindingId)
        ?.sourceRawFindingId === 'raw-attached'
    ))).toBe(true);

    const laterRaw = rawFinding({
      rawFindingId: 'raw-later-attachment',
      title: 'Third ambiguity claim',
      description: 'A later round attaches after the episode already contains distinct claims.',
    });
    const committedWithSnapshots = {
      ...committed,
      rawCanonicalSnapshots: committed.rawFindings.map((raw) => (
        committed.rawCanonicalSnapshots.find(
          (snapshot) => snapshot.rawFindingId === raw.rawFindingId,
        ) ?? rawCanonicalSnapshotFixture(raw, {
          runId: 'run-1',
          stepName: raw.stepName,
          timestamp: committed.updatedAt,
        })
      )),
    };
    const laterIntake = intakeFor(committedWithSnapshots, [laterRaw]);
    const laterBound = await bind({
      ledger: committedWithSnapshots,
      intake: laterIntake,
      roundMarker: 'round-3',
    });
    const laterEvaluation = evaluate(committedWithSnapshots, laterBound.intake);
    const laterPlan = reconcileEntityCommit({
      ledger: committedWithSnapshots,
      rawFindings: [laterIntake.items[0]!.wire],
      mutations: laterEvaluation.preAdmissionEntityMutations,
    });
    const laterCommitted = issueAndAssembleEntityPlan({
      current: committedWithSnapshots,
      plan: laterPlan,
    }).committed;

    expect(laterCommitted.findings[0]?.provisional?.sourceRawFindingIds)
      .toEqual(['raw-attached', 'raw-later-attachment', 'raw-prior']);
  });

  it('rejects a distinct-claim existing attachment without pre-admission authorization', async () => {
    const { ledger, plan } = await existingAmbiguityAttachmentPlan();
    const commands = plan.managerDecisionCommands.map((command) => {
      const {
        provisionalClaimBindingAuthorizationsByTarget: _authorization,
        ...withoutAuthorization
      } = command;
      void _authorization;
      return withoutAuthorization;
    });

    expect(() => issueAndAssembleEntityPlan({ current: ledger, plan, commands }))
      .toThrow(/does not match the provisional projection delta/);
  });

  it('rejects a content-addressed plain object without the pre-admission brand', async () => {
    const { ledger, plan } = await existingAmbiguityAttachmentPlan();
    const command = plan.managerDecisionCommands[0]!;
    const key = 'finding\0F-0001';
    const authorization = command.provisionalClaimBindingAuthorizationsByTarget
      ?.get(key)?.[0];
    expect(authorization).toBeDefined();
    const forgedReference = provisionalClaimBindingAuthorizationReference(authorization!);
    const commands = [{
      ...command,
      provisionalClaimBindingAuthorizationsByTarget: new Map([[
        key,
        [forgedReference as unknown as typeof authorization],
      ]]),
    }];

    expect(() => issueAndAssembleEntityPlan({ current: ledger, plan, commands }))
      .toThrow(/was not issued by pre-admission commit/);
  });

  it.each([
    ['structured clone', (authorization: FindingProvisionalClaimBindingAuthorization) => (
      structuredClone(authorization)
    )],
    ['spread', (authorization: FindingProvisionalClaimBindingAuthorization) => ({
      ...authorization,
    })],
  ])('rejects a %s of a pre-admission authorization at runtime', async (_, copy) => {
    const { ledger, plan } = await existingAmbiguityAttachmentPlan();
    const command = plan.managerDecisionCommands[0]!;
    const key = 'finding\0F-0001';
    const authorization = command.provisionalClaimBindingAuthorizationsByTarget
      ?.get(key)?.[0];
    expect(authorization).toBeDefined();
    const commands = [{
      ...command,
      provisionalClaimBindingAuthorizationsByTarget: new Map([[
        key,
        [copy(authorization!) as unknown as typeof authorization],
      ]]),
    }];

    expect(() => issueAndAssembleEntityPlan({ current: ledger, plan, commands }))
      .toThrow(/was not issued by pre-admission commit/);
  });

  it('rejects a forged authorization hidden from the caller-owned array iterator', async () => {
    const { ledger, plan } = await existingAmbiguityAttachmentPlan();
    const command = plan.managerDecisionCommands[0]!;
    const key = 'finding\0F-0001';
    const authorization = command.provisionalClaimBindingAuthorizationsByTarget
      ?.get(key)?.[0];
    expect(authorization).toBeDefined();
    const forgedReference = provisionalClaimBindingAuthorizationReference(authorization!);
    const forgedAuthorizations = [
      forgedReference as unknown as NonNullable<typeof authorization>,
    ];
    Object.defineProperty(forgedAuthorizations, Symbol.iterator, {
      value: () => [][Symbol.iterator](),
    });
    const commands = [{
      ...command,
      provisionalClaimBindingAuthorizationsByTarget: new Map([[
        key,
        forgedAuthorizations,
      ]]),
    }];

    expect(() => issueAndAssembleEntityPlan({ current: ledger, plan, commands }))
      .toThrow(/was not issued by pre-admission commit/);
  });

  it('rejects a forged new provisional bundle without the pre-admission brand', async () => {
    const ledger = emptyLedger();
    const intake = intakeFor(ledger, [
      rawFinding({ rawFindingId: 'raw-a', title: 'Claim A' }),
      rawFinding({ rawFindingId: 'raw-b', title: 'Claim B' }),
    ]);
    mockGroupedDecision(() => ({
      decision: 'ambiguous',
      groupRawFindingId: 'raw-a',
    }));
    const bound = await bind({ ledger, intake });
    const evaluation = evaluate(ledger, bound.intake);
    const plan = reconcileEntityCommit({
      ledger,
      rawFindings: intake.items.map((item) => item.wire),
      mutations: evaluation.preAdmissionEntityMutations,
    });
    const command = plan.managerDecisionCommands[0]!;
    const key = [...command.provisionalClaimBindingAuthorizationsByTarget!.keys()][0]!;
    const authorization = command.provisionalClaimBindingAuthorizationsByTarget!.get(key)![0]!;
    const forgedReference = provisionalClaimBindingAuthorizationReference(authorization);
    const commands = [{
      ...command,
      provisionalClaimBindingAuthorizationsByTarget: new Map([[
        key,
        [forgedReference as unknown as typeof authorization],
      ]]),
    }];

    expect(() => issueAndAssembleEntityPlan({ current: ledger, plan, commands }))
      .toThrow(/was not issued by pre-admission commit/);
  });

  it('routes a relation- and claim-incomplete evidence-less raw through binding', async () => {
    const ledger = emptyLedger();
    const incomplete = canonicalRawFindingFixture({
      rawFindingId: 'raw-incomplete',
      stepName: 'reviewer',
      reviewer: 'reviewer',
      target: { kind: 'code', paths: ['src/shared.ts'] },
      familyTag: null,
      severity: null,
      title: null,
      description: null,
      suggestion: null,
      relation: null,
      targetFindingId: null,
      evidence: [],
    });
    const intake = intakeFor(ledger, [incomplete]);
    mockGroupedDecision((rawFindingId) => ({
      decision: 'ambiguous',
      groupRawFindingId: rawFindingId,
    }));

    const bound = await bind({ ledger, intake });
    const evaluation = evaluate(ledger, bound.intake);

    expect(executeAgentMock).toHaveBeenCalledOnce();
    expect(evaluation.preAdmissionEntityMutations).toMatchObject([{
      operation: 'create_new',
      provisionalKind: 'raw-meaning-ambiguous',
      title: null,
      severity: null,
    }]);
  });

  it('does not bind fallback uncertainty to raw-adjudication-unresolved', async () => {
    const priorRaw = rawFinding({
      rawFindingId: 'raw-a',
      title: 'Known unverified defect',
      description: 'Existing raw-adjudication provisional.',
    });
    const existing = provisionalFinding({
      id: 'F-0001',
      raw: priorRaw,
      kind: 'raw-adjudication-unresolved',
    });
    const ledger = emptyLedger({
      findings: [existing],
      rawFindings: [priorRaw],
      nextId: 2,
    });
    const intake = intakeFor(ledger, [rawFinding({
      rawFindingId: 'raw-b',
      title: 'Different uncertain defect',
      description: 'A separate observation at the same target.',
    })]);
    executeAgentMock.mockRejectedValue(new Error('provider unavailable'));

    const bound = await bind({ ledger, intake });
    const evaluation = evaluate(ledger, bound.intake);
    const committed = applyMutations(ledger, bound.intake);

    expect(evaluation.preAdmissionEntityMutations).toMatchObject([{
      operation: 'create_new',
      provisionalKind: 'raw-meaning-ambiguous',
    }]);
    expect(committed.findings).toHaveLength(2);
    expect(committed.findings[0]?.rawFindingIds).toEqual(['raw-a']);
    expect(committed.findings[1]?.rawFindingIds).toEqual(['raw-b']);
  });

  it('keeps uncertainty and nextId bounded while overlapping path sets change', async () => {
    executeAgentMock.mockRejectedValue(new Error('provider unavailable'));
    let ledger = emptyLedger();
    const targets: FindingTarget[] = [
      { kind: 'code', paths: ['src/a.ts'] },
      { kind: 'code', paths: ['src/a.ts', 'src/b.ts'] },
      { kind: 'code', paths: ['src/b.ts'] },
    ];
    for (const [index, target] of targets.entries()) {
      const intake = intakeFor(ledger, [rawFinding({
        rawFindingId: `raw-${index + 1}`,
        title: `Uncertain defect ${index + 1}`,
        description: 'The same uncertainty moves across an overlapping target locus.',
        target,
      })]);
      const bound = await bind({
        ledger,
        intake,
        roundMarker: `round-${index + 1}`,
      });
      ledger = applyMutations(ledger, bound.intake);
    }

    expect(ledger.findings).toHaveLength(1);
    expect(ledger.nextId).toBe(2);
    expect(ledger.findings[0]?.rawFindingIds).toEqual(['raw-1', 'raw-2', 'raw-3']);
  });

  it('creates every same-locus ambiguous manager group without dropping a raw', async () => {
    const ledger = emptyLedger();
    const intake = intakeFor(ledger, ['a', 'b', 'c', 'd'].map((suffix) => rawFinding({
      rawFindingId: `raw-${suffix}`,
      title: `Ambiguous ${suffix}`,
      description: `Independent ambiguous group ${suffix}.`,
    })));
    mockGroupedDecision((rawFindingId) => ({
      decision: 'ambiguous',
      groupRawFindingId: rawFindingId.endsWith('a') || rawFindingId.endsWith('b')
        ? 'raw-a'
        : 'raw-c',
    }));

    const bound = await bind({ ledger, intake });
    const evaluation = evaluate(ledger, bound.intake);
    const committed = applyMutations(ledger, bound.intake);

    expect(evaluation.preAdmissionEntityMutations).toHaveLength(2);
    expect(committed.findings).toHaveLength(2);
    expect(committed.findings.flatMap((finding) => finding.rawFindingIds).sort())
      .toEqual(['raw-a', 'raw-b', 'raw-c', 'raw-d']);
  });

  it('keeps an ambiguous group uncertain when only one member appears exactly before commit', async () => {
    const originalLedger = emptyLedger();
    const rawA = rawFinding({
      rawFindingId: 'raw-a',
      title: 'Exact member A',
      description: 'Only this group member appears concurrently.',
    });
    const rawB = rawFinding({
      rawFindingId: 'raw-b',
      title: 'Uncertain member B',
      description: 'This member remains semantically unresolved.',
    });
    const intake = intakeFor(originalLedger, [rawA, rawB]);
    mockGroupedDecision((_rawFindingId, owned) => ({
      decision: 'ambiguous',
      groupRawFindingId: owned[0],
    }));
    const bound = await bind({ ledger: originalLedger, intake });
    const concurrentRaw = rawFinding({
      rawFindingId: 'raw-concurrent',
      title: rawA.title!,
      description: rawA.description!,
    });
    const freshLedger = emptyLedger({
      findings: [productFinding(concurrentRaw)],
      rawFindings: [concurrentRaw],
      nextId: 2,
    });

    const evaluation = evaluate(freshLedger, bound.intake);

    expect(evaluation.pendingRejectedObservations).toEqual([]);
    expect(evaluation.preAdmissionEntityMutations).toMatchObject([{
      operation: 'create_new',
      provisionalKind: 'raw-meaning-ambiguous',
      sourceRawFindingIds: ['raw-a', 'raw-b'],
    }]);
  });

  it('does not reuse stable or lineage identity after a closed provisional', async () => {
    executeAgentMock.mockRejectedValue(new Error('provider unavailable'));
    const firstRaw = rawFinding({
      rawFindingId: 'raw-first',
      title: 'First uncertainty',
      description: 'First episode.',
    });
    const closed = provisionalFinding({
      id: 'F-0001',
      raw: firstRaw,
      kind: 'raw-meaning-ambiguous',
      status: 'dismissed',
    });
    const ledger = emptyLedger({
      findings: [closed],
      rawFindings: [firstRaw],
      nextId: 2,
    });
    const intake = intakeFor(ledger, [rawFinding({
      rawFindingId: 'raw-second',
      title: 'Second uncertainty',
      description: 'New episode after closed history.',
    })]);

    const committed = applyMutations(
      ledger,
      (await bind({ ledger, intake })).intake,
    );

    expect(committed.findings).toHaveLength(2);
    expect(committed.findings[1]?.provisional?.stableKey)
      .not.toBe(closed.provisional?.stableKey);
    expect(committed.findings[1]?.provisional?.lineageKey)
      .not.toBe(closed.provisional?.lineageKey);
  });

  it('keeps semantic entity to Finding ID mapping stable when raw IDs are swapped', async () => {
    const run = async (leftRawId: string, rightRawId: string) => {
      const ledger = emptyLedger();
      const intake = intakeFor(ledger, [
        rawFinding({
          rawFindingId: leftRawId,
          title: 'Alpha defect',
          description: 'Alpha semantic entity.',
        }),
        rawFinding({
          rawFindingId: rightRawId,
          title: 'Beta defect',
          description: 'Beta semantic entity.',
        }),
      ]);
      mockGroupedDecision((rawFindingId) => ({
        decision: 'new_entity',
        groupRawFindingId: rawFindingId,
      }));
      return applyMutations(ledger, (await bind({ ledger, intake })).intake);
    };

    const first = await run('raw-a', 'raw-b');
    executeAgentMock.mockReset();
    const swapped = await run('raw-b', 'raw-a');

    expect(first.findings.map((finding) => [finding.id, finding.title]))
      .toEqual(swapped.findings.map((finding) => [finding.id, finding.title]));
  });

  it('falls back on a changed fresh locus without attaching or double-creating', async () => {
    const originalLedger = emptyLedger();
    const intake = intakeFor(originalLedger, [rawFinding({
      rawFindingId: 'raw-new',
      title: 'New cache defect',
      description: 'Manager judged a new semantic entity.',
    })]);
    mockGroupedDecision((rawFindingId) => ({
      decision: 'new_entity',
      groupRawFindingId: rawFindingId,
    }));
    const bound = await bind({ ledger: originalLedger, intake });
    const concurrentRaw = rawFinding({
      rawFindingId: 'raw-concurrent',
      title: 'Different concurrent defect',
      description: 'A different entity appeared at the same locus.',
    });
    const freshLedger = emptyLedger({
      findings: [productFinding(concurrentRaw)],
      rawFindings: [concurrentRaw],
      nextId: 2,
    });
    const evaluation = evaluate(freshLedger, bound.intake);
    const committed = applyMutations(freshLedger, bound.intake);

    expect(evaluation.preAdmissionEntityMutations).toMatchObject([{
      operation: 'create_new',
      provisionalKind: 'raw-meaning-ambiguous',
    }]);
    expect(committed.findings).toHaveLength(2);
    expect(committed.findings[0]?.rawFindingIds).toEqual(['raw-concurrent']);
    expect(committed.findings[1]?.rawFindingIds).toEqual(['raw-new']);
  });

  it('converts a planned create to audit when a unique exact entity appears', async () => {
    const originalLedger = emptyLedger();
    const raw = rawFinding({
      rawFindingId: 'raw-new',
      title: 'Exact concurrent defect',
      description: 'The exact entity appears before commit.',
    });
    const intake = intakeFor(originalLedger, [raw]);
    mockGroupedDecision((rawFindingId) => ({
      decision: 'new_entity',
      groupRawFindingId: rawFindingId,
    }));
    const bound = await bind({ ledger: originalLedger, intake });
    const concurrent = rawFinding({
      rawFindingId: 'raw-concurrent',
      title: raw.title!,
      description: raw.description!,
    });
    const freshLedger = emptyLedger({
      findings: [productFinding(concurrent)],
      rawFindings: [concurrent],
      nextId: 2,
    });
    const evaluation = evaluate(freshLedger, bound.intake);

    expect(evaluation.preAdmissionEntityMutations).toEqual([]);
    expect(evaluation.pendingRejectedObservations).toMatchObject([{
      targetFindingId: 'F-0001',
      destination: 'target_audit',
    }]);
    expect(freshLedger.nextId).toBe(2);
  });

  it('attaches fallback to the smallest ambiguity Finding ID without superseding peers', async () => {
    const rawA = rawFinding({
      rawFindingId: 'raw-a',
      title: 'Uncertainty A',
      description: 'First existing ambiguity.',
    });
    const rawB = rawFinding({
      rawFindingId: 'raw-b',
      title: 'Uncertainty B',
      description: 'Second existing ambiguity.',
    });
    const ledger = emptyLedger({
      findings: [
        provisionalFinding({
          id: 'F-0002',
          raw: rawB,
          kind: 'raw-meaning-ambiguous',
        }),
        provisionalFinding({
          id: 'F-0001',
          raw: rawA,
          kind: 'raw-meaning-ambiguous',
        }),
      ],
      rawFindings: [rawA, rawB],
      nextId: 3,
    });
    const intake = intakeFor(ledger, [rawFinding({
      rawFindingId: 'raw-c',
      title: 'Uncertainty C',
      description: 'Fallback observation.',
    })]);
    executeAgentMock.mockRejectedValue(new Error('provider unavailable'));

    const bound = await bind({ ledger, intake });
    const evaluation = evaluate(ledger, bound.intake);
    const committed = applyMutations(ledger, bound.intake);

    expect(evaluation.preAdmissionEntityMutations).toMatchObject([{
      operation: 'attach_existing',
      findingId: 'F-0001',
    }]);
    expect(committed.findings.find((finding) => finding.id === 'F-0001')?.rawFindingIds)
      .toEqual(['raw-a', 'raw-c']);
    expect(committed.findings.find((finding) => finding.id === 'F-0002')?.status)
      .toBe('open');
    expect(committed.nextId).toBe(3);
  });

  it('does not attach when the planned ambiguity episode is closed before commit', async () => {
    const priorRaw = rawFinding({
      rawFindingId: 'raw-prior',
      title: 'Prior uncertainty',
      description: 'An ambiguity episode that closes before commit.',
    });
    const openEpisode = provisionalFinding({
      id: 'F-0001',
      raw: priorRaw,
      kind: 'raw-meaning-ambiguous',
    });
    const originalLedger = emptyLedger({
      findings: [openEpisode],
      rawFindings: [priorRaw],
      nextId: 2,
    });
    const intake = intakeFor(originalLedger, [rawFinding({
      rawFindingId: 'raw-new',
      title: 'Later uncertainty',
      description: 'The new episode must not attach to closed history.',
    })]);
    executeAgentMock.mockRejectedValue(new Error('provider unavailable'));

    const bound = await bind({ ledger: originalLedger, intake });
    const closedEpisode = {
      ...openEpisode,
      status: 'dismissed' as const,
      revision: openEpisode.revision + 1,
    };
    const freshLedger = emptyLedger({
      findings: [closedEpisode],
      rawFindings: [priorRaw],
      nextId: 2,
    });
    const evaluation = evaluate(freshLedger, bound.intake);
    const committed = applyMutations(freshLedger, bound.intake);

    expect(evaluation.preAdmissionEntityMutations).toMatchObject([{
      operation: 'create_new',
      provisionalKind: 'raw-meaning-ambiguous',
      sourceRawFindingIds: ['raw-new'],
    }]);
    expect(committed.findings).toHaveLength(2);
    expect(committed.findings[0]?.status).toBe('dismissed');
    expect(committed.findings[1]?.rawFindingIds).toEqual(['raw-new']);
    expect(committed.nextId).toBe(3);
  });

  it('fails fast when an attach precondition no longer matches', () => {
    const raw = rawFinding({
      rawFindingId: 'raw-a',
      title: 'Uncertainty A',
      description: 'Existing ambiguity.',
    });
    const existing = provisionalFinding({
      id: 'F-0001',
      raw,
      kind: 'raw-meaning-ambiguous',
    });
    const ledger = emptyLedger({ findings: [existing], rawFindings: [raw], nextId: 2 });

    expect(() => applyPreAdmissionEntityProvisionalMutationsToLedger(
      ledger,
      [{
        operation: 'attach_existing',
        findingId: 'F-0001',
        expectedKind: 'raw-meaning-ambiguous',
        expectedStableKey: 'stale-key',
        expectedLineageKey: existing.provisional!.lineageKey,
        sourceRawFindingIds: ['raw-new'],
        reviewers: ['reviewer'],
        reason: 'Stale attachment.',
        claimBindingAuthorizations: [],
      }],
      {
        workflowName: ledger.workflowName,
        stepName: 'reviewers',
        runId: 'run-1',
        timestamp: '2026-07-30T00:00:00.000Z',
      },
    )).toThrow(/attachment precondition failed/);
  });

  it('coalesces same-finding attachments into one persists revision', async () => {
    const priorRaw = rawFinding({
      rawFindingId: 'raw-prior',
      title: 'Existing ambiguity',
      description: 'The canonical ambiguity episode.',
    });
    const existing = provisionalFinding({
      id: 'F-0001',
      raw: priorRaw,
      kind: 'raw-meaning-ambiguous',
    });
    const ledger = emptyLedger({
      findings: [existing],
      rawFindings: [priorRaw],
      nextId: 2,
    });
    const intake = intakeFor(ledger, [
      rawFinding({
        rawFindingId: 'raw-a',
        reviewer: 'reviewer-a',
        title: 'Ambiguous A',
        description: 'First separate manager group.',
      }),
      rawFinding({
        rawFindingId: 'raw-b',
        reviewer: 'reviewer-b',
        title: 'Ambiguous B',
        description: 'Second separate manager group.',
      }),
    ]);
    mockGroupedDecision((rawFindingId) => ({
      decision: 'ambiguous',
      groupRawFindingId: rawFindingId,
    }));

    const bound = await bind({ ledger, intake });
    const evaluation = evaluate(ledger, bound.intake);
    const committed = applyMutations(ledger, bound.intake);
    const attached = committed.findings[0]!;

    expect(evaluation.preAdmissionEntityMutations).toHaveLength(2);
    expect(attached.revision).toBe(existing.revision + 1);
    expect(attached.lifecycle).toBe('persists');
    expect(attached.rawFindingIds).toEqual(['raw-a', 'raw-b', 'raw-prior']);
    expect(attached.reviewers).toEqual(['reviewer', 'reviewer-a', 'reviewer-b']);
  });

  it('merges a legacy spec and entity attachment into one revision and command', async () => {
    const priorRaw = rawFinding({
      rawFindingId: 'raw-prior',
      title: 'Shared ambiguity',
      description: 'The existing ambiguity projection.',
    });
    const existing = provisionalFinding({
      id: 'F-0001',
      raw: priorRaw,
      kind: 'raw-meaning-ambiguous',
    });
    const ledger = emptyLedger({
      findings: [existing],
      rawFindings: [priorRaw],
      nextId: 2,
    });
    const entityRaw = rawFinding({
      rawFindingId: 'raw-entity',
      reviewer: 'entity-reviewer',
      title: 'Entity attachment',
      description: 'Attached through pre-admission entity binding.',
    });
    const legacyRaw = rawFinding({
      rawFindingId: 'raw-legacy',
      reviewer: 'legacy-reviewer',
      title: priorRaw.title!,
      description: priorRaw.description!,
    });
    const intake = intakeFor(ledger, [entityRaw]);
    executeAgentMock.mockRejectedValue(new Error('provider unavailable'));
    const bound = await bind({ ledger, intake });
    const evaluation = evaluate(ledger, bound.intake);
    const provisional = existing.provisional!;

    const committed = reconcileEntityCommit({
      ledger,
      rawFindings: [intake.items[0]!.wire, legacyRaw],
      mutations: evaluation.preAdmissionEntityMutations,
      provisionalSpecs: [{
        kind: provisional.kind,
        stableKey: provisional.stableKey,
        lineageKey: provisional.lineageKey,
        sourceRawFindingIds: [legacyRaw.rawFindingId],
        reason: 'Legacy spec reason.',
        title: legacyRaw.title,
        severity: legacyRaw.severity,
        description: legacyRaw.description ?? undefined,
        suggestion: legacyRaw.suggestion ?? undefined,
        reviewers: [legacyRaw.reviewer],
        target: legacyRaw.target,
        targetIdentityHash: legacyRaw.targetIdentityHash,
        claimIdentityHash: legacyRaw.claimIdentityHash,
        semanticClaimIdentityHash: legacyRaw.semanticClaimIdentityHash,
      }],
    });
    const finding = committed.ledger.findings[0]!;

    expect(finding.revision).toBe(existing.revision + 1);
    expect(finding.lifecycle).toBe('persists');
    expect(finding.rawFindingIds).toEqual([
      'raw-entity',
      'raw-legacy',
      'raw-prior',
    ]);
    expect(finding.reviewers).toEqual([
      'entity-reviewer',
      'legacy-reviewer',
      'reviewer',
    ]);
    expect(finding.provisional?.reason).toContain('Legacy spec reason.');
    expect(finding.provisional?.reason).toContain('provider unavailable');
    expect(committed.managerDecisionCommands).toHaveLength(1);
    expect(committed.managerDecisionCommands[0]?.operation).toBe('update_provisional');
  });

  it('rejects a standard manager dismissal before converting an attachment to terminal audit', async () => {
    const priorRaw = rawFinding({
      rawFindingId: 'raw-prior',
      title: 'Dismissed ambiguity',
      description: 'The ambiguity is dismissed while a new raw is committing.',
    });
    const existing = provisionalFinding({
      id: 'F-0001',
      raw: priorRaw,
      kind: 'raw-meaning-ambiguous',
    });
    const ledger = emptyLedger({
      findings: [existing],
      rawFindings: [priorRaw],
      nextId: 2,
    });
    const intake = intakeFor(ledger, [rawFinding({
      rawFindingId: 'raw-terminal',
      title: 'Late uncertain observation',
      description: 'This observation must become audit-only.',
    })]);
    executeAgentMock.mockRejectedValue(new Error('provider unavailable'));
    const bound = await bind({ ledger, intake });
    const evaluation = evaluate(ledger, bound.intake);

    const committed = reconcileEntityCommit({
      ledger,
      rawFindings: [intake.items[0]!.wire],
      mutations: evaluation.preAdmissionEntityMutations,
      managerOutput: {
        ...createEmptyManagerOutput(),
        dismissedFindings: [{
          findingId: existing.id,
          basis: 'outside_contract_jurisdiction',
          reason: 'The ambiguity is terminal.',
          evidence: 'The observation contains no verifiable subject.',
          authority: 'standard',
        }],
      },
    });
    expect(committed.managerOutput.dismissedFindings).toEqual([]);
    expect(committed.normalizationRejections).toContainEqual(
      expect.stringContaining('manager dismissal requires verified terminal adjudication'),
    );
    expect(committed.ledger.findings.find((finding) => finding.id === existing.id)?.status).toBe('open');
  });

  it('converts an attachment to terminal audit when clean evidence promotes the target', async () => {
    const priorRaw = rawFinding({
      rawFindingId: 'raw-prior',
      title: 'Promoted ambiguity',
      description: 'Clean evidence will materialize this ambiguity.',
    });
    const existing = provisionalFinding({
      id: 'F-0001',
      raw: priorRaw,
      kind: 'raw-meaning-ambiguous',
    });
    const ledger = emptyLedger({
      findings: [existing],
      rawFindings: [priorRaw],
      nextId: 2,
    });
    const intake = intakeFor(ledger, [rawFinding({
      rawFindingId: 'raw-terminal',
      title: 'Late uncertain observation',
      description: 'This observation must remain audit-only after promotion.',
    })]);
    executeAgentMock.mockRejectedValue(new Error('provider unavailable'));
    const bound = await bind({ ledger, intake });
    const evaluation = evaluate(ledger, bound.intake);
    const promotionRaw = canonicalRawFindingFixture({
      rawFindingId: 'raw-clean',
      stepName: 'reviewer-clean',
      reviewer: 'reviewer-clean',
      target: priorRaw.target,
      familyTag: priorRaw.familyTag,
      severity: priorRaw.severity,
      title: priorRaw.title,
      description: priorRaw.description,
      suggestion: priorRaw.suggestion,
      relation: 'persists',
      targetFindingId: existing.id,
      targetPrecondition: captureFindingPreconditions(ledger)
        .get(existing.id)!.precondition,
      evidence: [],
    });

    const committed = reconcileEntityCommit({
      ledger,
      rawFindings: [intake.items[0]!.wire, promotionRaw],
      mutations: evaluation.preAdmissionEntityMutations,
      cleanWire: [promotionRaw],
      managerOutput: {
        ...createEmptyManagerOutput(),
        anchorAdjudications: [createAnchorAdjudication({
          rawFindingId: promotionRaw.rawFindingId,
          decision: 'same',
          findingId: existing.id,
          anchorRelevance: 'not_applicable',
          evidence: 'Clean confirmation of the same claim.',
        })],
        matches: [{
          findingId: existing.id,
          rawFindingIds: [promotionRaw.rawFindingId],
        }],
      },
    });
    const observation = {
      runId: 'run-1',
      stepName: managerStep.name,
      timestamp: '2026-07-30T00:00:00.000Z',
    };
    const audited = applyRejectedObservationAttachments(
      authorizeFindingLedgerFixture(committed.ledger),
      committed.rejectedObservationAttachments,
      observation,
    );

    expect(committed.entityMutationResults).toMatchObject([{
      outcome: 'terminal_audit',
      targetFindingId: existing.id,
      sourceRawFindingIds: ['raw-terminal'],
    }]);
    expect(committed.ledger.findings[0]?.provisional).toBeUndefined();
    expect(committed.ledger.rawFindings.map((raw) => raw.rawFindingId))
      .toContain('raw-terminal');
    expect(committed.ledger.findings[0]?.rawFindingIds).not.toContain('raw-terminal');
    expect(audited.findings[0]?.rejectedObservations).toMatchObject([{
      rawFindingId: 'raw-terminal',
    }]);
  });

  it('sorts create mutations semantically before assigning Finding IDs', async () => {
    const ledger = emptyLedger();
    const intake = intakeFor(ledger, [
      rawFinding({
        rawFindingId: 'raw-z',
        title: 'Alpha semantic entity',
        description: 'First semantic payload.',
      }),
      rawFinding({
        rawFindingId: 'raw-a',
        title: 'Beta semantic entity',
        description: 'Second semantic payload.',
      }),
    ]);
    mockGroupedDecision((rawFindingId) => ({
      decision: 'new_entity',
      groupRawFindingId: rawFindingId,
    }));
    const evaluation = evaluate(
      ledger,
      (await bind({ ledger, intake })).intake,
    );
    const context = {
      workflowName: ledger.workflowName,
      stepName: 'reviewers',
      runId: 'run-1',
      timestamp: '2026-07-30T00:00:00.000Z',
    };

    const forward = applyPreAdmissionEntityProvisionalMutationsToLedger(
      ledger,
      evaluation.preAdmissionEntityMutations,
      context,
    );
    const reversed = applyPreAdmissionEntityProvisionalMutationsToLedger(
      ledger,
      [...evaluation.preAdmissionEntityMutations].reverse(),
      context,
    );

    expect(forward.findings.map((finding) => [finding.id, finding.title]))
      .toEqual(reversed.findings.map((finding) => [finding.id, finding.title]));
  });

  it('rejects a disjoint manager group and falls back per connected component', async () => {
    const ledger = emptyLedger();
    const intake = intakeFor(ledger, [
      rawFinding({
        rawFindingId: 'raw-a',
        title: 'A defect',
        description: 'Component A.',
        target: { kind: 'code', paths: ['src/a.ts'] },
      }),
      rawFinding({
        rawFindingId: 'raw-b',
        title: 'B defect',
        description: 'Component B.',
        target: { kind: 'code', paths: ['src/b.ts'] },
      }),
    ]);
    mockGroupedDecision((_rawFindingId, owned) => ({
      decision: 'ambiguous',
      groupRawFindingId: owned[0],
    }));

    const bound = await bind({ ledger, intake });
    const evaluation = evaluate(ledger, bound.intake);

    expect(bound.taskAudits).toMatchObject([{ status: 'failed' }]);
    expect(evaluation.preAdmissionEntityMutations).toHaveLength(2);
    expect(applyMutations(ledger, bound.intake).findings).toHaveLength(2);
  });

  it('quarantines one over-budget complete component as durable protocol incidents', async () => {
    const ledger = emptyLedger();
    const raws = Array.from({ length: 128 }, (_, index) => rawFinding({
      rawFindingId: `raw-${String(index).padStart(3, '0')}`,
      title: `Variant ${index}`,
      description: `Same component ${index} ${'x'.repeat(300)}`,
    }));
    const intake = intakeFor(ledger, raws);

    const bound = await bind({ ledger, intake });
    const evaluation = evaluate(ledger, bound.intake);

    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(bound.intake.items).toHaveLength(raws.length);
    expect(bound.intake.overflowRawFindingIds).toEqual(
      new Set(raws.map((raw) => raw.rawFindingId)),
    );
    expect(bound.intake.intakeAnomalySpecs).toHaveLength(raws.length);
    expect(bound.intake.intakeAnomalySpecs.every((spec) => (
      spec.sourceRawFindingIds.length === 1
      && spec.sourceIntakeIds.length === 0
    ))).toBe(true);
    expect(bound.taskAudits).toMatchObject([{
      status: 'input_overflow',
      inputBytes: expect.any(Number),
      ownedIds: raws.map((raw) => raw.rawFindingId),
    }]);
    expect(bound.taskAudits[0]?.inputBytes).toBeGreaterThan(
      MAIN_MANAGER_INPUT_MAX_BYTES,
    );
    expect(evaluation.preAdmissionEntityMutations).toEqual([]);
    expect(evaluation.admissionProvisionalSpecs).toEqual([]);
    expect(evaluation.cleanAdmitted).toEqual([]);
    expect(evaluation.taintedAdmitted).toEqual([]);
    expect(ledger.findings).toEqual([]);
    expect(ledger.nextId).toBe(1);
  });

  it('scans every disjoint component across deterministic budget pages', async () => {
    const ledger = emptyLedger();
    const raws = Array.from({ length: 129 }, (_, index) => rawFinding({
      rawFindingId: `raw-page-${String(index).padStart(3, '0')}`,
      title: `Independent defect ${index}`,
      description: `Distinct component ${index}.`,
      target: { kind: 'code', paths: [`src/component-${index}.ts`] },
    }));
    mockGroupedDecision((rawFindingId) => ({
      decision: 'new_entity',
      groupRawFindingId: rawFindingId,
    }));

    const bound = await bind({ ledger, intake: intakeFor(ledger, raws) });
    const ownedIds = bound.taskAudits.flatMap((audit) => audit.ownedIds);
    const evaluation = evaluate(ledger, bound.intake);

    expect(executeAgentMock.mock.calls.length).toBeGreaterThan(1);
    expect(ownedIds).toEqual(raws.map((raw) => raw.rawFindingId));
    expect(bound.taskAudits.every((audit) => (
      audit.inputBytes !== null
      && audit.inputBytes <= MAIN_MANAGER_INPUT_MAX_BYTES
    ))).toBe(true);
    expect(evaluation.preAdmissionEntityMutations).toHaveLength(129);
  });

  it('binds an F-0016/F-0017 target component from compact heads without historical raw bodies', async () => {
    const raw16 = rawFinding({
      rawFindingId: 'raw-f-0016',
      title: 'F-0016 entity',
      description: 'The first defect at this target.',
    });
    const raw17 = rawFinding({
      rawFindingId: 'raw-f-0017',
      title: 'F-0017 entity',
      description: 'A distinct defect at the same target.',
    });
    const historicalMarker = 'HISTORICAL_RAW_BODY_MUST_NOT_REACH_ENTITY_BINDING';
    const historicalRaws = Array.from({ length: 32 }, (_, index) => rawFinding({
      rawFindingId: `raw-history-${index}`,
      title: `Historical observation ${index}`,
      description: `${historicalMarker}-${index}-${'x'.repeat(2_000)}`,
    }));
    const baseFinding16 = productFinding(raw16, 'F-0016');
    const baseFinding17 = productFinding(raw17, 'F-0017');
    const baselineLedger = emptyLedger({
      findings: [
        baseFinding16,
        baseFinding17,
      ],
      rawFindings: [raw16, raw17],
      nextId: 18,
    });
    const ledger = emptyLedger({
      findings: [
        {
          ...baseFinding16,
          rawFindingIds: [
            raw16.rawFindingId,
            ...historicalRaws
              .filter((_raw, index) => index % 2 === 0)
              .map((raw) => raw.rawFindingId),
          ],
        },
        {
          ...baseFinding17,
          rawFindingIds: [
            raw17.rawFindingId,
            ...historicalRaws
              .filter((_raw, index) => index % 2 === 1)
              .map((raw) => raw.rawFindingId),
          ],
        },
      ],
      rawFindings: [raw16, raw17, ...historicalRaws],
      nextId: 18,
    });
    const current = rawFinding({
      rawFindingId: 'raw-current',
      title: 'Current paraphrase of F-0016',
      description: 'This is semantically the first defect, phrased differently.',
    });
    const instructions: string[] = [];
    executeAgentMock.mockImplementation(async (_persona, currentInstruction) => {
      instructions.push(currentInstruction);
      const manifest = sectionJson<{
        taskId: string;
        ownedRawFindingIds: string[];
      }>(currentInstruction, '## Task manifest');
      return response({
        taskId: manifest.taskId,
        decisions: [{
          rawFindingId: 'raw-current',
          decision: 'bind_existing',
          findingId: 'F-0016',
          groupRawFindingId: '',
          reason: 'The observation is the F-0016 semantic entity.',
        }],
      });
    });

    const baseline = await bind({
      ledger: baselineLedger,
      intake: intakeFor(baselineLedger, [current]),
    });
    const bound = await bind({
      ledger,
      intake: intakeFor(ledger, [current]),
    });
    const instruction = instructions[1]!;
    const projection = sectionJson<{
      findings: Array<Record<string, unknown>>;
    }>(instruction, '## Complete ledger entities for the supplied connected components');
    const evaluation = evaluate(ledger, bound.intake);

    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    expect(instructions[0]).toBe(instructions[1]);
    expect(bound.taskAudits[0]?.inputBytes).toBe(
      baseline.taskAudits[0]?.inputBytes,
    );
    expect(bound.taskAudits[0]?.taskId).toBe(
      baseline.taskAudits[0]?.taskId,
    );
    expect(bound.taskAudits[0]?.inputBytes).toBeLessThanOrEqual(
      MAIN_MANAGER_INPUT_MAX_BYTES,
    );
    expect(projection.findings.map((finding) => finding.id))
      .toEqual(['F-0016', 'F-0017']);
    expect(projection.findings[0]).toEqual(expect.objectContaining({
      id: 'F-0016',
      revision: 1,
      status: 'open',
      lifecycle: 'new',
      targetIdentityHash: raw16.targetIdentityHash,
      claimIdentityHash: raw16.claimIdentityHash,
      semanticClaimIdentityHash: raw16.semanticClaimIdentityHash,
      provisional: null,
    }));
    expect(JSON.stringify(projection)).not.toMatch(
      /rawFindingIds|sourceRawFindingIds|evidenceIds|waiver|dispute/,
    );
    expect(instruction).not.toContain(historicalMarker);
    expect(evaluation.preAdmissionEntityMutations).toEqual([]);
    expect(evaluation.pendingRejectedObservations).toMatchObject([{
      targetFindingId: 'F-0016',
      destination: 'target_audit',
    }]);
  });

  it('changes task identity when the canonical entity head projection changes', async () => {
    const original = rawFinding({
      rawFindingId: 'raw-original-head',
      title: 'Original entity',
      description: 'The original semantic payload.',
    });
    const baseFinding = productFinding(original);
    const ledgerAtRevision1 = emptyLedger({
      findings: [baseFinding],
      rawFindings: [original],
      nextId: 2,
    });
    const ledgerAtRevision2 = emptyLedger({
      findings: [{ ...baseFinding, revision: 2 }],
      rawFindings: [original],
      nextId: 2,
    });
    const current = rawFinding({
      rawFindingId: 'raw-current-head',
      title: 'Paraphrased entity',
      description: 'A different wording that needs manager binding.',
    });
    mockGroupedDecision(() => ({
      decision: 'bind_existing',
      findingId: 'F-0001',
    }));

    const first = await bind({
      ledger: ledgerAtRevision1,
      intake: intakeFor(ledgerAtRevision1, [current]),
    });
    const second = await bind({
      ledger: ledgerAtRevision2,
      intake: intakeFor(ledgerAtRevision2, [current]),
    });

    expect(first.taskAudits[0]?.taskId).not.toBe(second.taskAudits[0]?.taskId);
  });

  it('uses unique exact semantic identity as an audit-only fast path', async () => {
    const original = rawFinding({
      rawFindingId: 'raw-original',
      title: 'Exact cache defect',
      description: 'Exact semantic claim.',
    });
    const ledger = emptyLedger({
      findings: [productFinding(original)],
      rawFindings: [original],
      nextId: 2,
    });
    const repeated = rawFinding({
      rawFindingId: 'raw-repeat',
      reviewer: 'reviewer-b',
      title: 'Exact cache defect',
      description: 'Exact semantic claim.',
    });
    const bound = await bind({ ledger, intake: intakeFor(ledger, [repeated]) });
    const evaluation = evaluate(ledger, bound.intake);

    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(evaluation.preAdmissionEntityMutations).toEqual([]);
    expect(evaluation.pendingRejectedObservations).toMatchObject([{
      targetFindingId: 'F-0001',
      destination: 'target_audit',
    }]);
  });
});
