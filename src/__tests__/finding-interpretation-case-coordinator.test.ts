import { describe, expect, it } from 'vitest';
import {
  selectInterpretationCaseProofFastPath,
} from '../core/workflow/findings/interpretation-case-coordinator.js';
import { createInterpretationCases } from '../core/workflow/findings/interpretation-case-model.js';
import {
  addExactProductFinding,
  advanceOpenFindingRevision,
  baseLedger,
  taintedItems,
} from './helpers/finding-interpretation-case-store-fixture.js';

function proofCase(ledger: ReturnType<typeof baseLedger>) {
  return createInterpretationCases({
    items: taintedItems({ rawFindingIds: ['raw-proof-selector'], ledger }),
    ledger,
    provisionalOnlyRawFindingIds: new Set(),
  })[0]!;
}

describe('interpretation case proof fast-path selector', () => {
  it('selects one fresh product target shared by every member proof', () => {
    const ledger = baseLedger({
      title: 'Shared semantic defect',
      description: 'The same defect remains observable.',
    });
    const selected = selectInterpretationCaseProofFastPath({
      plannedCase: proofCase(ledger),
      ledger,
    });

    expect(selected).toEqual(expect.objectContaining({
      targetFindingId: 'F-0001',
      targetRevision: ledger.findings[0]!.revision,
    }));
    expect(selected?.proofs).toHaveLength(1);
  });

  it('rejects multiple exact product targets', () => {
    const ledger = baseLedger({
      title: 'Shared semantic defect',
      description: 'The same defect remains observable.',
    });
    const duplicated = addExactProductFinding(ledger, 'F-0002', 'F-0001');

    expect(selectInterpretationCaseProofFastPath({
      plannedCase: proofCase(duplicated),
      ledger: duplicated,
    })).toBeNull();
  });

  it('rejects proofs whose product lifecycle head is stale', () => {
    const ledger = baseLedger({
      title: 'Shared semantic defect',
      description: 'The same defect remains observable.',
    });

    expect(selectInterpretationCaseProofFastPath({
      plannedCase: proofCase(ledger),
      ledger: advanceOpenFindingRevision(ledger),
    })).toBeNull();
  });
});
