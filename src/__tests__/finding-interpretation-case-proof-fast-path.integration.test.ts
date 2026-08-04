import { afterEach, describe, expect, it } from 'vitest';
import {
  finalizeInterpretationCaseProjection,
  prepareInterpretationCaseActions,
} from '../core/workflow/findings/interpretation-case-finalizer.js';
import {
  addExactProductFinding,
  advanceOpenFindingRevision,
  baseLedger,
  cleanupInterpretationCaseRoots,
  openHarness,
  readAuthorityRow,
  seed,
  taintedItems,
} from './helpers/finding-interpretation-case-store-fixture.js';
import {
  settlePreparedInterpretationCases,
} from './helpers/finding-interpretation-case-finalizer-fixture.js';

afterEach(cleanupInterpretationCaseRoots);

describe('interpretation case proof fast path boundaries', () => {
  it('reissues SameProof, lands through lifecycle authority, and terminalizes every raw', async () => {
    const harness = openHarness();
    const ledger = baseLedger({
      title: 'Shared semantic defect',
      description: 'The same defect remains observable.',
    });
    await seed(harness, ledger);
    const items = taintedItems({ rawFindingIds: ['raw-proof-a', 'raw-proof-b'], ledger });
    const beforeBegin = readAuthorityRow(harness.root);
    const begun = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });

    expect(begun.attempts).toEqual([]);
    expect(begun.proofFastPathPlans).toHaveLength(1);
    expect(readAuthorityRow(harness.root)).toEqual(beforeBegin);
    const prepared = prepareInterpretationCaseActions({
      ledger: harness.store.loadLedger(),
      items,
      completedAttemptIds: [],
      directPlans: [],
      proofFastPathPlans: begun.proofFastPathPlans,
      provisionalOnlyRawFindingIds: new Set(),
    });
    expect(prepared.cases[0]?.action.kind).toBe('match_with_proof');

    const settled = settlePreparedInterpretationCases({
      ledger: harness.store.loadLedger(),
      items,
      prepared,
    });
    const finalized = finalizeInterpretationCaseProjection({
      ledger: settled,
      prepared,
      observation: settled.findings.find((finding) => finding.id === 'F-0001')!.lastSeen,
    });

    expect(finalized.rawInterpretationOutcomes).toEqual(items.map((item) => ({
      rawFindingId: item.canonical.rawFindingId,
      kind: 'finding',
      findingId: 'F-0001',
      outcome: 'matched_with_proof',
      landingEventId: expect.any(String),
    })));
    expect(finalized.evidenceBindings.filter((binding) => (
      binding.target.entityKind === 'finding'
      && binding.target.entityId === 'F-0001'
      && binding.contributionOrigin.kind === 'interpretation_case'
    ))).toHaveLength(items.length);
    expect(finalizeInterpretationCaseProjection({
      ledger: finalized,
      prepared,
      observation: settled.findings.find((finding) => finding.id === 'F-0001')!.lastSeen,
    })).toEqual(finalized);
    harness.resolver.close();
  });

  it('degrades a stale or non-unique SameProof case-wide to provisional', async () => {
    const harness = openHarness();
    const ledger = baseLedger({
      title: 'Shared semantic defect',
      description: 'The same defect remains observable.',
    });
    await seed(harness, ledger);
    const items = taintedItems({ rawFindingIds: ['raw-stale-proof'], ledger });
    const begun = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });

    const stale = prepareInterpretationCaseActions({
      ledger: advanceOpenFindingRevision(ledger),
      items,
      completedAttemptIds: [],
      directPlans: [],
      proofFastPathPlans: begun.proofFastPathPlans,
      provisionalOnlyRawFindingIds: new Set(),
    });
    expect(stale.cases[0]?.action.kind).toBe('provisional');

    const duplicated = prepareInterpretationCaseActions({
      ledger: addExactProductFinding(ledger, 'F-0002', 'F-0001'),
      items,
      completedAttemptIds: [],
      directPlans: [],
      proofFastPathPlans: begun.proofFastPathPlans,
      provisionalOnlyRawFindingIds: new Set(),
    });
    expect(duplicated.cases[0]?.action.kind).toBe('provisional');
    harness.resolver.close();
  });

  it('rejects preparation when one current raw has no completed, direct, or proof plan', async () => {
    const harness = openHarness();
    const ledger = baseLedger({
      title: 'Shared semantic defect',
      description: 'The same defect remains observable.',
    });
    await seed(harness, ledger);
    const items = [
      ...taintedItems({
        rawFindingIds: ['raw-proof-covered'],
        ledger,
        reviewerPersonaKey: 'proof-reviewer-a',
      }),
      ...taintedItems({
        rawFindingIds: ['raw-proof-missing'],
        ledger,
        reviewerPersonaKey: 'proof-reviewer-b',
      }),
    ];
    const begun = await harness.beginInterpretationCases({
      items,
      provisionalOnlyRawFindingIds: new Set(),
    });
    expect(begun.proofFastPathPlans).toHaveLength(2);

    expect(() => prepareInterpretationCaseActions({
      ledger: harness.store.loadLedger(),
      items,
      completedAttemptIds: begun.completedAttemptIdsForCommit,
      directPlans: begun.directPlans,
      proofFastPathPlans: begun.proofFastPathPlans.slice(0, 1),
      provisionalOnlyRawFindingIds: new Set(),
    })).toThrow(/exact-one preparation owner/i);
    expect(() => prepareInterpretationCaseActions({
      ledger: harness.store.loadLedger(),
      items,
      completedAttemptIds: [],
      directPlans: [],
      proofFastPathPlans: [
        begun.proofFastPathPlans[0]!,
        begun.proofFastPathPlans[0]!,
        begun.proofFastPathPlans[1]!,
      ],
      provisionalOnlyRawFindingIds: new Set(),
    })).toThrow(/exact-one preparation owner/i);
    expect(() => prepareInterpretationCaseActions({
      ledger: harness.store.loadLedger(),
      items: [items[0]!],
      completedAttemptIds: [],
      directPlans: [],
      proofFastPathPlans: begun.proofFastPathPlans,
      provisionalOnlyRawFindingIds: new Set(),
    })).toThrow(/unexpected raw finding/i);
    harness.resolver.close();
  });
});
