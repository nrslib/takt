import { describe, expect, it } from 'vitest';
import {
  computeFindingScopeBindingId,
  findingContentAddress,
} from '../core/models/finding-contract-identity.js';
import type {
  TerminalAdjudicationAttempt,
  TerminalAdjudicationProposal,
} from '../core/models/finding-contract-types.js';
import { assertFindingLifecycleAuthorityInvariant } from '../core/models/finding-lifecycle-invariants.js';
import { buildTerminalAdjudicationCandidateSnapshot } from '../core/workflow/findings/terminal-adjudication-candidates.js';
import { applyResolvedTerminalAdjudication } from '../core/workflow/findings/terminal-adjudication-commit.js';
import { createTerminalAdjudicationRound } from '../core/workflow/findings/terminal-adjudication-model.js';
import { resolveTerminalAdjudicationPlan } from '../core/workflow/findings/terminal-adjudication-verifier.js';
import { issueFindingScopeBindings } from '../core/workflow/findings/finding-scope-binding.js';
import { captureFindingLifecycleHead } from '../core/workflow/findings/lifecycle-mutation.js';
import type { FindingContractConfig, FindingLedger } from '../core/workflow/findings/types.js';
import {
  applyFindingLedgerFixtureRevision,
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
} from './helpers/finding-lifecycle-fixture.js';

const OBSERVATION = {
  runId: 'run-scope-binding',
  stepName: 'findings-terminal-adjudication',
  timestamp: '2026-08-02T00:00:00.000Z',
};
const WORKFLOW_TASK = 'Change only src/in-scope.ts.';
const REVIEW_SCOPE_SNAPSHOT_ID = '2'.repeat(64);
const CONTRACT: FindingContractConfig = {
  manager: {
    persona: 'manager',
    instruction: 'Manage findings.',
    outputContract: 'Return structured findings.',
  },
  adjudicator: { persona: 'supervisor' },
};
const FINDING_CONTRACT_DIGEST = findingContentAddress('finding-contract-config', CONTRACT);
const VERIFIER_CONTEXT = {
  workflowTask: WORKFLOW_TASK,
  findingContractDigest: FINDING_CONTRACT_DIGEST,
  reviewScopeSnapshotId: REVIEW_SCOPE_SNAPSHOT_ID,
};

function fixtureLedger(): FindingLedger {
  const raw = canonicalRawFindingFixture({
    rawFindingId: 'raw-outside-task',
    stepName: 'reviewer',
    reviewer: 'reviewer',
    familyTag: 'scope',
    severity: 'medium',
    title: 'Outside task claim',
    description: 'The claim targets a file outside the engine-owned task scope.',
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: ['docs/outside.md'] },
    evidence: [{
      kind: 'file_quote',
      path: 'docs/outside.md',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'outside',
      snapshotId: '1'.repeat(64),
    }],
  });
  const initial = authorizeFindingLedgerFixture({
    workflowName: 'scope-binding',
    nextId: 2,
    updatedAt: OBSERVATION.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      severity: 'medium',
      title: 'Outside task claim',
      description: 'The claim targets a file outside the engine-owned task scope.',
      evidenceIds: [],
      reviewers: ['reviewer'],
      rawFindingIds: [raw.rawFindingId],
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
      revision: 1,
      provisional: {
        kind: 'raw-meaning-ambiguous',
        stableKey: 'scope-binding-stable',
        lineageKey: 'scope-binding-lineage',
        sourceRawFindingIds: [raw.rawFindingId],
        reason: 'Requires terminal scope adjudication.',
        firstObservedAt: OBSERVATION,
        lastObservedAt: OBSERVATION,
        gateEffect: 'block',
        firstObservedRound: 1,
      },
    }],
    evidenceRecords: [],
    rawFindings: [raw],
    conflicts: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
  });
  const finding = initial.findings[0]!;
  return applyFindingLedgerFixtureRevision({
    ledger: initial,
    entityKind: 'finding',
    contributionOrigin: { kind: 'external' },
    sourceRawFindingId: raw.rawFindingId,
    entity: {
      ...finding,
      revision: finding.revision + 1,
    },
  });
}

function proposedLedger() {
  const ledger = fixtureLedger();
  const finding = ledger.findings[0]!;
  const expectedHead = captureFindingLifecycleHead(ledger, 'finding', finding.id)!;
  const candidate = buildTerminalAdjudicationCandidateSnapshot({
    ledger,
    finding,
    currentRound: 2,
  })!;
  const bindings = issueFindingScopeBindings({
    finding,
    expectedHead,
    workflowTask: WORKFLOW_TASK,
    contract: CONTRACT,
    reviewScopeSnapshot: {
      reviewScopeSnapshotId: REVIEW_SCOPE_SNAPSHOT_ID,
      trackedDiff: undefined,
      untrackedEvidence: [],
      queryInventory: [],
      changedPaths: ['src/in-scope.ts'],
    },
    issuedAt: OBSERVATION,
  });
  const taskBinding = bindings.find(({ source }) => source === 'workflow_task_scope')!;
  const planned = createTerminalAdjudicationRound({
    ledger: { ...ledger, findingScopeBindings: bindings },
    roundIdentity: findingContentAddress('scope-binding-round', { runId: OBSERVATION.runId }),
    candidates: [candidate],
    selectedAt: OBSERVATION,
  });
  const episode = planned.episodes[0]!;
  const proposal: TerminalAdjudicationProposal = {
    kind: 'dismiss',
    basis: 'outside_task_scope',
    authorityRefIds: [taskBinding.bindingId],
    rationale: 'The structured target path is outside the captured task scope.',
  };
  const attempt: TerminalAdjudicationAttempt = {
    attemptId: findingContentAddress('scope-binding-attempt', { episodeId: episode.episodeId }),
    episodeId: episode.episodeId,
    selectionId: episode.selectionId,
    roundIdentity: episode.roundIdentity,
    findingId: finding.id,
    expectedHead,
    candidateSnapshotDigest: candidate.candidateSnapshotDigest,
    attemptOrdinal: 1,
    retryOrdinal: 0,
    providerCallId: 'scope-binding-provider-call',
    requestDigest: 'scope-binding-request',
    sourceClaimRefIds: candidate.sourceClaims.map(({ sourceClaimRefId }) => sourceClaimRefId),
    stage: 'proposed',
    startedAt: OBSERVATION,
    completedAt: OBSERVATION,
    proposal,
    proposalDigest: findingContentAddress('terminal-adjudication-proposal', proposal),
  };
  return {
    ledger: {
      ...ledger,
      findingScopeBindings: bindings,
      terminalAdjudicationRounds: [planned.round],
      terminalAdjudicationEpisodes: planned.episodes,
      terminalAdjudicationAttempts: [attempt],
    },
    candidate,
    episode,
    attempt,
    proposal,
    taskBinding,
  };
}

describe('finding scope binding terminal dismissal', () => {
  it('applies a valid engine-issued workflow scope dismissal end to end', () => {
    const fixture = proposedLedger();
    const plan = resolveTerminalAdjudicationPlan({
      ledger: fixture.ledger,
      episode: fixture.episode,
      candidate: fixture.candidate,
      proposal: fixture.proposal,
      ...VERIFIER_CONTEXT,
      adjudicationTaskId: fixture.attempt.attemptId,
    });
    expect(plan.kind).toBe('dismiss');
    const applied = applyResolvedTerminalAdjudication({
      ledger: fixture.ledger,
      attemptId: fixture.attempt.attemptId,
      plan,
      observation: OBSERVATION,
    });
    expect(applied.applied).toBe(true);
    expect(applied.ledger.findings[0]).toMatchObject({
      status: 'dismissed',
      dismissal: {
        basis: 'outside_task_scope',
        authority: 'terminal_adjudication',
        taskQuote: WORKFLOW_TASK,
        workflowTaskDigest: fixture.taskBinding.workflowTaskDigest,
        adjudicationTaskId: fixture.attempt.attemptId,
      },
    });
    expect(applied.ledger.terminalAdjudicationSettlements).toEqual([
      expect.objectContaining({ outcome: 'dismissed' }),
    ]);
    expect(() => assertFindingLifecycleAuthorityInvariant(applied.ledger)).not.toThrow();
  });

  it.each([
    {
      name: 'review scope snapshot',
      current: {
        ...VERIFIER_CONTEXT,
        reviewScopeSnapshotId: '3'.repeat(64),
      },
    },
    {
      name: 'finding contract',
      current: {
        ...VERIFIER_CONTEXT,
        findingContractDigest: findingContentAddress('finding-contract-config', {
          ...CONTRACT,
          adjudicator: { persona: 'changed-supervisor' },
        }),
      },
    },
  ])('rejects a proposed dismissal when the current $name dependency changed', ({ current }) => {
    const fixture = proposedLedger();
    const plan = resolveTerminalAdjudicationPlan({
      ledger: fixture.ledger,
      episode: fixture.episode,
      candidate: fixture.candidate,
      proposal: fixture.proposal,
      ...current,
      adjudicationTaskId: fixture.attempt.attemptId,
    });

    expect(plan).toEqual({ kind: 'undetermined', reasonCodes: ['scope_binding_not_found'] });
    const finalized = applyResolvedTerminalAdjudication({
      ledger: fixture.ledger,
      attemptId: fixture.attempt.attemptId,
      plan,
      observation: OBSERVATION,
    });
    expect(finalized.applied).toBe(false);
    expect(finalized.ledger.findings[0]).toMatchObject({
      status: 'open',
      provisional: expect.objectContaining({ kind: 'raw-meaning-ambiguous' }),
    });
    expect(finalized.ledger.terminalAdjudicationAttempts[0]).toMatchObject({
      stage: 'completed',
      result: {
        kind: 'verification_undetermined',
        reasonCodes: ['scope_binding_not_found'],
      },
    });
  });

  it('rejects a binding whose finding premise does not match the dismissed target', () => {
    const fixture = proposedLedger();
    const mismatchedContent = {
      source: fixture.taskBinding.source,
      findingId: 'F-9999',
      expectedHead: fixture.taskBinding.expectedHead,
      workflowTaskDigest: fixture.taskBinding.workflowTaskDigest,
      findingContractDigest: fixture.taskBinding.findingContractDigest,
      predicate: fixture.taskBinding.predicate,
      result: fixture.taskBinding.result,
      verifierId: fixture.taskBinding.verifierId,
      verifierVersion: fixture.taskBinding.verifierVersion,
      dependencyDigests: fixture.taskBinding.dependencyDigests,
    };
    const mismatched = {
      bindingId: computeFindingScopeBindingId(mismatchedContent),
      ...mismatchedContent,
      issuedAt: fixture.taskBinding.issuedAt,
    };
    const proposal: TerminalAdjudicationProposal = {
      ...fixture.proposal,
      authorityRefIds: [mismatched.bindingId],
    };
    expect(resolveTerminalAdjudicationPlan({
      ledger: { ...fixture.ledger, findingScopeBindings: [mismatched] },
      episode: fixture.episode,
      candidate: fixture.candidate,
      proposal,
      ...VERIFIER_CONTEXT,
      adjudicationTaskId: fixture.attempt.attemptId,
    })).toEqual({ kind: 'undetermined', reasonCodes: ['scope_binding_not_found'] });
  });

  it('revalidates the scope binding head at lifecycle commit', () => {
    const fixture = proposedLedger();
    const plan = resolveTerminalAdjudicationPlan({
      ledger: fixture.ledger,
      episode: fixture.episode,
      candidate: fixture.candidate,
      proposal: fixture.proposal,
      ...VERIFIER_CONTEXT,
      adjudicationTaskId: fixture.attempt.attemptId,
    });
    const staleBinding = {
      ...fixture.taskBinding,
      expectedHead: {
        ...fixture.taskBinding.expectedHead,
        revision: fixture.taskBinding.expectedHead.revision + 1,
      },
    };

    expect(() => applyResolvedTerminalAdjudication({
      ledger: { ...fixture.ledger, findingScopeBindings: [staleBinding] },
      attemptId: fixture.attempt.attemptId,
      plan,
      observation: OBSERVATION,
    })).toThrow(/mismatched scope binding/i);
  });

  it('rejects a referenced scope binding whose verifier contract was altered', () => {
    const fixture = proposedLedger();
    const plan = resolveTerminalAdjudicationPlan({
      ledger: fixture.ledger,
      episode: fixture.episode,
      candidate: fixture.candidate,
      proposal: fixture.proposal,
      ...VERIFIER_CONTEXT,
      adjudicationTaskId: fixture.attempt.attemptId,
    });
    const applied = applyResolvedTerminalAdjudication({
      ledger: fixture.ledger,
      attemptId: fixture.attempt.attemptId,
      plan,
      observation: OBSERVATION,
    });
    const altered = {
      ...applied.ledger,
      findingScopeBindings: applied.ledger.findingScopeBindings.map((binding) => ({
        ...binding,
        verifierVersion: '2',
      })),
    };

    expect(() => assertFindingLifecycleAuthorityInvariant(altered))
      .toThrow(/mismatched scope binding/i);
  });
});
