import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  computeClaimIdentityHash,
} from '../core/models/finding-claim-identity.js';
import {
  createRawFindingsOutputJsonSchema,
} from '../core/models/finding-schemas.js';
import {
  createSnapshotEngineProofVerifiers,
  issueFindingEvidenceRequests as issueFindingEvidenceRequestsCore,
} from '../core/workflow/findings/evidence-request-issuer.js';
import {
  createReviewerRawFindingCandidates,
} from '../core/workflow/findings/raw-canonicalization.js';
import type {
  FindingTarget,
} from '../core/models/finding-types.js';
import type {
  ReviewScopeProofSnapshot,
} from '../core/workflow/findings/snapshot.js';

type IssuerContext = Parameters<typeof issueFindingEvidenceRequestsCore>[0];
type IssuerInput = Parameters<typeof issueFindingEvidenceRequestsCore>[1];

function issueFindingEvidenceRequests(
  context: Omit<IssuerContext, 'cwd'> & Partial<Pick<IssuerContext, 'cwd'>>,
  input: Omit<IssuerInput, 'quoteByteBudget'>
    & Partial<Pick<IssuerInput, 'quoteByteBudget'>>,
) {
  return issueFindingEvidenceRequestsCore({ cwd: process.cwd(), ...context }, {
    ...input,
    quoteByteBudget: input.quoteByteBudget ?? {
      reviewerRemainingBytes: 256 * 1024,
      stepRemainingBytes: 512 * 1024,
    },
  });
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

const snapshotId = 'a'.repeat(64);
const snapshot: ReviewScopeProofSnapshot = {
  reviewScopeSnapshotId: snapshotId,
  trackedDiff: undefined,
  untrackedEvidence: [],
  queryInventory: [{
    path: 'src/a.ts',
    kind: 'file',
    contentDigest: 'b'.repeat(64),
    content: Buffer.from('export const currentApi = true;\n'),
    coverage: 'complete',
  }],
};

function issueResourceCappedFileQuote(cwd: string, contentDigest: string) {
  return issueFindingEvidenceRequests({
    cwd,
    snapshot: {
      ...snapshot,
      queryInventory: [{
        path: 'src/a.ts',
        kind: 'file',
        contentDigest,
        coverage: 'resource_cap',
      }],
    },
    workflowName: 'workflow',
    runId: 'run',
    scopeIdentity: 'scope',
    workflowTask: 'Fix the code.',
    issuedAt: '2026-07-29T00:00:00.000Z',
  }, {
    target: { kind: 'code', paths: ['src/a.ts'], symbol: null },
    claimIdentityHash: 'c'.repeat(64),
    targetFindingId: null,
    requests: [{ kind: 'file_quote', path: 'src/a.ts', startLine: 2, endLine: 2 }],
  });
}

const target: FindingTarget = {
  kind: 'absence',
  predicate: {
    kind: 'exact_literal_search',
    roots: ['src'],
    literal: 'legacyApi',
    textDomain: 'utf8',
  },
};

const claimIdentityHash = computeClaimIdentityHash({
  target,
  familyTag: 'compatibility',
  severity: 'high',
  title: 'Legacy API must be absent',
  description: 'The task requires removing legacyApi.',
  suggestion: null,
});

describe('Finding evidence request issuer', () => {
  it('issues a complete zero-match proof and a registered task quote proof', () => {
    const result = issueFindingEvidenceRequests({
      snapshot,
      workflowName: 'workflow',
      runId: 'run',
      scopeIdentity: 'scope',
      workflowTask: 'Remove legacyApi from the src tree.',
      issuedAt: '2026-07-29T00:00:00.000Z',
    }, {
      target,
      claimIdentityHash,
      targetFindingId: null,
      requests: [{
        kind: 'engine_proof',
        subject: { kind: 'repository_query' },
      }, {
        kind: 'engine_proof',
        subject: {
          kind: 'authoritative_quote',
          source: 'task',
          declarationId: 'workflow_task',
          verbatimExcerpt: 'Remove legacyApi',
        },
      }],
    });

    expect(result.coverageGaps).toEqual([]);
    expect(result.engineProofRecords).toHaveLength(2);
    expect(result.engineProofRecords.every(
      (record) => record.purpose === 'claim_evidence',
    )).toBe(true);
    expect(result.engineProofRecords.map((record) => record.subject.kind)).toEqual([
      'repository_query',
      'authoritative_quote',
    ]);
  });

  it('does not turn a resource-cap gap into a zero-match proof', () => {
    const result = issueFindingEvidenceRequests({
      snapshot: {
        ...snapshot,
        queryInventory: [{
          ...snapshot.queryInventory[0]!,
          content: Buffer.from('export const currentApi = true;\n'),
          coverage: 'resource_cap',
        }],
      },
      workflowName: 'workflow',
      runId: 'run',
      scopeIdentity: 'scope',
      workflowTask: 'Remove legacyApi.',
      issuedAt: '2026-07-29T00:00:00.000Z',
    }, {
      target,
      claimIdentityHash,
      targetFindingId: null,
      requests: [{
        kind: 'engine_proof',
        subject: { kind: 'repository_query' },
      }],
    });

    expect(result.engineProofRecords).toEqual([]);
    expect(result.coverageGaps).toEqual([
      'query coverage gap at "src/a.ts" (resource_cap)',
    ]);
  });

  it('does not turn a symlink coverage gap into a zero-match proof', () => {
    const result = issueFindingEvidenceRequests({
      snapshot: {
        ...snapshot,
        queryInventory: [{
          path: 'src/linked.ts',
          kind: 'symlink',
          coverage: 'unsupported_kind',
        }],
      },
      workflowName: 'workflow',
      runId: 'run',
      scopeIdentity: 'scope',
      workflowTask: 'Remove legacyApi.',
      issuedAt: '2026-07-29T00:00:00.000Z',
    }, {
      target,
      claimIdentityHash,
      targetFindingId: null,
      requests: [{
        kind: 'engine_proof',
        subject: { kind: 'repository_query' },
      }],
    });

    expect(result.engineProofRecords).toEqual([]);
    expect(result.coverageGaps).toEqual([
      'query coverage gap at "src/linked.ts" (unsupported_kind)',
    ]);
  });

  it('does not turn non-UTF-8 inventory bytes into a zero-match proof', () => {
    const result = issueFindingEvidenceRequests({
      snapshot: {
        ...snapshot,
        queryInventory: [{
          path: 'src/binary.ts',
          kind: 'file',
          contentDigest: 'c'.repeat(64),
          content: Buffer.from([0xff, 0xfe]),
          coverage: 'complete',
        }],
      },
      workflowName: 'workflow',
      runId: 'run',
      scopeIdentity: 'scope',
      workflowTask: 'Remove legacyApi.',
      issuedAt: '2026-07-29T00:00:00.000Z',
    }, {
      target,
      claimIdentityHash,
      targetFindingId: null,
      requests: [{
        kind: 'engine_proof',
        subject: { kind: 'repository_query' },
      }],
    });

    expect(result.engineProofRecords).toEqual([]);
    expect(result.coverageGaps).toEqual([
      'query coverage gap at "src/binary.ts" (non-UTF-8)',
    ]);
  });

  it('rejects a non-canonical explicit query root before issuing proof', () => {
    const invalidTarget = {
      kind: 'absence',
      predicate: {
        kind: 'exact_literal_search',
        roots: ['../src'],
        literal: 'legacyApi',
        textDomain: 'utf8',
      },
    } as const;
    const result = issueFindingEvidenceRequests({
      snapshot,
      workflowName: 'workflow',
      runId: 'run',
      scopeIdentity: 'scope',
      workflowTask: 'Remove legacyApi.',
      issuedAt: '2026-07-29T00:00:00.000Z',
    }, {
      target: invalidTarget,
      claimIdentityHash,
      targetFindingId: null,
      requests: [{
        kind: 'engine_proof',
        subject: { kind: 'repository_query' },
      }],
    });

    expect(result.engineProofRecords).toEqual([]);
    expect(result.coverageGaps).toEqual([
      'query root "../src" is not a canonical explicit root',
    ]);
  });

  it('treats an unsupported path ancestor as a path_state coverage gap', () => {
    const pathTarget: FindingTarget = {
      kind: 'absence',
      predicate: {
        kind: 'path_state',
        path: 'src/generated/config.ts',
        expected: 'absent',
      },
    };
    const result = issueFindingEvidenceRequests({
      snapshot: {
        ...snapshot,
        queryInventory: [{
          path: 'src/generated',
          kind: 'symlink',
          coverage: 'unsupported_kind',
        }],
      },
      workflowName: 'workflow',
      runId: 'run',
      scopeIdentity: 'scope',
      workflowTask: 'Create generated config.',
      issuedAt: '2026-07-29T00:00:00.000Z',
    }, {
      target: pathTarget,
      claimIdentityHash: computeClaimIdentityHash({
        target: pathTarget,
        familyTag: 'structure',
        severity: 'high',
        title: 'Generated config is missing',
        description: 'The required generated config path is absent.',
        suggestion: null,
      }),
      targetFindingId: null,
      requests: [{
        kind: 'engine_proof',
        subject: { kind: 'repository_query' },
      }],
    });

    expect(result.engineProofRecords).toEqual([]);
    expect(result.coverageGaps).toEqual([
      'path_state coverage gap at "src/generated" (unsupported_kind)',
    ]);
  });

  it.each([
    {
      name: 'a nonexistent file',
      path: 'src/removed.ts',
      inventory: snapshot.queryInventory,
      proofCount: 1,
      coverageGaps: [],
    },
    {
      name: 'a directory with a present descendant',
      path: 'src/legacy',
      inventory: [{
        path: 'src/legacy/a.ts',
        kind: 'file' as const,
        contentDigest: 'c'.repeat(64),
        content: Buffer.from('export {};\n'),
        coverage: 'complete' as const,
      }],
      proofCount: 0,
      coverageGaps: ['path_state predicate is not satisfied because "src/legacy/a.ts" exists'],
    },
    {
      name: 'a directory with only a deleted descendant',
      path: 'src/legacy',
      inventory: [{
        path: 'src/legacy/a.ts',
        kind: 'file' as const,
        coverage: 'deleted' as const,
      }],
      proofCount: 1,
      coverageGaps: [],
    },
    {
      name: 'a directory with an excluded descendant',
      path: 'src/legacy',
      inventory: [{
        path: 'src/legacy/vendor',
        kind: 'directory' as const,
        coverage: 'excluded' as const,
      }],
      proofCount: 0,
      coverageGaps: ['path_state path "src/legacy" intersects excluded content'],
    },
    {
      name: 'a directory with an unsupported descendant',
      path: 'src/legacy',
      inventory: [{
        path: 'src/legacy/link',
        kind: 'symlink' as const,
        coverage: 'unsupported_kind' as const,
      }],
      proofCount: 0,
      coverageGaps: ['path_state coverage gap at "src/legacy/link" (unsupported_kind)'],
    },
  ])('evaluates path absence for $name without losing coverage semantics', ({
    path,
    inventory,
    proofCount,
    coverageGaps,
  }) => {
    const pathTarget: FindingTarget = {
      kind: 'absence',
      predicate: {
        kind: 'path_state',
        path,
        expected: 'absent',
      },
    };
    const result = issueFindingEvidenceRequests({
      snapshot: { ...snapshot, queryInventory: inventory },
      workflowName: 'workflow',
      runId: 'run',
      scopeIdentity: 'scope',
      workflowTask: 'Remove the legacy path.',
      issuedAt: '2026-07-29T00:00:00.000Z',
    }, {
      target: pathTarget,
      claimIdentityHash: computeClaimIdentityHash({
        target: pathTarget,
        familyTag: 'structure',
        severity: 'high',
        title: 'Legacy path must be absent',
        description: 'The legacy path and its descendants must be absent.',
        suggestion: null,
      }),
      targetFindingId: null,
      requests: [{
        kind: 'engine_proof',
        subject: { kind: 'repository_query' },
      }],
    });

    expect(result.engineProofRecords).toHaveLength(proofCount);
    expect(result.coverageGaps).toEqual(coverageGaps);
  });

  it.each([
    {
      name: 'present descendant',
      inventory: [{
        path: 'src/legacy/a.ts',
        kind: 'file' as const,
        contentDigest: 'd'.repeat(64),
        content: Buffer.from('export {};\n'),
        coverage: 'complete' as const,
      }],
      predicateSatisfied: false,
    },
    {
      name: 'deleted descendants only',
      inventory: [{
        path: 'src/legacy/a.ts',
        kind: 'file' as const,
        coverage: 'deleted' as const,
      }],
      predicateSatisfied: true,
    },
  ])('re-verifies path absence against $name', ({ inventory, predicateSatisfied }) => {
    const verifier = createSnapshotEngineProofVerifiers({
      snapshot: { ...snapshot, queryInventory: inventory },
      workflowTask: 'Remove the legacy path.',
    }).find(({ verifierId }) => verifierId === 'takt.repository-query');
    expect(verifier).toBeDefined();
    expect(verifier!.verify({
      kind: 'repository_query',
      predicate: {
        kind: 'path_state',
        path: 'src/legacy',
        expected: 'absent',
      },
      result: 'absent',
      coverage: 'complete',
    })).toMatchObject({
      outcome: 'evaluated',
      predicateSatisfied,
    });
  });

  it('checks unsupported ancestors for literal and manifest roots while distinguishing exclusions', () => {
    const literalTarget: FindingTarget = {
      kind: 'absence',
      predicate: {
        kind: 'exact_literal_search',
        roots: ['src/generated'],
        literal: 'legacyApi',
        textDomain: 'utf8',
      },
    };
    const structureTarget: FindingTarget = {
      kind: 'structure',
      scope: { kind: 'review_scope', roots: ['src/generated'] },
      manifestTargets: ['src/generated/config.ts'],
    };
    const issue = (
      inventory: ReviewScopeProofSnapshot['queryInventory'],
      requestedTarget: FindingTarget,
    ) => issueFindingEvidenceRequests({
      snapshot: { ...snapshot, queryInventory: inventory },
      workflowName: 'workflow',
      runId: 'run',
      scopeIdentity: 'scope',
      workflowTask: 'Create generated config and remove legacyApi.',
      issuedAt: '2026-07-29T00:00:00.000Z',
    }, {
      target: requestedTarget,
      claimIdentityHash: computeClaimIdentityHash({
        target: requestedTarget,
        familyTag: 'structure',
        severity: 'high',
        title: 'Generated contract',
        description: 'The generated tree must satisfy the contract.',
        suggestion: null,
      }),
      targetFindingId: null,
      requests: [{
        kind: 'engine_proof',
        subject: {
          kind: requestedTarget.kind === 'structure'
            ? 'repository_manifest'
            : 'repository_query',
        },
      }],
    });
    const unsupportedInventory = [{
      path: 'src',
      kind: 'embedded_repository',
      coverage: 'unsupported_kind' as const,
    }];

    expect(issue(unsupportedInventory, literalTarget).coverageGaps).toEqual([
      'query coverage gap at "src" (unsupported_kind)',
    ]);
    expect(issue(unsupportedInventory, structureTarget).coverageGaps).toEqual([
      'repository manifest coverage gap at "src" (unsupported_kind)',
    ]);
    expect(issue([{
      path: 'src',
      kind: 'directory',
      coverage: 'excluded',
    }], literalTarget).coverageGaps).toEqual([
      'query root intersects excluded content at "src"',
    ]);
  });

  it('treats an undecodable repository path as a root-agnostic coverage gap', () => {
    const undecodablePath = '0x7372632fff2e7473';
    const gapInventory = [{
      path: undecodablePath,
      kind: 'file',
      contentDigest: 'd'.repeat(64),
      coverage: 'unsupported_path_encoding' as const,
    }];
    const pathTarget: FindingTarget = {
      kind: 'absence',
      predicate: {
        kind: 'path_state',
        path: 'other/removed.ts',
        expected: 'absent',
      },
    };
    const literalTarget: FindingTarget = {
      kind: 'absence',
      predicate: {
        kind: 'exact_literal_search',
        roots: ['other'],
        literal: 'legacyApi',
        textDomain: 'utf8',
      },
    };
    const manifestTarget: FindingTarget = {
      kind: 'structure',
      scope: { kind: 'review_scope', roots: ['other'] },
      manifestTargets: ['other/config.ts'],
    };
    const issue = (
      requestedTarget: FindingTarget,
    ) => issueFindingEvidenceRequests({
      snapshot: { ...snapshot, queryInventory: gapInventory },
      workflowName: 'workflow',
      runId: 'run',
      scopeIdentity: 'scope',
      workflowTask: 'Verify repository state.',
      issuedAt: '2026-07-29T00:00:00.000Z',
    }, {
      target: requestedTarget,
      claimIdentityHash: computeClaimIdentityHash({
        target: requestedTarget,
        familyTag: 'structure',
        severity: 'high',
        title: 'Repository state',
        description: 'The repository must satisfy the requested state.',
        suggestion: null,
      }),
      targetFindingId: null,
      requests: [{
        kind: 'engine_proof',
        subject: {
          kind: requestedTarget.kind === 'structure'
            ? 'repository_manifest'
            : 'repository_query',
        },
      }],
    });

    expect(issue(pathTarget).coverageGaps).toEqual([
      `path_state coverage gap at "${undecodablePath}" (unsupported_path_encoding)`,
    ]);
    expect(issue(literalTarget).coverageGaps).toEqual([
      `query coverage gap at "${undecodablePath}" (unsupported_path_encoding)`,
    ]);
    expect(issue(manifestTarget).coverageGaps).toEqual([
      `repository manifest coverage gap at "${undecodablePath}" (unsupported_path_encoding)`,
    ]);

    const verifiers = createSnapshotEngineProofVerifiers({
      snapshot: { ...snapshot, queryInventory: gapInventory },
      workflowTask: 'Verify repository state.',
    });
    const queryVerifier = verifiers.find(
      ({ verifierId }) => verifierId === 'takt.repository-query',
    )!;
    const manifestVerifier = verifiers.find(
      ({ verifierId }) => verifierId === 'takt.repository-manifest',
    )!;
    expect(queryVerifier.verify({
      kind: 'repository_query',
      predicate: pathTarget.predicate,
      result: 'absent',
      coverage: 'complete',
    })).toMatchObject({ outcome: 'evaluated', predicateSatisfied: false });
    expect(queryVerifier.verify({
      kind: 'repository_query',
      predicate: literalTarget.predicate,
      result: 'zero_matches',
      coverage: 'complete',
    })).toMatchObject({ outcome: 'evaluated', predicateSatisfied: false });
    expect(manifestVerifier.verify({
      kind: 'repository_manifest',
      scope: manifestTarget.scope,
      manifestTargets: manifestTarget.manifestTargets,
      observedTargets: manifestTarget.manifestTargets,
    })).toMatchObject({ outcome: 'evaluated', predicateSatisfied: false });
  });

  it('binds only a unique exact raw excerpt to the report bytes', () => {
    const extraction = {
      rawExcerpt: 'Legacy API remains.',
      candidate: {
        rawFindingId: 'R-1',
        relation: 'new',
        targetFindingIds: [],
        familyTag: 'compatibility',
        severity: 'high',
        title: 'Legacy API remains',
        description: 'Legacy API remains.',
        suggestion: null,
        target,
        evidenceRequests: [],
      },
    };
    const context = {
      workflowName: 'workflow',
      callNamespace: '',
      parentStepName: 'review',
      stepIteration: 1,
      runId: 'run',
      reviewerStepName: 'reviewer',
      reviewerPersonaKey: 'reviewer',
      reviewReport: 'Summary.\nLegacy API remains.\nEnd.',
      ledger: { findings: [] } as never,
      issueEvidenceRequests: () => ({
        evidence: [],
        engineProofRecords: [],
        coverageGaps: [],
        materializedQuoteBytes: 0,
      }),
      commitEvidenceIssuance: () => {},
    };

    const unique = createReviewerRawFindingCandidates([extraction], context);
    expect(unique.rejections).toEqual([]);
    expect(unique.candidates[0]?.relation).toBe('new');
    expect(unique.candidates[0]?.sourceBinding.startByte).toBe(
      Buffer.byteLength('Summary.\n'),
    );

    const ambiguous = createReviewerRawFindingCandidates([extraction], {
      ...context,
      reviewReport: 'Legacy API remains.\nLegacy API remains.',
    });
    expect(ambiguous.candidates).toEqual([]);
    expect(ambiguous.rejections[0]?.reason).toMatch(/multiple matches/);
  });

  it('uses the ledger target for lifecycle supplements and flags an explicit mismatch without rewriting the reviewer relation or finding id', () => {
    const ledgerTarget: FindingTarget = { kind: 'code', paths: ['src/a.ts'], symbol: null };
    const baseCandidate = {
      rawFindingId: 'R-1',
      relation: 'persists' as const,
      targetFindingIds: ['F-0001'],
      familyTag: 'bug',
      severity: 'high' as const,
      title: 'Issue persists',
      description: 'The original failure remains.',
      suggestion: null,
      evidenceRequests: [],
    };
    const context = {
      workflowName: 'workflow',
      callNamespace: '',
      parentStepName: 'review',
      stepIteration: 1,
      runId: 'run',
      reviewerStepName: 'reviewer',
      reviewerPersonaKey: 'reviewer',
      reviewReport: 'The original failure remains.',
      ledger: { findings: [] } as never,
      authoritativeTargetByFindingId: new Map([['F-0001', ledgerTarget]]),
      issueEvidenceRequests: () => ({
        evidence: [],
        engineProofRecords: [],
        coverageGaps: [],
        materializedQuoteBytes: 0,
      }),
      commitEvidenceIssuance: () => {},
    };
    const supplement = createReviewerRawFindingCandidates([{
      rawExcerpt: 'The original failure remains.',
      candidate: { ...baseCandidate, target: null },
    }], context).candidates[0]!;
    const mismatch = createReviewerRawFindingCandidates([{
      rawExcerpt: 'The original failure remains.',
      candidate: {
        ...baseCandidate,
        target: { kind: 'code', paths: ['src/other.ts'], symbol: null },
      },
    }], context).candidates[0]!;

    expect(supplement).toMatchObject({
      relation: 'persists',
      targetFindingId: 'F-0001',
      target: ledgerTarget,
      evidenceCoverageGaps: [],
    });
    expect(mismatch).toMatchObject({
      relation: 'persists',
      targetFindingId: 'F-0001',
      target: ledgerTarget,
      evidenceCoverageGaps: [
        'Lifecycle target "F-0001" does not exactly match the authoritative ledger target',
      ],
    });
  });

  it.each([
    {
      name: 'LF',
      content: Buffer.from('alpha\nbeta\ngamma\n'),
      startLine: 2,
      endLine: 3,
      expected: 'beta\ngamma',
    },
    {
      name: 'CRLF',
      content: Buffer.from('alpha\r\nbeta\r\ngamma\r\n'),
      startLine: 2,
      endLine: 3,
      expected: 'beta\r\ngamma',
    },
    {
      name: 'UTF-8',
      content: Buffer.from('先頭\n証拠です\n末尾\n'),
      startLine: 2,
      endLine: 2,
      expected: '証拠です',
    },
  ])('materializes a $name quote from digest-bound retained inventory bytes', ({
    content,
    startLine,
    endLine,
    expected,
  }) => {
    const codeTarget: FindingTarget = {
      kind: 'code',
      paths: ['src/a.ts'],
      symbol: null,
    };
    const result = issueFindingEvidenceRequests({
      snapshot: {
        ...snapshot,
        queryInventory: [{
          path: 'src/a.ts',
          kind: 'file',
          contentDigest: sha256(content),
          content,
          coverage: 'complete',
        }],
      },
      workflowName: 'workflow',
      runId: 'run',
      scopeIdentity: 'scope',
      workflowTask: 'Fix the code.',
      issuedAt: '2026-07-29T00:00:00.000Z',
    }, {
      target: codeTarget,
      claimIdentityHash: 'c'.repeat(64),
      targetFindingId: null,
      requests: [{ kind: 'file_quote', path: 'src/a.ts', startLine, endLine }],
    });

    expect(result.coverageGaps).toEqual([]);
    expect(result.evidence).toEqual([{
      kind: 'file_quote',
      path: 'src/a.ts',
      startLine,
      endLine,
      verbatimExcerpt: expected,
      snapshotId,
    }]);
    expect(result.materializedQuoteBytes).toBe(Buffer.byteLength(expected));
  });

  it('re-reads complete inventory without retained bytes only when the canonical file matches the snapshot digest', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-quote-reread-'));
    try {
      mkdirSync(join(cwd, 'src'));
      const content = Buffer.from('first\nsecond\n');
      writeFileSync(join(cwd, 'src/a.ts'), content);
      const codeTarget: FindingTarget = {
        kind: 'code',
        paths: ['src/a.ts'],
        symbol: null,
      };
      const issue = (contentDigest: string) => issueFindingEvidenceRequests({
        cwd,
        snapshot: {
          ...snapshot,
          queryInventory: [{
            path: 'src/a.ts',
            kind: 'file',
            contentDigest,
            coverage: 'complete',
          }],
        },
        workflowName: 'workflow',
        runId: 'run',
        scopeIdentity: 'scope',
        workflowTask: 'Fix the code.',
        issuedAt: '2026-07-29T00:00:00.000Z',
      }, {
        target: codeTarget,
        claimIdentityHash: 'c'.repeat(64),
        targetFindingId: null,
        requests: [{ kind: 'file_quote', path: 'src/a.ts', startLine: 2, endLine: 2 }],
      });

      expect(issue(sha256(content))).toMatchObject({
        coverageGaps: [],
        evidence: [{ verbatimExcerpt: 'second' }],
      });
      expect(issue('f'.repeat(64))).toMatchObject({
        evidence: [],
        coverageGaps: ['source file "src/a.ts" no longer matches its review scope contentDigest'],
        quoteFailureReasons: [],
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('re-reads a resource-capped file quote when the source matches the snapshot digest', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-resource-cap-quote-'));
    try {
      mkdirSync(join(cwd, 'src'));
      const content = Buffer.from('first\nsecond\n');
      writeFileSync(join(cwd, 'src/a.ts'), content);

      expect(issueResourceCappedFileQuote(cwd, sha256(content))).toMatchObject({
        evidence: [{ verbatimExcerpt: 'second' }],
        coverageGaps: [],
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a resource-capped file quote when the source digest changed', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-resource-cap-quote-'));
    try {
      mkdirSync(join(cwd, 'src'));
      writeFileSync(join(cwd, 'src/a.ts'), 'first\nsecond\n');

      expect(issueResourceCappedFileQuote(cwd, 'f'.repeat(64))).toMatchObject({
        evidence: [],
        coverageGaps: ['source file "src/a.ts" no longer matches its review scope contentDigest'],
        quoteFailureReasons: [],
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a resource-capped file quote when the source exceeds 1 MiB', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-resource-cap-quote-'));
    try {
      mkdirSync(join(cwd, 'src'));
      const oversized = Buffer.alloc((1024 * 1024) + 1, 0x78);
      writeFileSync(join(cwd, 'src/a.ts'), oversized);

      const oversizedResult = issueResourceCappedFileQuote(cwd, sha256(oversized));
      expect(oversizedResult.evidence).toEqual([]);
      expect(oversizedResult.coverageGaps).toEqual([
        'source file "src/a.ts" exceeds the 1048576-byte evidence source limit',
      ]);
      expect(oversizedResult.quoteFailureReasons).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects retained bytes whose digest does not match the snapshot inventory digest', () => {
    const content = Buffer.from('current\n');
    const result = issueFindingEvidenceRequests({
      snapshot: {
        ...snapshot,
        queryInventory: [{
          path: 'src/a.ts',
          kind: 'file',
          contentDigest: 'f'.repeat(64),
          content,
          coverage: 'complete',
        }],
      },
      workflowName: 'workflow',
      runId: 'run',
      scopeIdentity: 'scope',
      workflowTask: 'Fix the code.',
      issuedAt: '2026-07-29T00:00:00.000Z',
    }, {
      target: { kind: 'code', paths: ['src/a.ts'], symbol: null },
      claimIdentityHash: 'c'.repeat(64),
      targetFindingId: null,
      requests: [{ kind: 'file_quote', path: 'src/a.ts', startLine: 1, endLine: 1 }],
    });

    expect(result.evidence).toEqual([]);
    expect(result.coverageGaps).toEqual([
      'retained content for "src/a.ts" does not match its contentDigest',
    ]);
    expect(result.quoteFailureReasons).toEqual([]);
  });

  it.each([
    {
      name: 'outside the code target',
      targetPaths: ['src/a.ts'],
      requestPath: 'src/other.ts',
      reason: 'file_quote request is unrelated to the code target',
    },
    {
      name: 'outside the canonical project namespace',
      targetPaths: ['../outside.ts'],
      requestPath: '../outside.ts',
      reason: 'file_quote path "../outside.ts" is not canonical',
    },
  ])('rejects a request $name', ({ targetPaths, requestPath, reason }) => {
    const result = issueFindingEvidenceRequests({
      snapshot,
      workflowName: 'workflow',
      runId: 'run',
      scopeIdentity: 'scope',
      workflowTask: 'Fix the code.',
      issuedAt: '2026-07-29T00:00:00.000Z',
    }, {
      target: { kind: 'code', paths: targetPaths, symbol: null },
      claimIdentityHash: 'c'.repeat(64),
      targetFindingId: null,
      requests: [{ kind: 'file_quote', path: requestPath, startLine: 1, endLine: 1 }],
    });

    expect(result.evidence).toEqual([]);
    expect(result.coverageGaps).toEqual([reason]);
    expect(result.quoteFailureReasons).toEqual([reason]);
  });

  it.each([
    {
      name: 'non-UTF-8 bytes',
      content: Buffer.from([0xff, 0xfe]),
      startLine: 1,
      endLine: 1,
      reason: /not valid UTF-8/,
      reviewerInvalid: false,
    },
    {
      name: 'an out-of-range line',
      content: Buffer.from('one\n'),
      startLine: 2,
      endLine: 2,
      reason: /out of range/,
      reviewerInvalid: true,
    },
    {
      name: 'a non-positive start line',
      content: Buffer.from('one\n'),
      startLine: 0,
      endLine: 1,
      reason: /line range 0-1 is invalid/,
      reviewerInvalid: true,
    },
    {
      name: 'a reversed line range',
      content: Buffer.from('one\ntwo\n'),
      startLine: 2,
      endLine: 1,
      reason: /line range 2-1 is invalid/,
      reviewerInvalid: true,
    },
    {
      name: 'an over-limit span outside the real file range',
      content: Buffer.from('one\n'),
      startLine: 1,
      endLine: 201,
      reason: /out of range/,
      reviewerInvalid: true,
    },
    {
      name: 'an empty materialized quote',
      content: Buffer.from('\n'),
      startLine: 1,
      endLine: 1,
      reason: /materialized file quote is empty/,
      reviewerInvalid: true,
    },
    {
      name: 'more than 200 lines',
      content: Buffer.from('x\n'.repeat(201)),
      startLine: 1,
      endLine: 201,
      reason: /200-line quote limit/,
      reviewerInvalid: false,
    },
    {
      name: 'more than 8192 quote bytes',
      content: Buffer.from(`${'x'.repeat(8193)}\n`),
      startLine: 1,
      endLine: 1,
      reason: /8192-byte quote limit/,
      reviewerInvalid: false,
    },
    {
      name: 'more than 1 MiB of source bytes',
      content: Buffer.alloc((1024 * 1024) + 1, 0x78),
      startLine: 1,
      endLine: 1,
      reason: /1048576-byte evidence source limit/,
      reviewerInvalid: false,
    },
  ])('fails closed without a partial quote for $name', ({
    content,
    startLine,
    endLine,
    reason,
    reviewerInvalid,
  }) => {
    const codeTarget: FindingTarget = {
      kind: 'code',
      paths: ['src/a.ts'],
      symbol: null,
    };
    const result = issueFindingEvidenceRequests({
      snapshot: {
        ...snapshot,
        queryInventory: [{
          path: 'src/a.ts',
          kind: 'file',
          contentDigest: sha256(content),
          content,
          coverage: 'complete',
        }],
      },
      workflowName: 'workflow',
      runId: 'run',
      scopeIdentity: 'scope',
      workflowTask: 'Fix the code.',
      issuedAt: '2026-07-29T00:00:00.000Z',
    }, {
      target: codeTarget,
      claimIdentityHash: 'c'.repeat(64),
      targetFindingId: null,
      requests: [{ kind: 'file_quote', path: 'src/a.ts', startLine, endLine }],
    });

    expect(result.evidence).toEqual([]);
    expect(result.coverageGaps).toHaveLength(1);
    expect(result.coverageGaps[0]).toMatch(reason);
    expect(result.quoteFailureReasons).toHaveLength(reviewerInvalid ? 1 : 0);
  });

  it('rejects symlink and missing re-read paths within the canonical project boundary', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-quote-path-'));
    try {
      mkdirSync(join(cwd, 'src'));
      writeFileSync(join(cwd, 'actual.ts'), 'actual\n');
      symlinkSync('../actual.ts', join(cwd, 'src/linked.ts'));
      const codeTarget: FindingTarget = {
        kind: 'code',
        paths: ['src/linked.ts', 'src/missing.ts'],
        symbol: null,
      };
      const issue = (path: string) => issueFindingEvidenceRequests({
        cwd,
        snapshot: {
          ...snapshot,
          queryInventory: [{
            path,
            kind: 'file',
            contentDigest: sha256(Buffer.from('actual\n')),
            coverage: 'complete',
          }],
        },
        workflowName: 'workflow',
        runId: 'run',
        scopeIdentity: 'scope',
        workflowTask: 'Fix the code.',
        issuedAt: '2026-07-29T00:00:00.000Z',
      }, {
        target: codeTarget,
        claimIdentityHash: 'c'.repeat(64),
        targetFindingId: null,
        requests: [{ kind: 'file_quote', path, startLine: 1, endLine: 1 }],
      });

      expect(issue('src/linked.ts').coverageGaps[0]).toMatch(/symbolic link/);
      expect(issue('src/missing.ts').coverageGaps[0]).toMatch(/does not exist|could not be inspected/);
      expect(issue('src/linked.ts').quoteFailureReasons).toEqual([]);
      expect(issue('src/missing.ts').quoteFailureReasons).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('withholds every file quote after one quote request fails while retaining engine proof evidence', () => {
    const content = Buffer.from('one\ntwo\n');
    const codeTarget: FindingTarget = {
      kind: 'code',
      paths: ['src/a.ts'],
      symbol: null,
    };
    const result = issueFindingEvidenceRequests({
      snapshot: {
        ...snapshot,
        queryInventory: [{
          path: 'src/a.ts',
          kind: 'file',
          contentDigest: sha256(content),
          content,
          coverage: 'complete',
        }],
      },
      workflowName: 'workflow',
      runId: 'run',
      scopeIdentity: 'scope',
      workflowTask: 'Fix the code.',
      issuedAt: '2026-07-29T00:00:00.000Z',
    }, {
      target: codeTarget,
      claimIdentityHash: 'c'.repeat(64),
      targetFindingId: null,
      requests: [
        { kind: 'file_quote', path: 'src/a.ts', startLine: 1, endLine: 1 },
        { kind: 'engine_proof', subject: {
          kind: 'authoritative_quote',
          source: 'task',
          declarationId: 'workflow_task',
          verbatimExcerpt: 'Fix the code.',
        } },
        { kind: 'file_quote', path: 'src/a.ts', startLine: 99, endLine: 99 },
      ],
    });

    expect(result.evidence).toEqual([{
      kind: 'engine_proof',
      proofId: result.engineProofRecords[0]!.proofId,
    }]);
    expect(result.engineProofRecords).toHaveLength(1);
    expect(result.materializedQuoteBytes).toBe(3);
    expect(result.coverageGaps[0]).toMatch(/out of range/);
    expect(result.quoteFailureReasons[0]).toMatch(/out of range/);
  });

  it('enforces exact reviewer and step byte budgets without truncation', () => {
    const content = Buffer.from(`${'x'.repeat(8192)}\n`);
    const codeTarget: FindingTarget = {
      kind: 'code',
      paths: ['src/a.ts'],
      symbol: null,
    };
    const issue = (reviewerRemainingBytes: number, stepRemainingBytes: number) => (
      issueFindingEvidenceRequests({
        snapshot: {
          ...snapshot,
          queryInventory: [{
            path: 'src/a.ts',
            kind: 'file',
            contentDigest: sha256(content),
            content,
            coverage: 'complete',
          }],
        },
        workflowName: 'workflow',
        runId: 'run',
        scopeIdentity: 'scope',
        workflowTask: 'Fix the code.',
        issuedAt: '2026-07-29T00:00:00.000Z',
      }, {
        target: codeTarget,
        claimIdentityHash: 'c'.repeat(64),
        targetFindingId: null,
        requests: [{ kind: 'file_quote', path: 'src/a.ts', startLine: 1, endLine: 1 }],
        quoteByteBudget: { reviewerRemainingBytes, stepRemainingBytes },
      })
    );

    expect(issue(8192, 8192)).toMatchObject({
      coverageGaps: [],
      materializedQuoteBytes: 8192,
    });
    expect(issue(8191, 8192)).toMatchObject({
      evidence: [],
      coverageGaps: ['file_quote issuance exceeds the remaining reviewer byte budget (8191 bytes)'],
      quoteFailureReasons: [],
      materializedQuoteBytes: 0,
    });
    expect(issue(8192, 8191)).toMatchObject({
      evidence: [],
      coverageGaps: ['file_quote issuance exceeds the remaining step byte budget (8191 bytes)'],
      quoteFailureReasons: [],
      materializedQuoteBytes: 0,
    });
  });

  it('keeps snapshotId, proofId, and run binding out of the normalizer schema', () => {
    const schema = JSON.stringify(createRawFindingsOutputJsonSchema());
    expect(schema).toContain('"rawExcerpt"');
    expect(schema).toContain('"evidenceRequests"');
    expect(schema).not.toContain('"snapshotId"');
    expect(schema).not.toContain('"proofId"');
    expect(schema).not.toContain('"runId"');
  });
});
