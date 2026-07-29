import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeReviewScopeSnapshotId } from '../../core/workflow/findings/snapshot.js';
import {
  computeClaimIdentityHash,
  createEngineProofVerifierRegistry,
  createLedgerEngineProofRegistry,
} from '../../core/workflow/findings/evidence-domain.js';
import { verifyFindingEvidenceSet } from '../../core/workflow/findings/evidence-verification.js';
import type {
  FileQuoteEvidence,
  FindingEvidenceRecord,
} from '../../core/workflow/findings/types.js';

/**
 * Fixture の実ファイルから、機械照合を通る file_quote evidence を組み立てる。
 */
export function verifiedSourceQuoteFields(
  cwd: string,
  relativePath: string,
  startLine: number,
  endLine: number = startLine,
): FileQuoteEvidence {
  const content = readFileSync(join(cwd, relativePath), 'utf-8');
  const lines = content.split('\n');
  const verbatimExcerpt = lines.slice(startLine - 1, endLine).join('\n');
  return {
    kind: 'file_quote',
    path: relativePath,
    startLine,
    endLine,
    verbatimExcerpt,
    snapshotId: computeReviewScopeSnapshotId(cwd),
  };
}

export function verifiedFindingEvidenceFixture(input: {
  cwd: string;
  path: string;
  startLine: number;
  endLine?: number;
  title: string;
  description: string;
  targetFindingId: string | null;
  familyTag: string | null;
  severity?: 'critical' | 'high' | 'medium' | 'low' | null;
  suggestion?: string | null;
}): {
  evidence: FileQuoteEvidence;
  record: FindingEvidenceRecord;
} {
  const evidence = verifiedSourceQuoteFields(
    input.cwd,
    input.path,
    input.startLine,
    input.endLine,
  );
  const verification = verifyFindingEvidenceSet({
    cwd: input.cwd,
    evidence: [evidence],
    expectedSnapshotId: evidence.snapshotId,
    claimIdentityHash: computeClaimIdentityHash({
      target: {
        kind: 'code',
        paths: [input.path],
      },
      familyTag: input.familyTag,
      severity: input.severity ?? 'high',
      title: input.title,
      description: input.description,
      suggestion: input.suggestion ?? null,
    }),
    targetFindingId: input.targetFindingId,
    proofRegistry: createLedgerEngineProofRegistry({
      workflowName: 'fixture',
      nextId: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      findings: [],
      evidenceRecords: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    }),
    proofVerifiers: createEngineProofVerifierRegistry([]),
    proofContext: {
      cwd: input.cwd,
      workflowName: 'fixture',
      runId: 'fixture-run',
      scopeIdentity: 'fixture-scope',
    },
  });
  if (verification.outcome !== 'match' || verification.records.length !== 1) {
    throw new Error(`Fixture evidence did not pass production verification: ${verification.outcome}`);
  }
  return {
    evidence,
    record: verification.records[0]!,
  };
}
