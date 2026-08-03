import { afterEach, describe, expect, it } from 'vitest';
import type { FindingLedger, FindingManagerValidationReport } from '../core/workflow/findings/types.js';
import {
  finalizeInterpretationCaseProjection,
  prepareInterpretationCaseActions,
} from '../core/workflow/findings/interpretation-case-finalizer.js';
import {
  OBSERVATION,
  addExactProductFinding,
  advanceOpenFindingRevision,
  baseLedger,
  cleanupInterpretationCaseRoots,
  openHarness,
  readAuthorityRow,
  response,
  seed,
  taintedItems,
} from './helpers/finding-interpretation-case-store-fixture.js';
import {
  settlePreparedConflictCase,
  settlePreparedInterpretationCases,
} from './helpers/finding-interpretation-case-finalizer-fixture.js';
import { applyFindingLedgerFixtureRevision } from './helpers/finding-lifecycle-fixture.js';

afterEach(cleanupInterpretationCaseRoots);

const ROUND_MARKER = 'interpretation-case-round';

function report(): FindingManagerValidationReport {
  return {
    version: 1,
    runId: OBSERVATION.runId,
    stepName: OBSERVATION.stepName,
    retryCount: 0,
    ledgerUpdated: true,
    finalErrors: [],
    attempts: [],
  };
}

describe('interpretation case pure preparation and finalization', () => {
  it('publishes multi-member creation and applied ownership atomically after rollback', async () => {
    const harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    const items = taintedItems({
      rawFindingIds: ['raw-create-a', 'raw-create-b'],
      ledger,
      relation: 'new',
      targetFindingId: null,
    });
    const begun = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    await harness.completeInterpretationCases({
      receipt: begun.receipt,
      responses: [response(begun.providerCases[0]!, { kind: 'create_independent' })],
      providerFailures: [],
    });
    const attemptId = begun.attempts[0]!.attemptId;
    const prepared = prepareInterpretationCaseActions({
      ledger: harness.store.loadLedger(),
      items,
      completedAttemptIds: [attemptId],
      directPlans: [],
      proofFastPathPlans: [],
      provisionalOnlyRawFindingIds: new Set(),
    });
    expect(prepared.managerOutput.newFindings).toEqual([
      expect.objectContaining({
        rawFindingIds: items.map((item) => item.canonical.rawFindingId),
      }),
    ]);
    const before = readAuthorityRow(harness.root);

    await expect(harness.store.commitManagerLedger((current) => {
      const settled = settlePreparedInterpretationCases({ ledger: current, items, prepared });
      finalizeInterpretationCaseProjection({ ledger: settled, prepared, observation: OBSERVATION });
      throw new Error('injected failure after pure finalization');
    })).rejects.toThrow(/injected failure/);
    expect(readAuthorityRow(harness.root)).toEqual(before);

    await harness.store.commitManagerLedger((current) => {
      const settled = settlePreparedInterpretationCases({ ledger: current, items, prepared });
      const finalized = finalizeInterpretationCaseProjection({
        ledger: settled,
        prepared,
        observation: OBSERVATION,
      });
      const completed = {
        ...finalized,
        stopBudget: {
          roundMarkers: [ROUND_MARKER],
          firstRoundAt: OBSERVATION.timestamp,
          exhausted: false,
        },
      };
      return {
        ledger: completed,
        result: completed,
        publication: { roundMarker: ROUND_MARKER, report: report() },
      };
    });

    const staged = harness.store.loadLedger();
    expect(staged.interpretationAttempts[0]).toMatchObject({ stage: 'completed' });
    expect(staged.rawInterpretationOutcomes.every((outcome) => outcome.kind === 'pending_attempt'))
      .toBe(true);
    const completed: FindingLedger = {
      workflowName: staged.workflowName,
      ...staged.pendingManagerCommit!.completed,
    };
    const outcomes = completed.rawInterpretationOutcomes;
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.kind === 'finding' && outcome.outcome === 'created'))
      .toBe(true);
    expect(new Set(outcomes.flatMap((outcome) => (
      outcome.kind === 'finding' ? [outcome.findingId] : []
    ))).size).toBe(1);
    expect(completed.interpretationAttempts[0]).toMatchObject({ stage: 'applied' });

    const publication = staged.pendingManagerCommit!.publication;
    const publicationReceipt = harness.store.publishManagerValidationPublication(publication);
    await harness.store.finalizeManagerValidationPublication(publication, publicationReceipt);
    expect(harness.store.loadLedger().interpretationAttempts[0]).toMatchObject({ stage: 'applied' });
    harness.resolver.close();
  });

  it('reopens a completed cohort and settles it from the fresh begin result without another provider call', async () => {
    let harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    const firstItems = taintedItems({
      rawFindingIds: ['raw-reopen-a', 'raw-reopen-b'],
      ledger,
      relation: 'new',
      targetFindingId: null,
    });
    const first = await harness.beginInterpretationCases({
      items: firstItems,
      provisionalOnlyRawFindingIds: new Set(),
    });
    await harness.completeInterpretationCases({
      receipt: first.receipt,
      responses: [response(first.providerCases[0]!, { kind: 'create_independent' })],
      providerFailures: [],
    });
    const root = harness.root;
    harness.resolver.close();

    harness = openHarness({ root });
    const items = taintedItems({
      rawFindingIds: ['raw-reopen-a', 'raw-reopen-b'],
      ledger: harness.store.loadLedger(),
      relation: 'new',
      targetFindingId: null,
    });
    const reopened = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    expect(reopened.providerCases).toEqual([]);
    expect(reopened.attempts).toEqual([]);
    expect(reopened.completedAttemptIdsForCommit).toHaveLength(1);

    await harness.store.updateLedger((current) => {
      const prepared = prepareInterpretationCaseActions({
        ledger: current,
        items,
        completedAttemptIds: reopened.completedAttemptIdsForCommit,
        directPlans: reopened.directPlans,
        proofFastPathPlans: reopened.proofFastPathPlans,
        provisionalOnlyRawFindingIds: new Set(),
      });
      const settled = settlePreparedInterpretationCases({
        ledger: current,
        items,
        prepared,
      });
      const finalized = finalizeInterpretationCaseProjection({
        ledger: settled,
        prepared,
        observation: OBSERVATION,
      });
      return { ledger: finalized, result: finalized };
    });

    const applied = harness.store.loadLedger();
    expect(applied.interpretationAttempts).toEqual([
      expect.objectContaining({ stage: 'applied' }),
    ]);
    expect(applied.rawInterpretationOutcomes).toHaveLength(2);
    expect(applied.rawInterpretationOutcomes.every((outcome) => (
      outcome.kind === 'finding' && outcome.outcome === 'created'
    ))).toBe(true);

    const idempotent = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    expect(idempotent.providerCases).toEqual([]);
    expect(idempotent.completedAttemptIdsForCommit).toEqual([]);
    expect(idempotent.directPlans).toEqual([]);
    expect(idempotent.proofFastPathPlans).toEqual([]);
    const terminalPrepared = prepareInterpretationCaseActions({
      ledger: applied,
      items,
      completedAttemptIds: idempotent.completedAttemptIdsForCommit,
      directPlans: idempotent.directPlans,
      proofFastPathPlans: idempotent.proofFastPathPlans,
      provisionalOnlyRawFindingIds: new Set(),
    });
    expect(terminalPrepared.cases).toEqual([]);
    expect(finalizeInterpretationCaseProjection({
      ledger: applied,
      prepared: terminalPrepared,
      observation: { ...OBSERVATION, timestamp: '2026-08-02T00:01:00.000Z' },
    })).toBe(applied);
    harness.resolver.close();
  });

  it('rejects canonical observation drift when preparing a completed cohort after reopen', async () => {
    let harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    const items = taintedItems({
      rawFindingIds: ['raw-reopen-drift'],
      ledger,
      clarificationAttempted: true,
    });
    const begun = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    await harness.completeInterpretationCases({
      receipt: begun.receipt,
      responses: [response(begun.providerCases[0]!, {
        kind: 'provisional',
        reason: 'Completed before reopening.',
      })],
      providerFailures: [],
    });
    const root = harness.root;
    harness.resolver.close();

    harness = openHarness({ root });
    const stableItems = taintedItems({
      rawFindingIds: ['raw-reopen-drift'],
      ledger: harness.store.loadLedger(),
      clarificationAttempted: true,
    });
    const reopened = await harness.beginInterpretationCases({
      items: stableItems,
      provisionalOnlyRawFindingIds: new Set(),
    });
    const driftedItems = taintedItems({
      rawFindingIds: ['raw-reopen-drift'],
      ledger: harness.store.loadLedger(),
      clarificationAttempted: false,
    });

    expect(() => prepareInterpretationCaseActions({
      ledger: harness.store.loadLedger(),
      items: driftedItems,
      completedAttemptIds: reopened.completedAttemptIdsForCommit,
      directPlans: reopened.directPlans,
      proofFastPathPlans: reopened.proofFastPathPlans,
      provisionalOnlyRawFindingIds: new Set(),
    })).toThrow(/observation drifted/i);
    harness.resolver.close();
  });

  it('lands one conflict and one holding provisional for the entire case', async () => {
    const harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    const items = taintedItems({ rawFindingIds: ['raw-conflict-a', 'raw-conflict-b'], ledger });
    const begun = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    await harness.completeInterpretationCases({
      receipt: begun.receipt,
      responses: [response(begun.providerCases[0]!, {
        kind: 'open_conflict',
        targetFindingId: 'F-0001',
      })],
      providerFailures: [],
    });
    const prepared = prepareInterpretationCaseActions({
      ledger: harness.store.loadLedger(),
      items,
      completedAttemptIds: [begun.attempts[0]!.attemptId],
      directPlans: [],
      proofFastPathPlans: [],
      provisionalOnlyRawFindingIds: new Set(),
    });
    expect(prepared.cases[0]?.action.kind).toBe('open_product_conflict');
    const settled = settlePreparedConflictCase({
      ledger: harness.store.loadLedger(),
      items,
      prepared,
    });
    const finalized = finalizeInterpretationCaseProjection({
      ledger: settled,
      prepared,
      observation: OBSERVATION,
    });

    expect(finalized.conflicts).toHaveLength(1);
    expect(finalized.findings.filter((finding) => finding.provisional !== undefined)).toHaveLength(1);
    expect(finalized.rawInterpretationOutcomes).toHaveLength(2);
    expect(finalized.rawInterpretationOutcomes.every((outcome) => (
      outcome.kind === 'conflict'
      && outcome.conflictId === finalized.conflicts[0]!.id
      && outcome.provisionalFindingId === finalized.findings.find(
        (finding) => finding.provisional !== undefined,
      )!.id
    ))).toBe(true);
    harness.resolver.close();
  });

  it('terminalizes a direct case with no provider attempt', async () => {
    const harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    const items = [
      ...taintedItems({ rawFindingIds: ['raw-direct-a'], ledger, evidenceLine: 1 }),
      ...taintedItems({ rawFindingIds: ['raw-direct-b'], ledger, evidenceLine: 2 }),
    ];
    const begun = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    expect(begun.attempts).toEqual([]);
    expect(begun.directPlans).toHaveLength(1);
    const prepared = prepareInterpretationCaseActions({
      ledger: harness.store.loadLedger(),
      items,
      completedAttemptIds: [],
      directPlans: begun.directPlans,
      proofFastPathPlans: [],
      provisionalOnlyRawFindingIds: new Set(),
    });
    const settled = settlePreparedInterpretationCases({
      ledger: harness.store.loadLedger(),
      items,
      prepared,
    });
    const finalized = finalizeInterpretationCaseProjection({
      ledger: settled,
      prepared,
      observation: OBSERVATION,
    });
    expect(finalized.rawInterpretationOutcomes.every((outcome) => outcome.kind === 'provisional'))
      .toBe(true);
    expect(finalized.interpretationAttempts).toEqual([]);
    harness.resolver.close();
  });

  it('rejects unknown, started, and missing-member attempt preparation', async () => {
    const harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    const items = taintedItems({ rawFindingIds: ['raw-invalid-prepare'], ledger });
    const begun = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    const request = {
      ledger: harness.store.loadLedger(),
      items,
      directPlans: [],
      proofFastPathPlans: [],
      provisionalOnlyRawFindingIds: new Set<string>(),
    };
    expect(() => prepareInterpretationCaseActions({
      ...request,
      completedAttemptIds: ['missing-attempt'],
    })).toThrow(/unknown attempt/i);
    expect(() => prepareInterpretationCaseActions({
      ...request,
      completedAttemptIds: [begun.attempts[0]!.attemptId],
    })).toThrow(/must be completed/i);

    await harness.completeInterpretationCases({
      receipt: begun.receipt,
      responses: [response(begun.providerCases[0]!, {
        kind: 'provisional',
        reason: 'Prepared after completion.',
      })],
      providerFailures: [],
    });
    expect(() => prepareInterpretationCaseActions({
      ...request,
      ledger: harness.store.loadLedger(),
      items: [],
      completedAttemptIds: [begun.attempts[0]!.attemptId],
    })).toThrow(/missing canonical member|unexpected raw finding/i);
    harness.resolver.close();
  });

  it('degrades a stale conflict and rejects partial, ambiguous, or changed terminal landings', async () => {
    const harness = openHarness();
    const ledger = baseLedger();
    await seed(harness, ledger);
    const items = taintedItems({
      rawFindingIds: ['raw-landing-a', 'raw-landing-b'],
      ledger,
      relation: 'new',
      targetFindingId: null,
    });
    const begun = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    await harness.completeInterpretationCases({
      receipt: begun.receipt,
      responses: [response(begun.providerCases[0]!, { kind: 'create_independent' })],
      providerFailures: [],
    });
    const prepared = prepareInterpretationCaseActions({
      ledger: harness.store.loadLedger(),
      items,
      completedAttemptIds: [begun.attempts[0]!.attemptId],
      directPlans: [],
      proofFastPathPlans: [],
      provisionalOnlyRawFindingIds: new Set(),
    });
    const settled = settlePreparedInterpretationCases({
      ledger: harness.store.loadLedger(),
      items,
      prepared,
    });
    const created = settled.findings.find((finding) => (
      items.every((item) => finding.rawFindingIds.includes(item.canonical.rawFindingId))
    ))!;
    expect(() => finalizeInterpretationCaseProjection({
      ledger: {
        ...settled,
        findings: settled.findings.map((finding) => (
          finding.id === created.id
            ? { ...finding, rawFindingIds: [items[0]!.canonical.rawFindingId] }
            : finding
        )),
      },
      prepared,
      observation: OBSERVATION,
    })).toThrow(/exactly one|landing/i);

    const duplicated = addExactProductFinding(settled, 'F-0099', created.id);
    const duplicate = duplicated.findings.find((finding) => finding.id === 'F-0099')!;
    const ambiguous = applyFindingLedgerFixtureRevision({
      ledger: duplicated,
      entityKind: 'finding',
      entity: {
        ...duplicate,
        lifecycle: 'persists',
        rawFindingIds: [...prepared.cases[0]!.rawFindingIds],
        revision: duplicate.revision + 1,
        lastSeen: { ...OBSERVATION },
      },
    });
    expect(() => finalizeInterpretationCaseProjection({
      ledger: ambiguous,
      prepared,
      observation: OBSERVATION,
    })).toThrow(/exactly one|ambiguous/i);

    const finalized = finalizeInterpretationCaseProjection({
      ledger: settled,
      prepared,
      observation: OBSERVATION,
    });
    const changedTerminal: FindingLedger = {
      ...finalized,
      rawInterpretationOutcomes: finalized.rawInterpretationOutcomes.map((outcome, index) => (
        index === 0 && outcome.kind === 'finding'
          ? { ...outcome, findingId: 'F-9999' }
          : outcome
      )),
    };
    expect(() => finalizeInterpretationCaseProjection({
      ledger: changedTerminal,
      prepared,
      observation: OBSERVATION,
    })).toThrow(/cannot be changed/i);

    const conflictLedger = baseLedger();
    const conflictItems = taintedItems({ rawFindingIds: ['raw-stale-conflict-finalize'], ledger: conflictLedger });
    const conflictHarness = openHarness();
    await seed(conflictHarness, conflictLedger);
    const conflictBegun = await conflictHarness.beginInterpretationCases({
      items: conflictItems,
      provisionalOnlyRawFindingIds: new Set(),
    });
    await conflictHarness.completeInterpretationCases({
      receipt: conflictBegun.receipt,
      responses: [response(conflictBegun.providerCases[0]!, {
        kind: 'open_conflict',
        targetFindingId: 'F-0001',
      })],
      providerFailures: [],
    });
    const staleConflict = prepareInterpretationCaseActions({
      ledger: advanceOpenFindingRevision(conflictHarness.store.loadLedger()),
      items: conflictItems,
      completedAttemptIds: [conflictBegun.attempts[0]!.attemptId],
      directPlans: [],
      proofFastPathPlans: [],
      provisionalOnlyRawFindingIds: new Set(),
    });
    expect(staleConflict.cases[0]?.action.kind).toBe('provisional');
    conflictHarness.resolver.close();
    harness.resolver.close();
  });
});
