import { afterEach, describe, expect, it } from 'vitest';
import { compareBinaryStrings } from '../shared/utils/binary-string-comparator.js';
import { computeFindingManagerProviderCallId } from '../core/models/finding-contract-identity.js';
import { computeInterpretationAttemptId } from '../core/models/finding-interpretation-identity.js';
import type {
  FindingLedger,
  InterpretationAttempt,
  InterpretationCase,
} from '../core/workflow/findings/types.js';
import { parseFindingLedger } from '../core/workflow/findings/schemas.js';
import { dispatchFindingManagerProviderCall } from '../core/workflow/findings/finding-manager-provider-call.js';
import {
  baseLedger,
  addExactProductFinding,
  cleanupInterpretationCaseRoots,
  emptyLedger,
  failure,
  OBSERVATION,
  openHarness,
  readAuthorityRow,
  response,
  seed,
  taintedItems,
} from './helpers/finding-interpretation-case-store-fixture.js';
import { applyFindingLedgerFixtureRevision } from './helpers/finding-lifecycle-fixture.js';

afterEach(cleanupInterpretationCaseRoots);

function attemptFor(
  attempts: readonly InterpretationAttempt[],
  plannedCase: Pick<InterpretationCase, 'caseId'>,
): InterpretationAttempt {
  const attempt = attempts.find((candidate) => candidate.caseId === plannedCase.caseId);
  if (attempt === undefined) {
    throw new Error(`Expected an attempt for case "${plannedCase.caseId}"`);
  }
  return attempt;
}

function expectExactRawOutcomeIds(
  outcomes: readonly { rawFindingId: string }[],
  expectedRawFindingIds: readonly string[],
): void {
  const actual = outcomes.map((outcome) => outcome.rawFindingId).sort(compareBinaryStrings);
  const expected = [...expectedRawFindingIds].sort(compareBinaryStrings);
  expect(outcomes).toHaveLength(expected.length);
  expect(actual).toEqual(expected);
  expect(new Set(actual).size).toBe(expected.length);
}

function sameLineageCases(
  ledger: FindingLedger,
  specs: readonly {
    rawFindingId: string;
    reviewerPersonaKey: string;
    evidenceLine: number;
  }[],
) {
  return specs.flatMap((spec) => taintedItems({
    rawFindingIds: [spec.rawFindingId],
    ledger,
    reviewerPersonaKey: spec.reviewerPersonaKey,
    evidenceLine: spec.evidenceLine,
  }));
}

describe('interpretation case SQLite begin transaction', () => {
  it('commits raws, observations, pending outcomes, and a started attempt before provider work', async () => {
    const harness = openHarness();
    const ledger = emptyLedger();
    await seed(harness, ledger);
    const items = taintedItems({
      rawFindingIds: ['raw-a', 'raw-b'],
      ledger,
      relation: 'new',
      targetFindingId: null,
    });
    const before = readAuthorityRow(harness.root);

    const begun = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });

    expect(begun.providerCases).toHaveLength(1);
    const plannedCase = begun.providerCases[0]!;
    const attempt = attemptFor(begun.attempts, plannedCase);
    harness.resolver.close();
    const reopened = openHarness({ root: harness.root });
    const stored = reopened.store.loadLedger();
    const row = readAuthorityRow(reopened.root);
    expect(row.revision).toBe(before.revision + 1);
    expect(parseFindingLedger(JSON.parse(row.ledgerJson))).toEqual(stored);
    expect(stored.rawFindings.map((raw) => raw.rawFindingId))
      .toEqual(expect.arrayContaining(items.map((item) => item.wire.rawFindingId)));
    expect(stored.interpretationRawObservations).toEqual(items.map((item) => expect.objectContaining({
      rawFindingId: item.canonical.rawFindingId,
      caseId: plannedCase.caseId,
      cohortId: attempt.cohortId,
      lineageKey: plannedCase.lineageKey,
      semanticProjectionDigest: plannedCase.semanticProjectionDigest,
      observationDigest: expect.any(String),
      rawCanonicalSnapshotId: expect.any(String),
      caseSnapshotId: attempt.caseSnapshotId,
    })));
    expect(stored.rawCanonicalSnapshots).toHaveLength(items.length);
    expect(stored.interpretationCaseSnapshots).toEqual([
      expect.objectContaining({ caseSnapshotId: attempt.caseSnapshotId }),
    ]);
    expect(stored.interpretationAttempts).toEqual([expect.objectContaining({
      attemptId: attempt.attemptId,
      caseId: plannedCase.caseId,
      cohortId: attempt.cohortId,
      lineageKey: items[0]!.canonical.lineageKey,
      attemptOrdinal: 1,
      retryOrdinal: 0,
      caseSnapshotId: attempt.caseSnapshotId,
      providerCallId: expect.any(String),
      stage: 'started',
      rawFindingIds: plannedCase.members
        .map((member) => member.rawFindingId)
        .sort(compareBinaryStrings),
    })]);
    expect(stored.interpretationAttempts[0]).not.toHaveProperty('generation');
    expect(stored.interpretationAttempts[0]).not.toHaveProperty('landing');
    expect(stored.interpretationAttempts[0]).not.toHaveProperty('members');
    expect(stored.interpretationAttempts[0]).not.toHaveProperty('canonicalIntegrityDigest');
    expect(stored.interpretationAttempts[0]).not.toHaveProperty('proofBinding');
    expect(stored.rawInterpretationOutcomes).toEqual(items.map((item) => ({
      rawFindingId: item.canonical.rawFindingId,
      kind: 'pending_attempt',
      attemptId: attempt.attemptId,
    })));
    expect(stored.findingManagerProviderCalls).toEqual([
      expect.objectContaining({
        providerCallId: attempt.providerCallId,
        state: 'reserved',
        attemptIds: [attempt.attemptId],
      }),
    ]);
    reopened.resolver.close();
  });

  it('rejects an identity-consistent retryOrdinal 2 ledger at the load boundary', async () => {
    const harness = openHarness();
    const ledger = emptyLedger();
    await seed(harness, ledger);
    const begun = await harness.beginInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-retry-contract'], ledger }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    const stored = harness.store.loadLedger();
    const originalAttempt = begun.attempts[0]!;
    const originalCall = stored.findingManagerProviderCalls[0]!;
    const attemptId = computeInterpretationAttemptId(
      originalAttempt.caseSnapshotId,
      originalAttempt.attemptOrdinal,
      2,
    );
    const providerCallId = computeFindingManagerProviderCallId({
      budgetScopeId: originalCall.budgetScopeId,
      callOrdinal: originalCall.callOrdinal,
      purpose: originalCall.purpose,
      attemptIds: [attemptId],
      requestDigest: originalCall.requestDigest,
    });
    const retryOrdinalTwoLedger = {
      ...stored,
      interpretationAttempts: [{
        ...originalAttempt,
        attemptId,
        retryOrdinal: 2,
        providerCallId,
      }],
      rawInterpretationOutcomes: stored.rawInterpretationOutcomes.map((outcome) => ({
        ...outcome,
        attemptId,
      })),
      findingManagerProviderCalls: [{
        ...originalCall,
        providerCallId,
        ownerAttemptId: attemptId,
        attemptIds: [attemptId],
      }],
    };

    expect(() => parseFindingLedger(retryOrdinalTwoLedger)).toThrow();
    harness.resolver.close();
  });

  it('atomically hands pending outcomes from a crashed dispatched attempt to its retry', async () => {
    let harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    const items = taintedItems({ rawFindingIds: ['raw-dispatched-crash'], ledger });
    const first = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    const firstAttempt = first.attempts[0]!;
    const firstCall = harness.store.loadLedger().findingManagerProviderCalls.find(
      ({ providerCallId }) => providerCallId === firstAttempt.providerCallId,
    )!;
    const requestBytes = JSON.stringify(first.providerCases.map(({ caseId }) => caseId).sort());
    await harness.store.updateLedger((current) => ({
      ledger: {
        ...current,
        findingManagerProviderCalls: dispatchFindingManagerProviderCall({
          calls: current.findingManagerProviderCalls,
          providerCallId: firstCall.providerCallId,
          requestBytes,
          adapterSupportsUtf8ByteUpperBound: true,
          dispatchedAt: OBSERVATION,
        }).calls,
      },
      result: undefined,
    }));
    harness.resolver.close();

    harness = openHarness({ root: harness.root });
    const retried = await harness.beginInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-dispatched-crash'],
        ledger: harness.store.loadLedger(),
      }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    const retryAttempt = retried.attempts[0]!;
    const stored = harness.store.loadLedger();

    expect(stored.interpretationAttempts).toEqual([
      expect.objectContaining({
        attemptId: firstAttempt.attemptId,
        attemptOrdinal: 1,
        retryOrdinal: 0,
        stage: 'interrupted',
      }),
      expect.objectContaining({
        attemptId: retryAttempt.attemptId,
        attemptOrdinal: 1,
        retryOrdinal: 1,
        stage: 'started',
      }),
    ]);
    expect(stored.rawInterpretationOutcomes).toEqual([
      expect.objectContaining({
        kind: 'pending_attempt',
        attemptId: retryAttempt.attemptId,
        rawFindingId: items[0]!.canonical.rawFindingId,
      }),
    ]);
    expect(stored.findingManagerProviderCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerCallId: firstCall.providerCallId,
        state: 'settled',
        resultKind: 'interrupted_unknown',
      }),
      expect.objectContaining({
        providerCallId: retryAttempt.providerCallId,
        state: 'reserved',
      }),
    ]));
    harness.resolver.close();
  });

  it('returns retry ownership to the interrupted attempt when retry reservation is rejected', async () => {
    const budgetLimits = {
      maxCallsPerRound: 1,
      maxAdapterVisibleInputTokensPerCall: 24_000,
      maxOutputTokensPerCall: 10_000,
      maxChargedInputTokensPerRound: 64_000,
      maxChargedOutputTokensPerRound: 40_000,
    };
    let harness = openHarness({ budgetLimits });
    const ledger = baseLedger();
    await seed(harness, ledger);
    const rawFindingId = 'raw-retry-reservation-rejected';
    const items = taintedItems({ rawFindingIds: [rawFindingId], ledger });
    const first = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    const firstAttempt = first.attempts[0]!;
    const requestBytes = JSON.stringify(first.providerCases.map(({ caseId }) => caseId).sort());
    await harness.store.updateLedger((current) => ({
      ledger: {
        ...current,
        findingManagerProviderCalls: dispatchFindingManagerProviderCall({
          calls: current.findingManagerProviderCalls,
          providerCallId: firstAttempt.providerCallId,
          requestBytes,
          adapterSupportsUtf8ByteUpperBound: true,
          dispatchedAt: OBSERVATION,
        }).calls,
      },
      result: undefined,
    }));
    harness.resolver.close();

    harness = openHarness({ root: harness.root, budgetLimits });
    const resumed = await harness.beginInterpretationCases({
      items: taintedItems({ rawFindingIds: [rawFindingId], ledger: harness.store.loadLedger() }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    const stored = harness.store.loadLedger();

    expect(resumed.providerCases).toEqual([]);
    expect(resumed.attempts).toEqual([]);
    expect(stored.interpretationAttempts).toEqual([
      expect.objectContaining({
        attemptId: firstAttempt.attemptId,
        retryOrdinal: 0,
        stage: 'interrupted',
      }),
    ]);
    expect(stored.rawInterpretationOutcomes).toEqual([
      expect.objectContaining({
        rawFindingId: items[0]!.canonical.rawFindingId,
        kind: 'provisional',
      }),
    ]);
    expect(stored.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'open',
        provisional: expect.objectContaining({ kind: 'manager-budget-exhausted' }),
      }),
    ]));
    expect(stored.findingManagerProviderCalls).toEqual([
      expect.objectContaining({
        providerCallId: firstAttempt.providerCallId,
        state: 'settled',
        resultKind: 'interrupted_unknown',
      }),
    ]);
    harness.resolver.close();
  });

  it('fails fast when resume changes limits for the same provider budget round', async () => {
    const initialLimits = {
      maxCallsPerRound: 2,
      maxAdapterVisibleInputTokensPerCall: 24_000,
      maxOutputTokensPerCall: 10_000,
      maxChargedInputTokensPerRound: 48_000,
      maxChargedOutputTokensPerRound: 20_000,
    };
    let harness = openHarness({ budgetLimits: initialLimits });
    const ledger = baseLedger();
    await seed(harness, ledger);
    await harness.beginInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-limits-before-resume'], ledger }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    const root = harness.root;
    harness.resolver.close();

    harness = openHarness({
      root,
      budgetLimits: { ...initialLimits, maxCallsPerRound: 3 },
    });
    const beforeResume = readAuthorityRow(root);
    await expect(harness.beginInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-limits-after-resume'],
        ledger: harness.store.loadLedger(),
        evidenceLine: 2,
      }),
      provisionalOnlyRawFindingIds: new Set(),
    })).rejects.toThrow(/limits do not match/u);

    expect(readAuthorityRow(root)).toEqual(beforeResume);
    expect(harness.store.loadLedger().findings.some(
      (finding) => finding.provisional?.kind === 'manager-budget-exhausted',
    )).toBe(false);
    harness.resolver.close();
  });

  it('keeps typed call-count exhaustion as a provisional landing plan', async () => {
    const harness = openHarness({
      budgetLimits: {
        maxCallsPerRound: 1,
        maxAdapterVisibleInputTokensPerCall: 100_000,
        maxOutputTokensPerCall: 10_000,
        maxChargedInputTokensPerRound: 100_000,
        maxChargedOutputTokensPerRound: 10_000,
      },
    });
    const ledger = baseLedger();
    await seed(harness, ledger);
    const items = Array.from({ length: 17 }, (_, index) => taintedItems({
      rawFindingIds: [`raw-typed-budget-${index + 1}`],
      ledger,
      description: `Typed budget exhaustion case ${index + 1}.`,
      evidenceLine: index + 1,
    })[0]!);

    const begun = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });

    expect(begun.providerCases).toHaveLength(16);
    expect(begun.directPlans).toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({ kind: 'provisional' }),
        unreservedAuthority: expect.objectContaining({
          reason: 'manager-budget-exhausted',
        }),
      }),
    ]);
    harness.resolver.close();
  });

  it('lands a retry that crashes after dispatch as provisional without creating a third attempt', async () => {
    let harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    const rawFindingId = 'raw-retry-dispatched-crash';
    const first = await harness.beginInterpretationCases({
      items: taintedItems({ rawFindingIds: [rawFindingId], ledger }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    const canonicalRawFindingId = first.providerCases[0]!.members[0]!.rawFindingId;
    const firstAttempt = first.attempts[0]!;
    await harness.store.updateLedger((current) => ({
      ledger: {
        ...current,
        findingManagerProviderCalls: dispatchFindingManagerProviderCall({
          calls: current.findingManagerProviderCalls,
          providerCallId: firstAttempt.providerCallId,
          requestBytes: JSON.stringify(first.providerCases.map(({ caseId }) => caseId).sort()),
          adapterSupportsUtf8ByteUpperBound: true,
          dispatchedAt: OBSERVATION,
        }).calls,
      },
      result: undefined,
    }));
    harness.resolver.close();

    harness = openHarness({ root: harness.root });
    const retry = await harness.beginInterpretationCases({
      items: taintedItems({ rawFindingIds: [rawFindingId], ledger: harness.store.loadLedger() }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    const retryAttempt = retry.attempts[0]!;
    await harness.store.updateLedger((current) => ({
      ledger: {
        ...current,
        findingManagerProviderCalls: dispatchFindingManagerProviderCall({
          calls: current.findingManagerProviderCalls,
          providerCallId: retryAttempt.providerCallId,
          requestBytes: JSON.stringify(retry.providerCases.map(({ caseId }) => caseId).sort()),
          adapterSupportsUtf8ByteUpperBound: true,
          dispatchedAt: OBSERVATION,
        }).calls,
      },
      result: undefined,
    }));
    harness.resolver.close();

    harness = openHarness({ root: harness.root });
    const exhausted = await harness.beginInterpretationCases({
      items: taintedItems({ rawFindingIds: [rawFindingId], ledger: harness.store.loadLedger() }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    const stored = harness.store.loadLedger();

    expect(exhausted.providerCases).toEqual([]);
    expect(exhausted.attempts).toEqual([]);
    expect(stored.interpretationAttempts).toEqual([
      expect.objectContaining({
        attemptId: firstAttempt.attemptId,
        retryOrdinal: 0,
        stage: 'interrupted',
      }),
      expect.objectContaining({
        attemptId: retryAttempt.attemptId,
        retryOrdinal: 1,
        stage: 'interrupted',
      }),
    ]);
    expect(stored.rawInterpretationOutcomes).toEqual([
      expect.objectContaining({ rawFindingId: canonicalRawFindingId, kind: 'provisional' }),
    ]);
    expect(stored.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'open',
        provisional: expect.objectContaining({ kind: 'interpretation-interrupted' }),
      }),
    ]));
    expect(stored.lifecycleReservations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        authority: expect.objectContaining({
          kind: 'interpretation_unreserved_landing',
          reason: 'interpretation-interrupted',
        }),
      }),
    ]));
    expect(stored.findingManagerProviderCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerCallId: retryAttempt.providerCallId,
        state: 'settled',
        resultKind: 'interrupted_unknown',
      }),
    ]));
    harness.resolver.close();
  });

  it('cleans every unreserved registry when the third batch of 33 cases exceeds budget', async () => {
    const harness = openHarness({
      budgetLimits: {
        maxCallsPerRound: 4,
        maxAdapterVisibleInputTokensPerCall: 24_000,
        maxOutputTokensPerCall: 10_000,
        maxChargedInputTokensPerRound: 64_000,
        maxChargedOutputTokensPerRound: 40_000,
      },
    });
    const ledger = baseLedger();
    await seed(harness, ledger);
    const items = Array.from({ length: 33 }, (_, index) => taintedItems({
      rawFindingIds: [`raw-budget-cleanup-${index + 1}`],
      ledger,
      description: `Distinct semantic defect ${index + 1}.`,
      evidenceLine: index + 1,
    })[0]!);

    const begun = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    const stored = harness.store.loadLedger();
    const leasedCaseIds = new Set(begun.providerCases.map(({ caseId }) => caseId));
    const leasedRawFindingIds = new Set(begun.attempts.flatMap(({ rawFindingIds }) => rawFindingIds));

    expect(begun.providerCases).toHaveLength(32);
    expect(begun.attempts).toHaveLength(32);
    expect(begun.directPlans).toHaveLength(1);
    expect(stored.findingManagerProviderCalls).toHaveLength(2);
    expect(stored.interpretationCaseSnapshots).toHaveLength(32);
    expect(stored.interpretationCaseSnapshots.every(({ caseId }) => leasedCaseIds.has(caseId)))
      .toBe(true);
    expect(stored.interpretationRawObservations).toHaveLength(32);
    expect(stored.interpretationRawObservations.every(({ rawFindingId }) => (
      leasedRawFindingIds.has(rawFindingId)
    ))).toBe(true);
    expect(stored.interpretationRecoveryOriginBindings.every(({ caseId }) => (
      leasedCaseIds.has(caseId)
    ))).toBe(true);
    expect(stored.rawCanonicalSnapshots.filter(({ rawFindingId }) => (
      leasedRawFindingIds.has(rawFindingId)
    ))).toHaveLength(32);
    expect(stored.rawFindings.filter(({ rawFindingId }) => (
      leasedRawFindingIds.has(rawFindingId)
    ))).toHaveLength(32);
    harness.resolver.close();
  });

  it('is idempotent for the same raw payload and rejects another payload without a DB write', async () => {
    const harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    const original = taintedItems({ rawFindingIds: ['raw-a'], ledger });
    const first = await harness.beginInterpretationCases({
      items: original,
      provisionalOnlyRawFindingIds: new Set(),
    });
    const afterFirst = readAuthorityRow(harness.root);

    await expect(harness.beginInterpretationCases({
      items: original,
      provisionalOnlyRawFindingIds: new Set(),
    })).resolves.toEqual(first);
    expect(readAuthorityRow(harness.root)).toEqual(afterFirst);

    await expect(harness.beginInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-a'],
        ledger,
        description: 'Different payload under the same raw identity.',
      }),
      provisionalOnlyRawFindingIds: new Set(),
    })).rejects.toThrow(/same raw.*different payload/i);
    expect(readAuthorityRow(harness.root)).toEqual(afterFirst);
    harness.resolver.close();
  });

  it('resumes the same reserved attempt after reopen without consuming a retry', async () => {
    let harness = openHarness({ maxEpochsPerLineage: 3 });
    const ledger = baseLedger();
    await seed(harness, ledger);
    const items = taintedItems({ rawFindingIds: ['raw-epoch'], ledger });
    const first = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    harness.resolver.close();

    harness = openHarness({ root: harness.root, maxEpochsPerLineage: 3 });
    const retried = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    expect(retried.providerCases).toHaveLength(1);
    expect(harness.store.loadLedger().interpretationAttempts).toEqual([
      expect.objectContaining({
        attemptId: first.attempts[0]!.attemptId,
        attemptOrdinal: 1,
        retryOrdinal: 0,
        stage: 'started',
      }),
    ]);

    const retriedCase = retried.providerCases[0]!;
    await harness.completeInterpretationCases({
      receipt: retried.receipt,
      responses: [response(attemptFor(retried.attempts, retriedCase), {
        kind: 'provisional',
        reason: 'settled',
      })],
      providerFailures: [],
    });
    harness.resolver.close();

    harness = openHarness({ root: harness.root, maxEpochsPerLineage: 3 });
    const completedReplay = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    expect(completedReplay.providerCases).toEqual([]);
    expect(completedReplay.completedAttemptIdsForCommit).toEqual([
      retried.attempts[0]!.attemptId,
    ]);
    expect(harness.store.loadLedger().interpretationAttempts.filter(
      (attempt) => attempt.stage === 'started',
    )).toEqual([]);

    const changed = await harness.beginInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-epoch-changed'],
        ledger: harness.store.loadLedger(),
        evidenceLine: 2,
      }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    expect(changed.providerCases).toHaveLength(1);
    expect(harness.store.loadLedger().interpretationAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ attemptOrdinal: 1, retryOrdinal: 0, stage: 'completed' }),
      expect.objectContaining({ attemptOrdinal: 2, retryOrdinal: 0, stage: 'started' }),
    ]));
    harness.resolver.close();
  });

  it('keeps persisted pending ownership ahead of a proof that becomes available later', async () => {
    let harness = openHarness();
    const ledger = addExactProductFinding(baseLedger({
      title: 'Shared semantic defect',
      description: 'The same defect remains observable.',
    }), 'F-0002', 'F-0001');
    await seed(harness, ledger);
    const initialItems = taintedItems({ rawFindingIds: ['raw-pending-proof'], ledger });
    const first = await harness.beginInterpretationCases({
      items: initialItems,
      provisionalOnlyRawFindingIds: new Set(),
    });
    expect(first.providerCases).toHaveLength(1);

    await harness.store.updateLedger((current) => {
      const duplicate = current.findings.find((finding) => finding.id === 'F-0002')!;
      return {
        ledger: applyFindingLedgerFixtureRevision({
          ledger: current,
          entityKind: 'finding',
          entity: {
            ...duplicate,
            status: 'resolved',
            lifecycle: 'resolved',
            revision: duplicate.revision + 1,
            resolvedAt: '2026-08-02T00:01:00.000Z',
            resolvedEvidence: 'Duplicate product finding was resolved.',
            lastSeen: {
              ...duplicate.lastSeen,
              timestamp: '2026-08-02T00:01:00.000Z',
            },
          },
        }),
        result: undefined,
      };
    });
    harness.resolver.close();

    harness = openHarness({ root: harness.root });
    const retried = await harness.beginInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-pending-proof'],
        ledger: harness.store.loadLedger(),
      }),
      provisionalOnlyRawFindingIds: new Set(),
    });

    expect(retried.proofFastPathPlans).toEqual([]);
    expect(retried.providerCases).toHaveLength(1);
    expect(harness.store.loadLedger().interpretationAttempts).toEqual([
      expect.objectContaining({
        attemptId: first.attempts[0]!.attemptId,
        attemptOrdinal: 1,
        retryOrdinal: 0,
        stage: 'started',
      }),
    ]);
    harness.resolver.close();
  });

  it('plans a new semantic epoch as direct provisional when the epoch budget is exhausted', async () => {
    const harness = openHarness({ maxEpochsPerLineage: 1 });
    const ledger = baseLedger();
    await seed(harness, ledger);
    const first = await harness.beginInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-budget-1'], ledger }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    await harness.completeInterpretationCases({
      receipt: first.receipt,
      responses: [response(first.providerCases[0]!, {
        kind: 'provisional',
        reason: 'First semantic epoch settled.',
      })],
      providerFailures: [],
    });
    const beforeExhausted = readAuthorityRow(harness.root);
    const attemptsBeforeExhausted = harness.store.loadLedger().interpretationAttempts;

    const exhausted = await harness.beginInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-budget-2'],
        ledger: harness.store.loadLedger(),
        evidenceLine: 2,
      }),
      provisionalOnlyRawFindingIds: new Set(),
    });

    expect(exhausted.providerCases).toEqual([]);
    expect(exhausted.attempts).toEqual([]);
    expect(exhausted.proofFastPathPlans).toEqual([]);
    expect(exhausted.directPlans).toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({ kind: 'provisional' }),
      }),
    ]);
    expect(readAuthorityRow(harness.root)).toEqual(beforeExhausted);
    expect(harness.store.loadLedger().interpretationAttempts).toEqual(attemptsBeforeExhausted);
    harness.resolver.close();
  });

  it('retries an existing started epoch after the configured budget is lowered', async () => {
    let harness = openHarness({ maxEpochsPerLineage: 3 });
    const ledger = baseLedger();
    await seed(harness, ledger);
    const first = await harness.beginInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-lowered-1'], ledger }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    await harness.completeInterpretationCases({
      receipt: first.receipt,
      responses: [response(first.providerCases[0]!, {
        kind: 'provisional',
        reason: 'First semantic epoch settled.',
      })],
      providerFailures: [],
    });
    const secondItems = taintedItems({
      rawFindingIds: ['raw-lowered-2'],
      ledger: harness.store.loadLedger(),
      evidenceLine: 2,
    });
    const second = await harness.beginInterpretationCases({
      items: secondItems,
      provisionalOnlyRawFindingIds: new Set(),
    });
    expect(second.attempts[0]).toEqual(expect.objectContaining({
      attemptOrdinal: 2,
      retryOrdinal: 0,
      stage: 'started',
    }));
    harness.resolver.close();

    harness = openHarness({ root: harness.root, maxEpochsPerLineage: 1 });
    const retried = await harness.beginInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-lowered-2'],
        ledger: harness.store.loadLedger(),
        evidenceLine: 2,
      }),
      provisionalOnlyRawFindingIds: new Set(),
    });

    expect(retried.providerCases).toHaveLength(1);
    expect(retried.attempts).toEqual([
      expect.objectContaining({
        attemptOrdinal: 2,
        retryOrdinal: 0,
        stage: 'started',
      }),
    ]);
    expect(harness.store.loadLedger().interpretationAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attemptId: second.attempts[0]!.attemptId,
        attemptOrdinal: 2,
        retryOrdinal: 0,
        stage: 'started',
      }),
    ]));
    harness.resolver.close();
  });

  it('rejects canonical digest drift for an observed raw without a DB write', async () => {
    const harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    await harness.beginInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-canonical-drift'],
        ledger,
        clarificationAttempted: true,
      }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    const beforeDrift = readAuthorityRow(harness.root);

    await expect(harness.beginInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-canonical-drift'],
        ledger: harness.store.loadLedger(),
        clarificationAttempted: false,
      }),
      provisionalOnlyRawFindingIds: new Set(),
    })).rejects.toThrow(/observation|canonical|incompatible/i);

    expect(readAuthorityRow(harness.root)).toEqual(beforeDrift);
    harness.resolver.close();
  });

  it('allocates a bounded number of new same-lineage epochs in binary case order', async () => {
    const specs = [
      { rawFindingId: 'raw-order-a', reviewerPersonaKey: 'reviewer-a', evidenceLine: 1 },
      { rawFindingId: 'raw-order-b', reviewerPersonaKey: 'reviewer-b', evidenceLine: 2 },
      { rawFindingId: 'raw-order-c', reviewerPersonaKey: 'reviewer-c', evidenceLine: 3 },
    ];
    const run = async (orderedSpecs: typeof specs) => {
      const harness = openHarness({ maxEpochsPerLineage: 2 });
      const ledger = baseLedger();
      await seed(harness, ledger);
      const begun = await harness.beginInterpretationCases({
        items: sameLineageCases(ledger, orderedSpecs),
        provisionalOnlyRawFindingIds: new Set(),
      });
      const allocation = begun.providerCases.map((plannedCase) => ({
        caseId: plannedCase.caseId,
        attemptOrdinal: attemptFor(begun.attempts, plannedCase).attemptOrdinal,
      }));
      const directCaseIds = begun.directPlans.map((plan) => plan.plannedCase.caseId);
      harness.resolver.close();
      return { allocation, directCaseIds };
    };

    const forward = await run(specs);
    const reversed = await run([...specs].reverse());

    expect(forward).toEqual(reversed);
    expect(forward.allocation).toHaveLength(2);
    expect(forward.allocation.map((entry) => entry.attemptOrdinal)).toEqual([1, 2]);
    expect(forward.allocation.map((entry) => entry.caseId)).toEqual(
      [...forward.allocation.map((entry) => entry.caseId)].sort(compareBinaryStrings),
    );
    expect(forward.directCaseIds).toHaveLength(1);
  });

  it('retries an existing cohort without consuming budget needed by a new same-lineage case', async () => {
    const harness = openHarness({ maxEpochsPerLineage: 1 });
    const ledger = baseLedger();
    await seed(harness, ledger);
    const retryItems = sameLineageCases(ledger, [{
      rawFindingId: 'raw-retry-mixed',
      reviewerPersonaKey: 'reviewer-retry',
      evidenceLine: 1,
    }]);
    const first = await harness.beginInterpretationCases({
      items: retryItems,
      provisionalOnlyRawFindingIds: new Set(),
    });

    const mixed = await harness.beginInterpretationCases({
      items: [
        ...retryItems,
        ...sameLineageCases(harness.store.loadLedger(), [{
          rawFindingId: 'raw-new-over-budget',
          reviewerPersonaKey: 'reviewer-new',
          evidenceLine: 2,
        }]),
      ],
      provisionalOnlyRawFindingIds: new Set(),
    });

    expect(mixed.providerCases).toHaveLength(1);
    expect(mixed.providerCases[0]!.caseId).toBe(first.providerCases[0]!.caseId);
    expect(mixed.attempts).toEqual([
      expect.objectContaining({
        attemptOrdinal: 1,
        retryOrdinal: 0,
        stage: 'started',
      }),
    ]);
    expect(mixed.directPlans).toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({ kind: 'provisional' }),
      }),
    ]);
    harness.resolver.close();
  });

  it('does not consume an epoch for a direct no-attempt case mixed with a provider case', async () => {
    const harness = openHarness({ maxEpochsPerLineage: 1 });
    const ledger = baseLedger();
    await seed(harness, ledger);
    const directItems = [
      ...sameLineageCases(ledger, [{
        rawFindingId: 'raw-direct-a',
        reviewerPersonaKey: 'reviewer-direct',
        evidenceLine: 1,
      }]),
      ...sameLineageCases(ledger, [{
        rawFindingId: 'raw-direct-b',
        reviewerPersonaKey: 'reviewer-direct',
        evidenceLine: 2,
      }]),
    ];
    const providerItems = sameLineageCases(ledger, [{
      rawFindingId: 'raw-after-direct',
      reviewerPersonaKey: 'reviewer-provider',
      evidenceLine: 3,
    }]);

    const begun = await harness.beginInterpretationCases({
      items: [...directItems, ...providerItems],
      provisionalOnlyRawFindingIds: new Set(),
    });

    expect(begun.directPlans).toHaveLength(1);
    expect(begun.providerCases).toHaveLength(1);
    expect(begun.attempts).toEqual([
      expect.objectContaining({ attemptOrdinal: 1, retryOrdinal: 0 }),
    ]);
    const stored = harness.store.loadLedger();
    expect(stored.rawFindings.some((rawFinding) => (
      rawFinding.rawFindingId === providerItems[0]!.canonical.rawFindingId
    ))).toBe(true);
    expect(stored.rawFindings.some((rawFinding) => (
      directItems.some((item) => item.canonical.rawFindingId === rawFinding.rawFindingId)
    ))).toBe(false);
    expect(stored.interpretationRawObservations.map((observation) => observation.rawFindingId))
      .toEqual(providerItems.map((item) => item.canonical.rawFindingId));
    harness.resolver.close();
  });

  it('does not consume an epoch for a SameProof case mixed with a provider case', async () => {
    const harness = openHarness({ maxEpochsPerLineage: 1 });
    const ledger = baseLedger({
      title: 'Shared semantic defect',
      description: 'The same defect remains observable.',
    });
    await seed(harness, ledger);
    const proofItems = taintedItems({
      rawFindingIds: ['raw-proof-no-epoch'],
      ledger,
      reviewerPersonaKey: 'reviewer-proof-mixed',
    });
    const providerItems = taintedItems({
      rawFindingIds: ['raw-confirmation-provider'],
      ledger,
      reviewerPersonaKey: 'reviewer-proof-mixed',
      relation: 'resolution_confirmation',
    });

    const begun = await harness.beginInterpretationCases({
      items: [...proofItems, ...providerItems],
      provisionalOnlyRawFindingIds: new Set(),
    });

    expect(begun.proofFastPathPlans).toHaveLength(1);
    expect(begun.providerCases).toHaveLength(1);
    expect(begun.attempts).toEqual([
      expect.objectContaining({ attemptOrdinal: 1, retryOrdinal: 0 }),
    ]);
    const stored = harness.store.loadLedger();
    expect(stored.rawFindings.some((rawFinding) => (
      rawFinding.rawFindingId === providerItems[0]!.canonical.rawFindingId
    ))).toBe(true);
    expect(stored.rawFindings.some((rawFinding) => (
      proofItems.some((item) => item.canonical.rawFindingId === rawFinding.rawFindingId)
    ))).toBe(false);
    expect(stored.interpretationRawObservations.map((observation) => observation.rawFindingId))
      .toEqual(providerItems.map((item) => item.canonical.rawFindingId));
    harness.resolver.close();
  });
});

describe('interpretation case SQLite completion transaction', () => {
  it.each([
    {
      name: 'confirmation create',
      relation: 'resolution_confirmation' as const,
      provisionalOnly: false,
      decision: { kind: 'create_independent' as const },
    },
    {
      name: 'provisional-only conflict',
      relation: 'persists' as const,
      provisionalOnly: true,
      decision: { kind: 'open_conflict' as const, targetFindingId: 'F-0001' },
    },
    {
      name: 'outside conflict target',
      relation: 'persists' as const,
      provisionalOnly: false,
      decision: { kind: 'open_conflict' as const, targetFindingId: 'F-9999' },
    },
  ])('completes forbidden provider decision $name as case-wide provisional', async (fixture) => {
    const harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    const items = taintedItems({
      rawFindingIds: [`raw-${fixture.name}`],
      ledger,
      relation: fixture.relation,
    });
    const provisionalOnlyRawFindingIds = fixture.provisionalOnly
      ? new Set([items[0]!.canonical.rawFindingId])
      : new Set<string>();
    const begun = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds,
    });

    await harness.completeInterpretationCases({
      receipt: begun.receipt,
      responses: [response(begun.providerCases[0]!, fixture.decision)],
      providerFailures: [],
    });

    expect(harness.store.loadLedger().interpretationAttempts).toEqual([
      expect.objectContaining({
        stage: 'completed',
        decision: expect.objectContaining({ kind: 'provisional' }),
      }),
    ]);
    harness.resolver.close();
  });

  it('completes a stale conflict target as provisional instead of failing the run', async () => {
    const harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    const begun = await harness.beginInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-stale-conflict'], ledger }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    await harness.store.updateLedger((current) => ({
      ledger: applyFindingLedgerFixtureRevision({
        ledger: current,
        entityKind: 'finding',
        entity: {
          ...current.findings[0]!,
          revision: current.findings[0]!.revision + 1,
          lifecycle: 'persists',
          lastSeen: {
            ...current.findings[0]!.lastSeen,
            timestamp: '2026-08-02T00:01:00.000Z',
          },
        },
      }),
      result: undefined,
    }));

    await harness.completeInterpretationCases({
      receipt: begun.receipt,
      responses: [response(begun.providerCases[0]!, {
        kind: 'open_conflict',
        targetFindingId: 'F-0001',
      })],
      providerFailures: [],
    });

    expect(harness.store.loadLedger().interpretationAttempts[0]).toEqual(
      expect.objectContaining({
        stage: 'completed',
        decision: expect.objectContaining({ kind: 'provisional' }),
      }),
    );
    harness.resolver.close();
  });

  it('rejects completion when the receipt belongs to another store object', async () => {
    const owner = openHarness();
    const ledger = baseLedger();
    await seed(owner, ledger);
    const begun = await owner.beginInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-other-store'], ledger }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    const other = openHarness({ root: owner.root });
    const before = readAuthorityRow(owner.root);

    await expect(other.completeInterpretationCases({
      receipt: begun.receipt,
      responses: [response(begun.providerCases[0]!, { kind: 'provisional', reason: 'x' })],
      providerFailures: [],
    })).rejects.toThrow(/no live context|store|late/i);
    expect(readAuthorityRow(owner.root).revision).toBe(before.revision + 1);
    other.resolver.close();
    owner.resolver.close();
  });

  it.each([
    {
      name: 'case id mismatch',
      alter: (plannedCase: Pick<InterpretationCase, 'caseId'>) => ({
        ...response(plannedCase, { kind: 'create_independent' } as const),
        caseId: 'f'.repeat(64),
      }),
    },
  ])('rejects a stale or forged $name after durable dispatch', async ({ alter }) => {
    const harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    const begun = await harness.beginInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-invalid-completion'],
        ledger,
        relation: 'new',
        targetFindingId: null,
      }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    const before = readAuthorityRow(harness.root);

    await expect(harness.completeInterpretationCases({
      receipt: begun.receipt,
      responses: [alter(begun.providerCases[0]!)],
      providerFailures: [],
    })).rejects.toThrow();

    expect(readAuthorityRow(harness.root).revision).toBe(before.revision + 1);
    harness.resolver.close();
  });

  it('rejects duplicate and response/failure overlap without settling the dispatched call', async () => {
    const harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    const begun = await harness.beginInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-duplicate'], ledger }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    const plannedCase = begun.providerCases[0]!;
    const completion = response(plannedCase, { kind: 'create_independent' });
    const before = readAuthorityRow(harness.root);

    await expect(harness.completeInterpretationCases({
      receipt: begun.receipt,
      responses: [completion, completion],
      providerFailures: [],
    })).rejects.toThrow();
    const afterDispatch = readAuthorityRow(harness.root);
    expect(afterDispatch.revision).toBe(before.revision + 1);

    await expect(harness.completeInterpretationCases({
      receipt: begun.receipt,
      responses: [completion],
      providerFailures: [failure(plannedCase, 'same case also failed')],
    })).rejects.toThrow();
    expect(readAuthorityRow(harness.root)).toEqual(afterDispatch);
    harness.resolver.close();
  });

  it('rejects a case owned by another begin receipt and rejects a late receipt replay', async () => {
    const harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    const first = await harness.beginInterpretationCases({
      items: taintedItems({ rawFindingIds: ['raw-batch-a'], ledger }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    const second = await harness.beginInterpretationCases({
      items: taintedItems({
        rawFindingIds: ['raw-batch-b'],
        ledger: harness.store.loadLedger(),
        familyTag: 'robustness',
      }),
      provisionalOnlyRawFindingIds: new Set(),
    });
    const beforeMixedReceipt = readAuthorityRow(harness.root);

    await expect(harness.completeInterpretationCases({
      receipt: first.receipt,
      responses: [response(second.providerCases[0]!, {
        kind: 'provisional',
        reason: 'belongs to another batch',
      })],
      providerFailures: [],
    })).rejects.toThrow(/batch|receipt|owned/i);
    expect(readAuthorityRow(harness.root).revision).toBe(beforeMixedReceipt.revision + 1);
    expect(harness.store.loadLedger().interpretationAttempts.find(
      (attempt) => attempt.caseId === second.providerCases[0]!.caseId,
    )).toMatchObject({ stage: 'started' });

    const firstResponse = response(first.providerCases[0]!, {
      kind: 'provisional',
      reason: 'settled first batch',
    });
    await harness.completeInterpretationCases({
      receipt: first.receipt,
      responses: [firstResponse],
      providerFailures: [],
    });
    const afterSettlement = readAuthorityRow(harness.root);
    await expect(harness.completeInterpretationCases({
      receipt: first.receipt,
      responses: [firstResponse],
      providerFailures: [],
    })).rejects.toThrow(/late|receipt|completed|settled/i);
    expect(readAuthorityRow(harness.root)).toEqual(afterSettlement);
    expect(harness.store.loadLedger().interpretationAttempts.find(
      (attempt) => attempt.caseId === second.providerCases[0]!.caseId,
    )).toMatchObject({ stage: 'started' });
    harness.resolver.close();
  });

  it('settles responses, explicit failures, and omitted attempts without creating terminal entities', async () => {
    const harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    const items = [
      ...taintedItems({ rawFindingIds: ['raw-a1', 'raw-a2'], ledger, description: 'Semantic A.' }),
      ...taintedItems({ rawFindingIds: ['raw-b'], ledger, description: 'Semantic B.' }),
      ...taintedItems({ rawFindingIds: ['raw-c'], ledger, description: 'Semantic C.' }),
    ];
    const begun = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    const [responded, failed] = begun.providerCases;
    await harness.completeInterpretationCases({
      receipt: begun.receipt,
      responses: [response(responded!, {
        kind: 'create_independent',
      })],
      providerFailures: [failure(
        failed!,
        'provider unavailable',
      )],
    });

    const completed = harness.store.loadLedger();
    expect(completed.interpretationAttempts).toHaveLength(3);
    expect(completed.interpretationAttempts.every((attempt) => attempt.stage === 'completed'))
      .toBe(true);
    expect(completed.interpretationAttempts.every((attempt) => !('landing' in attempt)))
      .toBe(true);
    expect(completed.findings).toEqual(ledger.findings);
    expectExactRawOutcomeIds(
      completed.rawInterpretationOutcomes,
      items.map((item) => item.canonical.rawFindingId),
    );
    expect(completed.rawInterpretationOutcomes.every(
      (outcome) => outcome.kind === 'pending_attempt',
    )).toBe(true);
    harness.resolver.close();
  });

});
