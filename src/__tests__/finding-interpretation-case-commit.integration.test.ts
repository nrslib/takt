import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commitFindingManagerRound,
  resumePendingManagerCommit,
} from '../core/workflow/findings/manager-commit.js';
import { evaluateRawAdmission } from '../core/workflow/findings/manager-admission.js';
import { createInterpretationCases } from '../core/workflow/findings/interpretation-case-model.js';
import type {
  ManagerDecisionStageResult,
  RunFindingManagerForStepInput,
} from '../core/workflow/findings/manager-contracts.js';
import { createEmptyManagerOutput } from '../core/workflow/findings/manager-output.js';
import { resolveReviewIntegrityLimits } from '../core/workflow/findings/review-integrity.js';
import { captureReviewScopeProofSnapshot } from '../core/workflow/findings/snapshot.js';
import { resolveStopBudgetLimits } from '../core/workflow/findings/stop-budget.js';
import type { InterpretationDecision } from '../core/workflow/findings/types.js';
import {
  baseLedger,
  cleanupInterpretationCaseRoots,
  OBSERVATION,
  openHarness,
  response,
  seed,
  taintedItems,
} from './helpers/finding-interpretation-case-store-fixture.js';

afterEach(() => cleanupInterpretationCaseRoots());

function initializeReviewScope(root: string): ReturnType<typeof captureReviewScopeProofSnapshot> {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/shared.ts'), 'line 1\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', 'src/shared.ts'], { cwd: root });
  execFileSync(
    'git',
    ['-c', 'user.name=TAKT test', '-c', 'user.email=takt-test@example.invalid',
      'commit', '--quiet', '-m', 'fixture'],
    { cwd: root },
  );
  return captureReviewScopeProofSnapshot(root);
}

describe('interpretation case manager commit', () => {
  it.each([
    {
      name: 'provisional',
      decision: {
        kind: 'provisional',
        reason: 'Provider cannot safely determine the product identity.',
      } satisfies InterpretationDecision,
      expectedOutcome: 'provisional' as const,
      publicationFailure: true,
      resumeCompleted: true,
      verifyReplayNoOp: true,
      source: 'provider' as const,
    },
    {
      name: 'open conflict',
      decision: {
        kind: 'open_conflict',
        targetFindingId: 'F-0001',
      } satisfies InterpretationDecision,
      expectedOutcome: 'conflict' as const,
      source: 'provider' as const,
    },
    {
      name: 'direct provisional',
      decision: {
        kind: 'provisional',
        reason: 'The complete case is mechanically provisional.',
      } satisfies InterpretationDecision,
      expectedOutcome: 'provisional' as const,
      source: 'direct' as const,
    },
    {
      name: 'SameProof',
      decision: {
        kind: 'provisional',
        reason: 'Unused because SameProof is selected mechanically.',
      } satisfies InterpretationDecision,
      expectedOutcome: 'finding' as const,
      expectedFindingOutcome: 'matched_with_proof' as const,
      source: 'proof' as const,
    },
    {
      name: 'independent finding',
      decision: {
        kind: 'create_independent',
      } satisfies InterpretationDecision,
      expectedOutcome: 'finding' as const,
      expectedFindingOutcome: 'created' as const,
      relation: 'new' as const,
      targetFindingId: null,
      source: 'provider' as const,
    },
  ])('commits one completed $name case through lifecycle and finalizes its attempt', async ({
    decision,
    expectedFindingOutcome,
    expectedOutcome,
    publicationFailure,
    relation,
    resumeCompleted,
    source,
    targetFindingId,
    verifyReplayNoOp,
  }) => {
    let harness = openHarness();
    const reviewScopeSnapshot = initializeReviewScope(harness.root);
    const initial = source === 'proof'
      ? baseLedger({
          title: 'Shared semantic defect',
          description: 'The same defect remains observable.',
        })
      : baseLedger();
    await seed(harness, initial);
    const items = taintedItems({
      rawFindingIds: ['raw-commit-provisional'],
      ledger: initial,
      evidenceSnapshotId: reviewScopeSnapshot.reviewScopeSnapshotId,
      relation,
      targetFindingId,
    });
    const plannedCase = createInterpretationCases({
      items,
      ledger: initial,
      provisionalOnlyRawFindingIds: new Set(),
    })[0];
    if (plannedCase === undefined) {
      throw new Error('Expected one interpretation case');
    }
    let completedAttemptIdsForCommit: string[] = [];
    let completedAttemptId: string | undefined;
    const directPlans: ManagerDecisionStageResult['interpretation']['directPlans'] = [];
    let proofFastPathPlans: ManagerDecisionStageResult['interpretation']['proofFastPathPlans'] = [];
    if (source === 'provider') {
      const begun = await harness.beginInterpretationCases({
        items,
        provisionalOnlyRawFindingIds: new Set(),
      });
      const providerCase = begun.providerCases[0];
      if (providerCase === undefined) {
        throw new Error('Expected one provider interpretation case');
      }
      const completed = await harness.completeInterpretationCases({
        receipt: begun.receipt,
        responses: [response(providerCase, decision)],
        providerFailures: [],
      });
      completedAttemptIdsForCommit = completed.attempts.map((attempt) => attempt.attemptId);
      completedAttemptId = completedAttemptIdsForCommit[0];
      if (resumeCompleted) {
        const root = harness.root;
        harness.resolver.close();
        harness = openHarness({ root });
        const resumed = await harness.beginInterpretationCases({
          items,
          provisionalOnlyRawFindingIds: new Set(),
        });
        expect(resumed.providerCases).toEqual([]);
        expect(resumed.attempts).toEqual([]);
        expect(resumed.completedAttemptIdsForCommit).toEqual(completedAttemptIdsForCommit);
        completedAttemptIdsForCommit = resumed.completedAttemptIdsForCommit;
      }
    } else if (source === 'direct') {
      directPlans.push({
        plannedCase,
        items,
        decision,
        roundIdentity: '1'.repeat(64),
      });
    } else {
      const begun = await harness.beginInterpretationCases({
        items,
        provisionalOnlyRawFindingIds: new Set(),
      });
      proofFastPathPlans = begun.proofFastPathPlans;
      expect(proofFastPathPlans).toHaveLength(1);
    }
    const previousLedger = harness.store.loadLedger();
    const intake = {
      entityBindings: new Map(),
      items,
      overflowRawFindingIds: new Set<string>(),
      intakeProvisionalSpecs: [],
      intakeAnomalySpecs: [],
      overflowReports: [],
      clarifications: [],
      rawNormalizations: [],
      healthyReviewerStableKeys: new Set<string>(),
    };
    const input = {
      contract: {},
      cwd: harness.root,
      ledgerStore: harness.store,
      optionsBuilder: {},
      stepExecutor: {},
      parentStep: {
        kind: 'agent',
        name: OBSERVATION.stepName,
        persona: 'reviewer',
        edit: false,
      },
      stepIteration: 1,
      subResults: [],
      workflowName: initial.workflowName,
      workflowTask: 'Review the supplied implementation.',
      runId: OBSERVATION.runId,
      callNamespace: '',
      timestamp: OBSERVATION.timestamp,
      managerAuthority: 'standard',
    } as RunFindingManagerForStepInput;
    const admission = evaluateRawAdmission({
      cwd: harness.root,
      reviewScopeSnapshotId: reviewScopeSnapshot.reviewScopeSnapshotId,
      runId: OBSERVATION.runId,
      scopeIdentity: harness.store.ledgerIdentity,
      previousLedger,
      intake,
      reviewScopeSnapshot,
      workflowTask: input.workflowTask,
    });
    const emptyRecoveryIntake = { ...intake, items: [] };
    const managerDecision: ManagerDecisionStageResult = {
      managerOutput: createEmptyManagerOutput(),
      conflictTargetHeads: new Map(),
      invalidAttempts: [],
      cleanProvisionalSpecs: [],
      unsupportedRawFindingReports: [],
      cleanWireById: new Map(),
      cleanCanonicalById: new Map(),
      interpretation: {
        items,
        completedAttemptIdsForCommit,
        directPlans,
        proofFastPathPlans,
        provisionalOnlyRawFindingIds: new Set(),
        stats: {
          ambiguousRawCount: 1,
          managerCalls: source === 'provider' ? 1 : 0,
          estimatedInputTokens: 1,
          estimatedOutputTokens: 1,
          reusedCompletedDecisions: resumeCompleted ? 1 : 0,
          interruptedInterpretations: 0,
          budgetExhaustedLineages: 0,
        },
      },
      rawRecovery: {
        intake: emptyRecoveryIntake,
        output: createEmptyManagerOutput(),
        origins: new Map(),
        failures: new Map(),
        capturedPreconditions: new Map(),
        invalidAttempts: [],
        unsupportedRawFindingReports: [],
        cleanWireById: new Map(),
        cleanCanonicalById: new Map(),
        reservationTokens: new Set(),
      },
      taskAudits: [],
    };

    const commit = () => commitFindingManagerRound({
      input,
      previousLedger,
      intake,
      interpretationRecoveryFailures: [],
      admission,
      managerDecision,
      observation: OBSERVATION,
      stopBudgetLimits: resolveStopBudgetLimits(undefined),
      stopBudgetRoundMarker: 'round-interpretation-case-commit',
      reviewIntegrityLimits: resolveReviewIntegrityLimits(undefined),
      reviewScopeSnapshotId: reviewScopeSnapshot.reviewScopeSnapshotId,
      reviewScopeSnapshot,
    });
    let applied = false;
    if (publicationFailure) {
      const publish = harness.store.publishManagerValidationPublication;
      const publishSpy = vi.spyOn(harness.store, 'publishManagerValidationPublication')
        .mockImplementationOnce(() => {
          throw new Error('injected interpretation publication failure');
        })
        .mockImplementation(publish);
      await expect(commit()).rejects.toThrow('injected interpretation publication failure');
      const staged = harness.store.loadLedger();
      expect(staged.interpretationAttempts.find(
        (attempt) => attempt.attemptId === completedAttemptId,
      )?.stage).toBe('completed');
      expect(staged.pendingManagerCommit?.completed.interpretationAttempts.find(
        (attempt) => attempt.attemptId === completedAttemptId,
      )?.stage).toBe('applied');
      const resumed = await resumePendingManagerCommit(input, staged);
      expect(resumed?.completedRoundMarker).toBe('round-interpretation-case-commit');
      applied = resumed !== undefined;
      publishSpy.mockRestore();
    } else {
      applied = (await commit()).applied;
    }

    expect(applied).toBe(true);
    const ledger = harness.store.loadLedger();
    const attempt = ledger.interpretationAttempts.find(
      (candidate) => candidate.attemptId === completedAttemptId,
    );
    if (source === 'provider') {
      expect(attempt?.stage).toBe('applied');
    } else {
      expect(ledger.interpretationAttempts).toHaveLength(0);
    }
    const outcome = ledger.rawInterpretationOutcomes.find(
      (candidate) => candidate.rawFindingId === items[0]?.wire.rawFindingId,
    );
    expect(outcome?.kind).toBe(expectedOutcome);
    if (
      outcome?.kind !== expectedOutcome
      || (
        outcome.kind !== 'finding'
        && outcome.kind !== 'provisional'
        && outcome.kind !== 'conflict'
      )
    ) {
      throw new Error(`Expected a ${expectedOutcome} interpretation outcome`);
    }
    const landingFindingId = outcome.kind === 'finding'
      ? outcome.findingId
      : outcome.provisionalFindingId;
    const landed = ledger.findings.find(
      (finding) => finding.id === landingFindingId,
    );
    if (outcome.kind === 'finding') {
      expect(landed?.provisional).toBeUndefined();
      expect(outcome.outcome).toBe(expectedFindingOutcome);
      expect(ledger.lifecycleEvents.some(
        (event) => event.eventId === outcome.landingEventId,
      )).toBe(true);
    } else {
      expect(landed?.provisional?.gateEffect).toBe('block');
      const provisionalEventId = outcome.kind === 'conflict'
        ? outcome.provisionalLandingEventId
        : outcome.landingEventId;
      expect(ledger.lifecycleEvents.some(
        (event) => event.eventId === provisionalEventId,
      )).toBe(true);
    }
    expect(ledger.evidenceBindings).toContainEqual(expect.objectContaining({
      sourceRawFindingId: items[0]?.wire.rawFindingId,
      target: expect.objectContaining({
        entityKind: 'finding',
        entityId: landingFindingId,
      }),
      contributionOrigin: {
        kind: 'interpretation_case',
        caseId: plannedCase.caseId,
      },
    }));
    if (outcome.kind === 'conflict') {
      const landing = ledger.conflictRawClaimLandings.find(
        (candidate) => candidate.rawClaimLandingId === outcome.rawClaimLandingId,
      );
      expect(landing).toMatchObject({
        conflictId: outcome.conflictId,
        rawFindingId: items[0]?.wire.rawFindingId,
        holdingFindingId: outcome.provisionalFindingId,
        landingEventId: outcome.provisionalLandingEventId,
      });
      expect(landing?.holdingHeadAfterLanding.eventId).toBe(
        outcome.provisionalLandingEventId,
      );
      expect(outcome.conflictLandingEventId).not.toBe(
        outcome.provisionalLandingEventId,
      );
      expect(ledger.conflicts).toContainEqual(expect.objectContaining({
        id: outcome.conflictId,
        status: 'active',
        rawFindingIds: expect.arrayContaining([items[0]!.wire.rawFindingId]),
      }));
      expect(ledger.evidenceBindings).toContainEqual(expect.objectContaining({
        sourceRawFindingId: items[0]?.wire.rawFindingId,
        target: expect.objectContaining({
          entityKind: 'conflict',
          entityId: outcome.conflictId,
        }),
        contributionOrigin: {
          kind: 'interpretation_case',
          caseId: plannedCase.caseId,
        },
      }));
    }
    expect(ledger.stopBudget?.roundMarkers).toContain('round-interpretation-case-commit');
    if (verifyReplayNoOp) {
      const beforeReplay = structuredClone(ledger);
      const replay = await commit();
      expect(replay.applied).toBe(false);
      expect(replay.nextLedger).toEqual(beforeReplay);
      expect(harness.store.loadLedger()).toEqual(beforeReplay);
    }
  });
});
