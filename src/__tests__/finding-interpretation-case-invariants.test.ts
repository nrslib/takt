import { afterEach, describe, expect, it } from 'vitest';
import { collectFindingLedgerProjectionInvariantViolations } from '../core/models/finding-ledger-invariants.js';
import { parseFindingLedger } from '../core/models/finding-schemas.js';
import {
  cleanupInterpretationCaseRoots,
  emptyLedger,
  openHarness,
  seed,
  taintedItems,
} from './helpers/finding-interpretation-case-store-fixture.js';

afterEach(cleanupInterpretationCaseRoots);

describe('interpretation case ledger invariants', () => {
  it('accepts a fully registered empty Finding Contract ledger', () => {
    const ledger = emptyLedger();
    expect(collectFindingLedgerProjectionInvariantViolations(ledger)).toEqual([]);
    expect(parseFindingLedger(JSON.parse(JSON.stringify(ledger)))).toEqual(ledger);
  });

  it('accepts the atomic pending-intake state saved before provider work', async () => {
    const harness = openHarness();
    const initial = emptyLedger();
    await seed(harness, initial);
    const items = taintedItems({
      rawFindingIds: ['raw-pending-a', 'raw-pending-b'],
      ledger: initial,
      relation: 'new',
      targetFindingId: null,
    });
    const begun = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    const stored = harness.store.loadLedger();

    expect(begun.providerCases).toHaveLength(1);
    expect(stored.interpretationAttempts).toEqual([
      expect.objectContaining({ stage: 'started' }),
    ]);
    expect(stored.rawInterpretationOutcomes).toHaveLength(2);
    expect(stored.rawInterpretationOutcomes.every(({ kind }) => kind === 'pending_attempt')).toBe(true);
    expect(stored.rawCanonicalSnapshots).toHaveLength(2);
    expect(collectFindingLedgerProjectionInvariantViolations(stored)).toEqual([]);
    harness.resolver.close();
  });

  it('rejects an interpretation attempt whose persisted identity is altered', async () => {
    const harness = openHarness();
    const initial = emptyLedger();
    await seed(harness, initial);
    const items = taintedItems({
      rawFindingIds: ['raw-identity'],
      ledger: initial,
      relation: 'new',
      targetFindingId: null,
    });
    await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    const stored = harness.store.loadLedger();
    const corrupted = {
      ...stored,
      interpretationAttempts: stored.interpretationAttempts.map((attempt) => ({
        ...attempt,
        attemptId: 'altered-attempt-id',
      })),
    };

    expect(collectFindingLedgerProjectionInvariantViolations(corrupted))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/attempt.*identity|attemptId/iu),
        }),
      ]));
    harness.resolver.close();
  });
});
