import { describe, expect, it } from 'vitest';
import {
  computeClaimIdentityHash,
} from '../core/models/finding-claim-identity.js';
import {
  createRawFindingsOutputJsonSchema,
} from '../core/models/finding-schemas.js';
import {
  createSnapshotEngineProofVerifiers,
  issueFindingEvidenceRequests,
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
        relation: null,
        targetFindingId: null,
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
      issueEvidenceRequests: () => ({
        evidence: [],
        engineProofRecords: [],
        coverageGaps: [],
      }),
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

  it('keeps snapshotId, proofId, and run binding out of the normalizer schema', () => {
    const schema = JSON.stringify(createRawFindingsOutputJsonSchema());
    expect(schema).toContain('"rawExcerpt"');
    expect(schema).toContain('"evidenceRequests"');
    expect(schema).not.toContain('"snapshotId"');
    expect(schema).not.toContain('"proofId"');
    expect(schema).not.toContain('"runId"');
  });
});
