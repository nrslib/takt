import { describe, expect, it } from 'vitest';
import {
  computeCandidateIdentityHash,
  computeClaimIdentityHash,
  computeSemanticClaimIdentityHash,
  computeTargetIdentityHash,
} from '../core/models/finding-claim-identity.js';
import type {
  CandidateSourceBinding,
  FindingClaimPayload,
  FindingTarget,
} from '../core/models/finding-types.js';

const target: FindingTarget = {
  kind: 'absence',
  predicate: {
    kind: 'exact_literal_search',
    roots: ['src', 'test'],
    literal: 'legacyApi(',
    textDomain: 'utf8',
  },
};

const claim: FindingClaimPayload = {
  familyTag: 'compatibility',
  severity: 'high',
  title: 'Legacy API remains in the review scope',
  description: 'The exact literal is still present.',
  suggestion: 'Remove the remaining call.',
};

const sourceBinding: CandidateSourceBinding = {
  reportDigest: '1'.repeat(64),
  startByte: 10,
  endByte: 42,
  excerptDigest: '2'.repeat(64),
};

describe('Finding Contract identity domains', () => {
  it('target identity depends only on the canonical target', () => {
    const identity = computeTargetIdentityHash(target);

    expect(identity).toBe(computeTargetIdentityHash(structuredClone(target)));
    expect(identity).not.toBe(computeTargetIdentityHash({
      kind: 'absence',
      predicate: {
        kind: 'exact_literal_search',
        roots: ['src', 'test'],
        literal: 'otherApi(',
        textDomain: 'utf8',
      },
    }));
  });

  it('claim identity uses target plus the exact claim payload', () => {
    const identity = computeClaimIdentityHash({ target, ...claim });

    expect(identity).toBe(computeClaimIdentityHash({ target, ...claim }));
    expect(identity).not.toBe(computeClaimIdentityHash({
      target,
      ...claim,
      title: ` ${claim.title}`,
    }));
    expect(identity).not.toBe(computeClaimIdentityHash({
      target,
      ...claim,
      suggestion: null,
    }));
  });

  it('semantic claim identity uses only target, title, and description', () => {
    const identity = computeSemanticClaimIdentityHash({
      target,
      title: claim.title,
      description: claim.description,
    });

    expect(identity).toBe(computeSemanticClaimIdentityHash({
      target,
      title: claim.title,
      description: claim.description,
    }));
    expect(identity).not.toBe(computeSemanticClaimIdentityHash({
      target,
      title: 'A different defect',
      description: claim.description,
    }));
    expect(computeClaimIdentityHash({ target, ...claim })).not.toBe(
      computeClaimIdentityHash({
        target,
        ...claim,
        familyTag: 'different-classification',
      }),
    );
    expect(identity).toBe(computeSemanticClaimIdentityHash({
      target,
      title: claim.title,
      description: claim.description,
    }));
  });

  it('candidate identity binds the claim to the verified report excerpt', () => {
    const claimIdentityHash = computeClaimIdentityHash({ target, ...claim });
    const identity = computeCandidateIdentityHash({ claimIdentityHash, sourceBinding });

    expect(identity).not.toBe(computeCandidateIdentityHash({
      claimIdentityHash,
      sourceBinding: {
        ...sourceBinding,
        startByte: sourceBinding.startByte + 1,
      },
    }));
  });

  it('rejects non-canonical target sets instead of silently sorting them', () => {
    expect(() => computeTargetIdentityHash({
      kind: 'code',
      paths: ['src/z.ts', 'src/a.ts'],
    })).toThrow(/binary-sorted unique/);
  });
});
