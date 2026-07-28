import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeClaimIdentityHash,
  computeEvidenceSetHash,
  createEngineProofVerifierRegistry,
  createLedgerEngineProofRegistry,
  deduplicateRawEvidence,
} from '../core/workflow/findings/evidence-domain.js';
import {
  computeEngineProofRecordId,
  computeFileQuoteEvidenceRecordId,
} from '../core/models/finding-evidence-record.js';
import { verifyFindingEvidenceSet } from '../core/workflow/findings/evidence-verification.js';
import { verifyFileQuoteEvidence } from '../core/workflow/findings/admission-validation.js';
import {
  parseFindingLedger as parseFindingLedgerSchema,
  parseRawFindings,
} from '../core/workflow/findings/schemas.js';
import { rawEvidenceFileQuoteLocations } from '../core/workflow/findings/evidence-location.js';
import { buildManagerInputLedger } from '../core/workflow/findings/manager-agent.js';
import { renderActionableFindingLedgerInstructionSummary } from '../core/workflow/findings/context.js';
import {
  issuePathAbsentEngineProof,
  pathAbsentEngineProofVerifier,
} from '../core/workflow/findings/path-absent-engine-proof.js';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
} from './helpers/run-storage.js';
import {
  authorizeFindingLedgerFixture,
  emptyFindingAuthorityProjection,
} from './helpers/finding-lifecycle-fixture.js';

const temporaryDirectories: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseFindingLedger(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return parseFindingLedgerSchema(value);
  }
  return parseFindingLedgerSchema({
    ...emptyFindingAuthorityProjection(),
    ...value,
  });
}

afterEach(() => {
  cleanupRealRunStorages();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Finding evidence domain', () => {
  const proofVerifiers = createEngineProofVerifierRegistry([
    pathAbsentEngineProofVerifier,
  ]);

  it('separates claim identity from the unordered evidence set', () => {
    const claim = computeClaimIdentityHash({
      targetFindingId: null,
      title: '  Missing Handler ',
      description: 'Exact claim text.',
    });
    expect(claim).toBe(computeClaimIdentityHash({
      targetFindingId: null,
      title: 'Missing Handler',
      description: 'Exact claim text.',
    }));
    expect(claim).not.toBe(computeClaimIdentityHash({
      targetFindingId: null,
      title: 'missing handler',
      description: 'Exact claim text.',
    }));
    expect(computeEvidenceSetHash(['evidence-b', 'evidence-a', 'evidence-a']))
      .toBe(computeEvidenceSetHash(['evidence-a', 'evidence-b']));
    const quotes = [
      {
        kind: 'file_quote' as const,
        path: 'src/z/../a.ts',
        startLine: 2,
        endLine: 2,
        verbatimExcerpt: 'two',
        snapshotId: sha256('snapshot'),
      },
      {
        kind: 'file_quote' as const,
        path: 'src/a.ts',
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: 'one',
        snapshotId: sha256('snapshot'),
      },
    ];
    expect(rawEvidenceFileQuoteLocations(quotes))
      .toEqual(rawEvidenceFileQuoteLocations([...quotes].reverse()));
    expect(deduplicateRawEvidence(quotes))
      .toEqual(deduplicateRawEvidence([...quotes].reverse()));
  });

  it('accepts only the nested evidence contract', () => {
    expect(parseRawFindings([{
      rawFindingId: 'raw-1',
      stepName: 'review',
      reviewer: 'reviewer',
      familyTag: null,
      severity: null,
      title: 'Claim',
      description: 'Description',
      suggestion: null,
      relation: 'new',
      targetFindingId: null,
      evidence: [],
    }])).toHaveLength(1);

    expect(() => parseRawFindings([{
      rawFindingId: 'raw-legacy',
      stepName: 'review',
      reviewer: 'reviewer',
      familyTag: 'correctness',
      severity: 'high',
      title: 'Legacy',
      description: 'Legacy flat evidence',
      relation: 'new',
      location: 'src/a.ts:1',
      evidenceKind: 'source_quote',
      verbatimExcerpt: 'text',
      snapshotId: 'snapshot',
    }])).toThrow();
  });

  it('verifies mixed file quotes and a path_absent proof through one authority', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-evidence-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'a.ts'), 'one\ntwo\nthree\n');
    const claimIdentityHash = computeClaimIdentityHash({
      targetFindingId: null,
      title: 'Claim',
      description: 'Description',
    });
    const snapshotId = sha256('snapshot-1');
    const context = {
      cwd,
      workflowName: 'default',
      runId: 'run-1',
      scopeIdentity: 'ledger-identity',
      snapshotId,
      claimIdentityHash,
      targetFindingId: null,
    };
    const proof = issuePathAbsentEngineProof({
      subject: { kind: 'path_absent', path: 'src/missing.ts' },
      context,
      issuedAt: '2026-07-28T00:00:00.000Z',
    });
    const ledger = parseFindingLedger({
      workflowName: 'default',
      nextId: 1,
      updatedAt: '2026-07-28T00:00:00.000Z',
      findings: [],
      evidenceRecords: [proof],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    });
    const proofRegistry = createLedgerEngineProofRegistry(ledger);
    const result = verifyFindingEvidenceSet({
      cwd,
      evidence: [
        {
          kind: 'file_quote',
          path: 'src/a.ts',
          startLine: 1,
          endLine: 1,
          verbatimExcerpt: 'one',
          snapshotId,
        },
        {
          kind: 'file_quote',
          path: 'src/a.ts',
          startLine: 2,
          endLine: 3,
          verbatimExcerpt: 'two\nthree',
          snapshotId,
        },
        { kind: 'engine_proof', proofId: proof.proofId },
      ],
      expectedSnapshotId: snapshotId,
      claimIdentityHash,
      targetFindingId: null,
      proofRegistry,
      proofVerifiers,
      proofContext: {
        cwd,
        workflowName: 'default',
        runId: 'run-1',
        scopeIdentity: 'ledger-identity',
      },
    });
    expect(result).toMatchObject({ outcome: 'match' });
    if (result.outcome === 'match') {
      expect(result.records).toHaveLength(3);
    }
  });

  it('reports the exact later evidence item when a multi-quote set fails', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-evidence-later-failure-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'a.ts'), 'first\nsecond\n');
    const snapshotId = sha256('snapshot-later-failure');
    const failedEvidence = {
      kind: 'file_quote' as const,
      path: 'src/a.ts',
      startLine: 2,
      endLine: 2,
      verbatimExcerpt: 'not second',
      snapshotId,
    };
    const result = verifyFindingEvidenceSet({
      cwd,
      evidence: [
        {
          kind: 'file_quote',
          path: 'src/a.ts',
          startLine: 1,
          endLine: 1,
          verbatimExcerpt: 'first',
          snapshotId,
        },
        failedEvidence,
      ],
      expectedSnapshotId: snapshotId,
      claimIdentityHash: sha256('claim-later-failure'),
      targetFindingId: null,
      proofRegistry: { get: () => undefined },
      proofVerifiers,
      proofContext: {
        cwd,
        workflowName: 'default',
        runId: 'run-1',
        scopeIdentity: 'ledger-identity',
      },
    });

    expect(result).toMatchObject({
      outcome: 'quote-mismatch',
      failureLevel: 'item',
      failedEvidenceIndex: 1,
      failedEvidence,
    });
  });

  it('canonicalizes engine proof timestamps before hashing and survives ledger verification', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-engine-proof-time-'));
    temporaryDirectories.push(cwd);
    const snapshotId = sha256('snapshot-engine-proof-time');
    const claimIdentityHash = sha256('claim-engine-proof-time');
    const context = {
      cwd,
      workflowName: 'default',
      runId: 'run-1',
      scopeIdentity: 'ledger-identity',
      snapshotId,
      claimIdentityHash,
      targetFindingId: null,
    };
    const utc = issuePathAbsentEngineProof({
      subject: { kind: 'path_absent', path: 'missing.ts' },
      context,
      issuedAt: '2026-07-28T00:00:00Z',
    });
    const offset = issuePathAbsentEngineProof({
      subject: { kind: 'path_absent', path: 'missing.ts' },
      context,
      issuedAt: '2026-07-28T09:00:00+09:00',
    });

    expect(offset.proofId).toBe(utc.proofId);
    expect(offset.issuedAt).toBe('2026-07-28T00:00:00.000Z');
    const ledger = parseFindingLedger({
      workflowName: 'default',
      nextId: 1,
      updatedAt: offset.issuedAt,
      findings: [],
      evidenceRecords: [offset],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    });
    expect(ledger.evidenceRecords[0]).toEqual(offset);
    expect(verifyFindingEvidenceSet({
      cwd,
      evidence: [{ kind: 'engine_proof', proofId: offset.proofId }],
      expectedSnapshotId: snapshotId,
      claimIdentityHash,
      targetFindingId: null,
      proofRegistry: createLedgerEngineProofRegistry(ledger),
      proofVerifiers,
      proofContext: {
        cwd,
        workflowName: 'default',
        runId: 'run-1',
        scopeIdentity: 'ledger-identity',
      },
    })).toMatchObject({ outcome: 'match' });
    expect(() => issuePathAbsentEngineProof({
      subject: { kind: 'path_absent', path: 'another-missing.ts' },
      context,
      issuedAt: 'not-a-timestamp',
    })).toThrow(/RFC 3339 timestamp/);
  });

  it('isolates unknown, stale, and binding-mismatched engine proofs', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-engine-proof-'));
    temporaryDirectories.push(cwd);
    const snapshotId = sha256('snapshot');
    const claimIdentityHash = sha256('claim');
    const context = {
      cwd,
      workflowName: 'default',
      runId: 'run-1',
      scopeIdentity: 'ledger-identity',
      snapshotId,
      claimIdentityHash,
      targetFindingId: null,
    };
    const proof = issuePathAbsentEngineProof({
      subject: { kind: 'path_absent', path: 'missing.ts' },
      context,
      issuedAt: '2026-07-28T00:00:00.000Z',
    });
    const ledger = parseFindingLedger({
      workflowName: 'default',
      nextId: 1,
      updatedAt: '2026-07-28T00:00:00.000Z',
      findings: [],
      evidenceRecords: [proof],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    });
    const verify = (overrides?: {
      snapshotId?: string;
      claimIdentityHash?: string;
      targetFindingId?: string | null;
      scopeIdentity?: string;
    }) => verifyFindingEvidenceSet({
      cwd,
      evidence: [{ kind: 'engine_proof', proofId: proof.proofId }],
      expectedSnapshotId: overrides?.snapshotId ?? snapshotId,
      claimIdentityHash: overrides?.claimIdentityHash ?? claimIdentityHash,
      targetFindingId: overrides?.targetFindingId === undefined
        ? null
        : overrides.targetFindingId,
      proofRegistry: createLedgerEngineProofRegistry(ledger),
      proofVerifiers,
      proofContext: {
        cwd,
        workflowName: 'default',
        runId: 'run-1',
        scopeIdentity: overrides?.scopeIdentity ?? 'ledger-identity',
      },
    });

    expect(verify({ scopeIdentity: 'other-ledger' })).toMatchObject({ outcome: 'mismatch' });
    expect(verify({ claimIdentityHash: sha256('other-claim') })).toMatchObject({ outcome: 'mismatch' });
    expect(verify({ targetFindingId: 'F-0001' })).toMatchObject({ outcome: 'mismatch' });
    expect(verify({ snapshotId: sha256('other-snapshot') })).toMatchObject({ outcome: 'mismatch' });
    expect(verifyFindingEvidenceSet({
      cwd,
      evidence: [{ kind: 'engine_proof', proofId: sha256('unknown') }],
      expectedSnapshotId: snapshotId,
      claimIdentityHash,
      targetFindingId: null,
      proofRegistry: createLedgerEngineProofRegistry(ledger),
      proofVerifiers,
      proofContext: {
        cwd,
        workflowName: 'default',
        runId: 'run-1',
        scopeIdentity: 'ledger-identity',
      },
    })).toMatchObject({ outcome: 'mismatch' });

    writeFileSync(join(cwd, 'missing.ts'), 'now present\n');
    expect(verify()).toMatchObject({ outcome: 'mismatch' });
  });

  it('classifies a forged engine proof record as a protocol anomaly', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-engine-proof-forged-'));
    temporaryDirectories.push(cwd);
    const snapshotId = sha256('snapshot');
    const claimIdentityHash = sha256('claim');
    const context = {
      cwd,
      workflowName: 'default',
      runId: 'run-1',
      scopeIdentity: 'ledger-identity',
      snapshotId,
      claimIdentityHash,
      targetFindingId: null,
    };
    const proof = issuePathAbsentEngineProof({
      subject: { kind: 'path_absent', path: 'missing.ts' },
      context,
      issuedAt: '2026-07-28T00:00:00.000Z',
    });

    expect(verifyFindingEvidenceSet({
      cwd,
      evidence: [{ kind: 'engine_proof', proofId: proof.proofId }],
      expectedSnapshotId: snapshotId,
      claimIdentityHash,
      targetFindingId: null,
      proofRegistry: {
        get: () => ({ ...proof, resultDigest: sha256('forged') }),
      },
      proofVerifiers,
      proofContext: {
        cwd,
        workflowName: 'default',
        runId: 'run-1',
        scopeIdentity: 'ledger-identity',
      },
    })).toMatchObject({ outcome: 'protocol-anomaly' });
  });

  it('routes a proof with an unregistered verifier to mismatch', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-engine-proof-unsupported-'));
    temporaryDirectories.push(cwd);
    const snapshotId = sha256('snapshot');
    const claimIdentityHash = sha256('claim');
    const payload = {
      kind: 'engine_proof' as const,
      verifierId: 'takt.named-structural-check',
      verifierVersion: '1',
      workflowName: 'default',
      runId: 'run-1',
      scopeIdentity: 'ledger-identity',
      snapshotId,
      claimIdentityHash,
      targetFindingId: null,
      subject: {
        kind: 'named_structural_check' as const,
        checkId: 'check-generated-output',
        parameters: { path: 'generated/output.ts' },
      },
      dependencyDigests: [sha256('dependency')],
      resultDigest: sha256('result'),
      issuedAt: '2026-07-28T00:00:00.000Z',
    };
    const proofId = computeEngineProofRecordId(payload);
    const ledger = parseFindingLedger({
      workflowName: 'default',
      nextId: 1,
      updatedAt: '2026-07-28T00:00:00.000Z',
      findings: [],
      evidenceRecords: [{ evidenceId: proofId, proofId, ...payload }],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    });

    expect(verifyFindingEvidenceSet({
      cwd,
      evidence: [{ kind: 'engine_proof', proofId }],
      expectedSnapshotId: snapshotId,
      claimIdentityHash,
      targetFindingId: null,
      proofRegistry: createLedgerEngineProofRegistry(ledger),
      proofVerifiers,
      proofContext: {
        cwd,
        workflowName: 'default',
        runId: 'run-1',
        scopeIdentity: 'ledger-identity',
      },
    })).toMatchObject({
      outcome: 'mismatch',
      reason: expect.stringContaining('is not registered'),
    });
  });

  it('rejects a path_absent proof through an ancestor symlink at issuance', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-engine-proof-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'takt-engine-proof-outside-'));
    temporaryDirectories.push(cwd, outside);
    symlinkSync(outside, join(cwd, 'escape'), 'dir');

    expect(() => issuePathAbsentEngineProof({
      subject: { kind: 'path_absent', path: 'escape/missing.ts' },
      context: {
        cwd,
        workflowName: 'default',
        runId: 'run-1',
        scopeIdentity: 'ledger-identity',
        snapshotId: sha256('snapshot'),
        claimIdentityHash: sha256('claim'),
        targetFindingId: null,
      },
      issuedAt: '2026-07-28T00:00:00.000Z',
    })).toThrow(/boundary violation \(symlink\)/);
  });

  it('invalidates freshness when a missing ancestor becomes a directory', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-engine-proof-ancestor-'));
    temporaryDirectories.push(cwd);
    const snapshotId = sha256('snapshot');
    const claimIdentityHash = sha256('claim');
    const context = {
      cwd,
      workflowName: 'default',
      runId: 'run-1',
      scopeIdentity: 'ledger-identity',
      snapshotId,
      claimIdentityHash,
      targetFindingId: null,
    };
    const proof = issuePathAbsentEngineProof({
      subject: { kind: 'path_absent', path: 'generated/missing.ts' },
      context,
      issuedAt: '2026-07-28T00:00:00.000Z',
    });
    const ledger = parseFindingLedger({
      workflowName: 'default',
      nextId: 1,
      updatedAt: '2026-07-28T00:00:00.000Z',
      findings: [],
      evidenceRecords: [proof],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    });

    mkdirSync(join(cwd, 'generated'));

    expect(verifyFindingEvidenceSet({
      cwd,
      evidence: [{ kind: 'engine_proof', proofId: proof.proofId }],
      expectedSnapshotId: snapshotId,
      claimIdentityHash,
      targetFindingId: null,
      proofRegistry: createLedgerEngineProofRegistry(ledger),
      proofVerifiers,
      proofContext: {
        cwd,
        workflowName: 'default',
        runId: 'run-1',
        scopeIdentity: 'ledger-identity',
      },
    })).toMatchObject({
      outcome: 'mismatch',
      reason: expect.stringContaining('dependencyDigests'),
    });
  });

  it('routes a missing ancestor changed to an escaping symlink to mismatch', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-engine-proof-stale-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'takt-engine-proof-stale-outside-'));
    temporaryDirectories.push(cwd, outside);
    const snapshotId = sha256('snapshot');
    const claimIdentityHash = sha256('claim');
    const context = {
      cwd,
      workflowName: 'default',
      runId: 'run-1',
      scopeIdentity: 'ledger-identity',
      snapshotId,
      claimIdentityHash,
      targetFindingId: null,
    };
    const proof = issuePathAbsentEngineProof({
      subject: { kind: 'path_absent', path: 'generated/missing.ts' },
      context,
      issuedAt: '2026-07-28T00:00:00.000Z',
    });
    const ledger = parseFindingLedger({
      workflowName: 'default',
      nextId: 1,
      updatedAt: '2026-07-28T00:00:00.000Z',
      findings: [],
      evidenceRecords: [proof],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    });

    symlinkSync(outside, join(cwd, 'generated'), 'dir');

    expect(verifyFindingEvidenceSet({
      cwd,
      evidence: [{ kind: 'engine_proof', proofId: proof.proofId }],
      expectedSnapshotId: snapshotId,
      claimIdentityHash,
      targetFindingId: null,
      proofRegistry: createLedgerEngineProofRegistry(ledger),
      proofVerifiers,
      proofContext: {
        cwd,
        workflowName: 'default',
        runId: 'run-1',
        scopeIdentity: 'ledger-identity',
      },
    })).toMatchObject({
      outcome: 'mismatch',
      reason: expect.stringContaining('boundary violation (symlink)'),
    });
  });

  it.each([
    '/absolute/missing.ts',
    '../traversal/missing.ts',
    'nested/../traversal/missing.ts',
  ])('routes schema-valid invalid path_absent subject "%s" to mismatch', (path) => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-engine-proof-invalid-path-'));
    temporaryDirectories.push(cwd);
    const snapshotId = sha256('snapshot');
    const claimIdentityHash = sha256('claim');
    const payload = {
      kind: 'engine_proof' as const,
      verifierId: pathAbsentEngineProofVerifier.verifierId,
      verifierVersion: pathAbsentEngineProofVerifier.verifierVersion,
      workflowName: 'default',
      runId: 'run-1',
      scopeIdentity: 'ledger-identity',
      snapshotId,
      claimIdentityHash,
      targetFindingId: null,
      subject: { kind: 'path_absent' as const, path },
      dependencyDigests: [sha256('dependency')],
      resultDigest: sha256('result'),
      issuedAt: '2026-07-28T00:00:00.000Z',
    };
    const proofId = computeEngineProofRecordId(payload);
    const ledger = parseFindingLedger({
      workflowName: 'default',
      nextId: 1,
      updatedAt: '2026-07-28T00:00:00.000Z',
      findings: [],
      evidenceRecords: [{ evidenceId: proofId, proofId, ...payload }],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    });

    expect(verifyFindingEvidenceSet({
      cwd,
      evidence: [{ kind: 'engine_proof', proofId }],
      expectedSnapshotId: snapshotId,
      claimIdentityHash,
      targetFindingId: null,
      proofRegistry: createLedgerEngineProofRegistry(ledger),
      proofVerifiers,
      proofContext: {
        cwd,
        workflowName: 'default',
        runId: 'run-1',
        scopeIdentity: 'ledger-identity',
      },
    })).toMatchObject({ outcome: 'mismatch' });
  });

  it.runIf(process.platform !== 'win32' && process.getuid() !== 0)(
    'treats an inaccessible ancestor as unverifiable instead of absent',
    () => {
      const cwd = mkdtempSync(join(tmpdir(), 'takt-engine-proof-permission-'));
      temporaryDirectories.push(cwd);
      const locked = join(cwd, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      try {
        expect(pathAbsentEngineProofVerifier.verify(
          { kind: 'path_absent', path: 'locked/missing.ts' },
          {
            cwd,
            workflowName: 'default',
            runId: 'run-1',
            scopeIdentity: 'ledger-identity',
            snapshotId: sha256('snapshot'),
            claimIdentityHash: sha256('claim'),
            targetFindingId: null,
          },
        )).toMatchObject({ outcome: 'unverifiable' });
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  it('hashes raw bytes and verifies CRLF and Unicode without normalization', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-evidence-utf8-'));
    temporaryDirectories.push(cwd);
    const content = Buffer.from('alpha\r\n日本語🙂\r\nomega\r\n', 'utf8');
    writeFileSync(join(cwd, 'quoted.txt'), content);
    const snapshotId = sha256('snapshot');
    const evidence = {
      kind: 'file_quote' as const,
      path: 'quoted.txt',
      startLine: 1,
      endLine: 2,
      verbatimExcerpt: 'alpha\r\n日本語🙂',
      snapshotId,
    };

    expect(verifyFileQuoteEvidence(cwd, evidence, snapshotId)).toEqual({
      outcome: 'match',
      fileHash: sha256(content),
    });
    expect(verifyFileQuoteEvidence(cwd, {
      ...evidence,
      verbatimExcerpt: 'alpha\n日本語🙂',
    }, snapshotId)).toMatchObject({ outcome: 'quote-mismatch' });

    writeFileSync(join(cwd, 'invalid.txt'), Buffer.from([0x66, 0x80, 0x0a]));
    expect(verifyFileQuoteEvidence(cwd, {
      ...evidence,
      path: 'invalid.txt',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'f',
    }, snapshotId)).toMatchObject({ outcome: 'unverifiable' });

    const bomContent = Buffer.from('\uFEFFfirst\nsecond\n', 'utf8');
    writeFileSync(join(cwd, 'bom.txt'), bomContent);
    const bomEvidence = {
      ...evidence,
      path: 'bom.txt',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: '\uFEFFfirst',
    };
    expect(verifyFileQuoteEvidence(cwd, bomEvidence, snapshotId)).toEqual({
      outcome: 'match',
      fileHash: sha256(bomContent),
    });
    expect(verifyFileQuoteEvidence(cwd, {
      ...bomEvidence,
      verbatimExcerpt: 'first',
    }, snapshotId)).toMatchObject({ outcome: 'quote-mismatch' });
    expect(verifyFileQuoteEvidence(cwd, {
      ...evidence,
      path: 'quoted.txt',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: '\uFEFFalpha',
    }, snapshotId)).toMatchObject({ outcome: 'quote-mismatch' });
  });

  it('rejects forged content addresses at the ledger schema boundary', () => {
    const payload = {
      kind: 'file_quote' as const,
      path: 'src/a.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'one',
      snapshotId: sha256('snapshot'),
      claimIdentityHash: sha256('claim'),
      fileHash: sha256('file'),
    };
    const validRecord = {
      evidenceId: computeFileQuoteEvidenceRecordId(payload),
      ...payload,
    };
    const ledger = {
      workflowName: 'default',
      nextId: 1,
      updatedAt: '2026-07-28T00:00:00.000Z',
      findings: [],
      evidenceRecords: [validRecord],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    };
    expect(parseFindingLedger(ledger).evidenceRecords).toEqual([validRecord]);
    expect(() => parseFindingLedger({
      ...ledger,
      evidenceRecords: [{ ...validRecord, evidenceId: sha256('forged') }],
    })).toThrow(/canonical content address/);
  });

  it('passes every file quote location to manager and fixer contexts', () => {
    const claimIdentityHash = computeClaimIdentityHash({
      targetFindingId: null,
      title: 'Cross-file claim',
      description: 'Both files participate.',
    });
    const evidenceRecords = ['b.ts', 'a.ts'].map((path) => {
      const payload = {
        kind: 'file_quote' as const,
        path,
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: path,
        snapshotId: sha256('snapshot'),
        claimIdentityHash,
        fileHash: sha256(path),
      };
      return {
        evidenceId: computeFileQuoteEvidenceRecordId(payload),
        ...payload,
      };
    });
    const observation = {
      runId: 'run-1',
      stepName: 'review',
      timestamp: '2026-07-28T00:00:00.000Z',
    };
    const ledger = parseFindingLedger({
      workflowName: 'default',
      nextId: 2,
      updatedAt: observation.timestamp,
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: 'Cross-file claim',
        description: 'Both files participate.',
        evidenceIds: evidenceRecords.map(({ evidenceId }) => evidenceId).sort(),
        reviewers: ['reviewer'],
        rawFindingIds: [],
        firstSeen: observation,
        lastSeen: observation,
        revision: 1,
      }],
      evidenceRecords,
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    });
    const manager = buildManagerInputLedger(ledger) as {
      findings: Array<{ locations: string[] }>;
    };
    const fixer = JSON.parse(
      renderActionableFindingLedgerInstructionSummary(ledger),
    ) as { open: Array<{ locations: string[] }> };

    expect(manager.findings[0]?.locations).toEqual(['a.ts:1', 'b.ts:1']);
    expect(fixer.open[0]?.locations).toEqual(['a.ts:1', 'b.ts:1']);
  });

  it('round-trips evidence records through the SQLite authority projection', async () => {
    const { root } = createRealRunStorage({ findingContractEnabled: true });
    const lease = root.claimLease({ ownerKey: 'evidence-domain', leaseDurationMs: 9_000 });
    const runtime = root.runtime({ lease });
    const execution = runtime.execution.startStep({
      stepKey: 'findings-manager',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    const claimIdentityHash = computeClaimIdentityHash({
      targetFindingId: null,
      title: 'Claim',
      description: 'Description',
    });
    const evidencePayload = {
      kind: 'file_quote' as const,
      path: 'src/a.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'one',
      snapshotId: sha256('snapshot-1'),
      claimIdentityHash,
      fileHash: sha256('one'),
    };
    const evidenceRecord = {
      evidenceId: computeFileQuoteEvidenceRecordId(evidencePayload),
      ...evidencePayload,
    };
    const observation = {
      runId: 'run-1',
      stepName: 'review',
      timestamp: '2026-07-28T00:00:00.000Z',
    };
    const authorizedLedger = authorizeFindingLedgerFixture({
      ...store.loadLedger(),
      evidenceRecords: [evidenceRecord],
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: 'Claim',
        evidenceIds: [evidenceRecord.evidenceId],
        reviewers: ['reviewer'],
        rawFindingIds: [],
        firstSeen: observation,
        lastSeen: observation,
        revision: 1,
      }],
      nextId: 2,
    });
    await store.updateLedger(() => ({
      ledger: authorizedLedger,
      result: undefined,
    }));

    const ledger = store.loadLedger();
    expect(parseFindingLedger(ledger)).toEqual(ledger);
    expect(ledger.evidenceRecords).toEqual(authorizedLedger.evidenceRecords);
    expect(ledger.findings[0]?.evidenceIds).toEqual(authorizedLedger.findings[0]?.evidenceIds);
    expect(() => store.updateLedger((current) => ({
      ledger: { ...current, evidenceRecords: [], findings: [] },
      result: undefined,
    }))).toThrow(/references unknown evidence/);
  });
});
