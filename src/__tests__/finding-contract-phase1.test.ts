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
import { assertFindingLedgerAppendOnlyTransition } from '../core/workflow/findings/finding-integrity.js';
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

function withdrawnAnomaly(
  supersedingPublications: Array<{ reviewer: string; publicationId: string }>,
  reviewers = ['arch-review', 'security-review'],
) {
  return {
    id: 'RA-000000000001',
    kind: 'quote-mismatch' as const,
    stableKey: 'a'.repeat(64),
    lineageKey: 'b'.repeat(64),
    sourceRawFindingIds: [],
    sourceIntakeIds: ['intake-1'],
    reviewers,
    title: 'Unverifiable reviewer claim',
    mismatchReason: 'the quoted excerpt does not exist',
    firstObserved: observedAt,
    lastObserved: observedAt,
    occurrences: 1,
    settlement: {
      kind: 'withdrawn_by_subsequent_review' as const,
      supersedingPublications,
      decidedAt: observedAt,
    },
  };
}

/** 観測者 arch-review / security-review 全員分の根拠（binary 順）。 */
function completeWithdrawalPublications(): Array<{ reviewer: string; publicationId: string }> {
  return [
    { reviewer: 'arch-review', publicationId: 'c'.repeat(64) },
    { reviewer: 'security-review', publicationId: 'd'.repeat(64) },
  ];
}

/** 決着前（未決着）の台帳。append-only 遷移検証の起点に使う。 */
function outstandingWithdrawalLedger() {
  const { settlement: _settlement, ...withoutSettlement } = withdrawnAnomaly(
    completeWithdrawalPublications(),
  );
  return { ...emptyLedger(), reviewerAnomalies: [withoutSettlement] };
}

function withdrawalInvariantMessages(
  supersedingPublications: Array<{ reviewer: string; publicationId: string }>,
  reviewers?: string[],
): string[] {
  return collectFindingLedgerProjectionInvariantViolations({
    ...emptyLedger(),
    reviewerAnomalies: [withdrawnAnomaly(supersedingPublications, reviewers)],
  } as never).map(({ message }) => message);
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

  it('取り下げ settlement は観測者全員分の根拠が揃えば適格', () => {
    expect(withdrawalInvariantMessages(completeWithdrawalPublications())).toEqual([]);
    expect(() => FindingLedgerSchema.parse({
      ...emptyLedger(),
      reviewerAnomalies: [withdrawnAnomaly(completeWithdrawalPublications())],
    })).not.toThrow();
  });

  it('取り下げ settlement は観測者の部分集合しか記録しない根拠を拒否する', () => {
    expect(withdrawalInvariantMessages([completeWithdrawalPublications()[0]!])).toContainEqual(
      expect.stringContaining('every reviewer that observed the anomaly'),
    );
  });

  it('取り下げ settlement は観測者でないレビュアーを含む根拠を拒否する', () => {
    expect(withdrawalInvariantMessages([
      ...completeWithdrawalPublications(),
      { reviewer: 'testing-review', publicationId: 'e'.repeat(64) },
    ])).toContainEqual(
      expect.stringContaining('every reviewer that observed the anomaly'),
    );
  });

  it('同一レビュアーを二重計上しても欠けた観測者の根拠は補えない（不変条件経路）', () => {
    // 1レビュアー枠が同一ラウンドに複数 publication を持つことは正当（格上げ
    // 再レビューの owner 別グループ化）。ただし網羅性は reviewer 集合の完全一致で
    // 判定するので、片方を二重計上して別の観測者の根拠を欠く記録は通らない。
    const duplicated = [
      completeWithdrawalPublications()[0]!,
      { reviewer: 'arch-review', publicationId: 'f'.repeat(64) },
    ];
    expect(withdrawalInvariantMessages(duplicated, ['arch-review', 'security-review']))
      .toContainEqual(
        expect.stringContaining('every reviewer that observed the anomaly'),
      );
  });

  it('同一レビュアー枠の複数 publication は、そのレビュアーが唯一の観測者なら適格', () => {
    // 格上げ再レビューは owner ごとに1呼び出しへ分かれるが reviewer キーは固定。
    // 1ラウンドで同じ reviewer キーの publication が複数成立し得る。
    const multiplePublications = [
      { reviewer: 'escalation-reviewer', publicationId: 'c'.repeat(64) },
      { reviewer: 'escalation-reviewer', publicationId: 'd'.repeat(64) },
    ];
    expect(withdrawalInvariantMessages(multiplePublications, ['escalation-reviewer']))
      .toEqual([]);
    expect(() => FindingLedgerSchema.parse({
      ...emptyLedger(),
      reviewerAnomalies: [withdrawnAnomaly(multiplePublications, ['escalation-reviewer'])],
    })).not.toThrow();
  });

  it('同じ publication の二重計上は根拠の水増しとして拒否される', () => {
    const sameTwice = [
      { reviewer: 'escalation-reviewer', publicationId: 'c'.repeat(64) },
      { reviewer: 'escalation-reviewer', publicationId: 'c'.repeat(64) },
    ];
    expect(withdrawalInvariantMessages(sameTwice, ['escalation-reviewer']))
      .toContainEqual(
        expect.stringContaining('must not record the same superseding publication twice'),
      );
    expect(() => assertFindingLedgerAppendOnlyTransition(
      outstandingWithdrawalLedger() as never,
      {
        ...emptyLedger(),
        reviewerAnomalies: [withdrawnAnomaly(sameTwice, ['escalation-reviewer'])],
      } as never,
    )).toThrow();
  });

  it('観測者2人分の根拠を binary 順で持つ取り下げは append-only 遷移検証を通る', () => {
    const settled = {
      ...emptyLedger(),
      reviewerAnomalies: [withdrawnAnomaly(completeWithdrawalPublications())],
    };
    expect(() => assertFindingLedgerAppendOnlyTransition(
      outstandingWithdrawalLedger() as never,
      settled as never,
    )).not.toThrow();
    // 受理された記録には両観測者の {reviewer, publicationId} が binary 順で残る。
    expect(settled.reviewerAnomalies[0]!.settlement.supersedingPublications).toEqual([
      { reviewer: 'arch-review', publicationId: 'c'.repeat(64) },
      { reviewer: 'security-review', publicationId: 'd'.repeat(64) },
    ]);
  });

  it('取り下げ settlement のスキーマは空配列・同一 publication の重複・binary 順違反を拒否する', () => {
    const invalidPublications = [
      // 空配列: 根拠のない取り下げ。
      [],
      // 同じ (reviewer, publicationId) の重複。
      [
        { reviewer: 'arch-review', publicationId: 'c'.repeat(64) },
        { reviewer: 'arch-review', publicationId: 'c'.repeat(64) },
      ],
      // binary 順違反（security-review が arch-review より前）。
      [
        { reviewer: 'security-review', publicationId: 'd'.repeat(64) },
        { reviewer: 'arch-review', publicationId: 'c'.repeat(64) },
      ],
    ];
    for (const publications of invalidPublications) {
      expect(() => FindingLedgerSchema.parse({
        ...emptyLedger(),
        reviewerAnomalies: [withdrawnAnomaly(publications, ['arch-review', 'security-review'])],
      })).toThrow();
    }
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
