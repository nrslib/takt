/**
 * Test helper for the typed evidence protocol (codex 対策#4). Builds
 * evidenceKind/verbatimExcerpt/snapshotId fields that WILL pass
 * verifySourceQuoteEvidence (admission-validation.ts) for a given cwd-relative
 * path and 1-based line range, by reading the actual fixture file content —
 * so tests never hand-transcribe file content that has to stay byte-identical
 * to what the fixture setup wrote.
 *
 * Tests whose raw findings don't need to survive admission (e.g. they exist
 * only to reference a real ledger finding by id, or intentionally test the
 * rejected path) should not use this helper.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeReviewScopeSnapshotId } from '../../core/workflow/findings/snapshot.js';

export interface VerifiedSourceQuoteFields {
  location: string;
  evidenceKind: 'source_quote';
  verbatimExcerpt: string;
  snapshotId: string;
}

/**
 * Reads `cwd/relativePath` and returns the evidence fields for lines
 * [startLine, endLine] (1-based, inclusive; endLine defaults to startLine).
 * The returned `location` uses the "path:line" form for a single line and
 * "path:start-end" for a range, matching the reviewer-facing wire contract.
 */
export function verifiedSourceQuoteFields(
  cwd: string,
  relativePath: string,
  startLine: number,
  endLine: number = startLine,
): VerifiedSourceQuoteFields {
  const content = readFileSync(join(cwd, relativePath), 'utf-8');
  const lines = content.split('\n');
  const verbatimExcerpt = lines.slice(startLine - 1, endLine).join('\n');
  return {
    location: startLine === endLine ? `${relativePath}:${startLine}` : `${relativePath}:${startLine}-${endLine}`,
    evidenceKind: 'source_quote',
    verbatimExcerpt,
    snapshotId: computeReviewScopeSnapshotId(cwd),
  };
}
