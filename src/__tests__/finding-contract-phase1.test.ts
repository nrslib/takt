import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  binarySortedUnique,
  findingContentAddress,
} from '../core/models/finding-contract-identity.js';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import { collectFindingLedgerProjectionInvariantViolations } from '../core/models/finding-ledger-invariants.js';
import { canonicalJson } from '../shared/utils/canonical-json.js';
import { FindingLedgerSchema } from '../core/models/finding-schemas.js';
import {
  dispatchFindingManagerProviderCall,
  reserveFindingManagerProviderCall,
  settleFindingManagerProviderCall,
} from '../core/workflow/findings/finding-manager-provider-call.js';

const observedAt = {
  runId: 'run-1',
  stepName: 'reviewers',
  timestamp: '2026-08-02T00:00:00.000Z',
};

function emptyLedger() {
  return {
    workflowName: 'peer-review',
    nextId: 1,
    updatedAt: observedAt.timestamp,
    findings: [],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawFindings: [],
    conflicts: [],
    ...createEmptyFindingContractRegistries(),
  };
}

describe('Finding Contract phase 1', () => {
  it('requires every contract registry without defaults', () => {
    const ledger = emptyLedger();
    expect(FindingLedgerSchema.parse(ledger)).toEqual(ledger);

    const { rawCanonicalSnapshots: _removed, ...missingRegistry } = ledger;
    expect(() => FindingLedgerSchema.parse(missingRegistry)).toThrow();
  });

  it('rejects an unknown raw interpretation outcome kind in the ledger invariant', () => {
    const violations = collectFindingLedgerProjectionInvariantViolations({
      ...emptyLedger(),
      rawInterpretationOutcomes: [{
        kind: 'unknown_outcome',
        rawFindingId: 'raw-unknown',
      }],
    } as never);
    expect(violations.map(({ message }) => message))
      .toContain('Interpretation outcome for "raw-unknown" has an unknown kind');
  });

  it('uses domain-separated content addresses and rejects undefined or duplicate sets', () => {
    expect(findingContentAddress('domain-a', { value: 'x' })).toBe(
      createHash('sha256').update(canonicalJson({ domain: 'domain-a', value: 'x' })).digest('hex'),
    );
    expect(findingContentAddress('domain-a', { value: 'x' }))
      .not.toBe(findingContentAddress('domain-b', { value: 'x' }));
    expect(() => findingContentAddress('domain-a', { domain: 'domain-b' }))
      .toThrow('must not contain the reserved "domain" key');
    expect(() => findingContentAddress('domain-a', { value: undefined })).toThrow(
      'contains undefined',
    );
    expect(() => binarySortedUnique(['a', 'a'])).toThrow('duplicate');
    expect(binarySortedUnique(['b', 'a'])).toEqual(['a', 'b']);
  });

  it('persists reserved, dispatched, and settled provider call states', () => {
    const attemptId = 'a'.repeat(64);
    const limits = {
      maxCallsPerRound: 2,
      maxAdapterVisibleInputBytesPerCall: 100,
      maxOutputTokensPerCall: 50,
      maxChargedInputTokensPerRound: 200,
      maxChargedOutputTokensPerRound: 100,
    };
    const reserved = reserveFindingManagerProviderCall({
      scopes: [],
      calls: [],
      scopeIdentity: 'scope-1',
      workflowName: 'peer-review',
      roundMarker: 'round-1',
      limits,
      purpose: 'interpretation',
      ownerAttemptKind: 'interpretation',
      attemptIds: [attemptId],
      requestBytes: 'request',
      adapterSupportsUtf8ByteUpperBound: true,
      reservedAt: observedAt,
    });
    expect(reserved.call.state).toBe('reserved');
    expect(reserved.scopes).toHaveLength(1);

    const dispatched = dispatchFindingManagerProviderCall({
      calls: reserved.calls,
      providerCallId: reserved.call.providerCallId,
      requestBytes: 'request',
      adapterSupportsUtf8ByteUpperBound: true,
      dispatchedAt: observedAt,
    });
    expect(dispatched.call.state).toBe('dispatched');
    expect(() => dispatchFindingManagerProviderCall({
      calls: reserved.calls,
      providerCallId: reserved.call.providerCallId,
      requestBytes: 'changed',
      adapterSupportsUtf8ByteUpperBound: true,
      dispatchedAt: observedAt,
    })).toThrow('request changed');

    const settled = settleFindingManagerProviderCall({
      calls: dispatched.calls,
      providerCallId: reserved.call.providerCallId,
      settledAt: observedAt,
      resultKind: 'accepted',
      response: { bytes: '{}' },
      providerUsage: { inputTokens: 7, outputTokens: 2 },
    });
    expect(settled.call).toMatchObject({
      state: 'settled',
      resultKind: 'accepted',
      charge: {
        callCount: 1,
        inputTokens: 7,
        outputTokens: 2,
        inputBasis: 'provider_usage',
        outputBasis: 'provider_usage',
      },
    });
  });

  it('charges an oversized response in full and blocks another reservation', () => {
    const limits = {
      maxCallsPerRound: 2,
      maxAdapterVisibleInputBytesPerCall: 100,
      maxOutputTokensPerCall: 5,
      maxChargedInputTokensPerRound: 200,
      maxChargedOutputTokensPerRound: 10,
    };
    const reserved = reserveFindingManagerProviderCall({
      scopes: [],
      calls: [],
      scopeIdentity: 'scope-1',
      workflowName: 'peer-review',
      roundMarker: 'round-1',
      limits,
      purpose: 'interpretation',
      ownerAttemptKind: 'interpretation',
      attemptIds: ['a'.repeat(64)],
      requestBytes: 'request',
      adapterSupportsUtf8ByteUpperBound: true,
      reservedAt: observedAt,
    });
    const dispatched = dispatchFindingManagerProviderCall({
      calls: reserved.calls,
      providerCallId: reserved.call.providerCallId,
      requestBytes: 'request',
      adapterSupportsUtf8ByteUpperBound: true,
      dispatchedAt: observedAt,
    });
    const responseBytes = '123456789012';
    const settled = settleFindingManagerProviderCall({
      calls: dispatched.calls,
      providerCallId: reserved.call.providerCallId,
      settledAt: observedAt,
      resultKind: 'rejected',
      failurePhase: 'output_oversize',
      response: { bytes: responseBytes },
    });
    expect(settled.call).toMatchObject({
      state: 'settled',
      resultKind: 'rejected',
      failurePhase: 'output_oversize',
      charge: { outputTokens: Buffer.byteLength(responseBytes, 'utf8') },
    });
    expect(() => reserveFindingManagerProviderCall({
      scopes: reserved.scopes,
      calls: settled.calls,
      scopeIdentity: 'scope-1',
      workflowName: 'peer-review',
      roundMarker: 'round-1',
      limits,
      purpose: 'interpretation',
      ownerAttemptKind: 'interpretation',
      attemptIds: ['b'.repeat(64)],
      requestBytes: 'next request',
      adapterSupportsUtf8ByteUpperBound: true,
      reservedAt: observedAt,
    })).toThrow('output budget is exhausted');
  });
});
