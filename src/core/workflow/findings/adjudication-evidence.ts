import { createHash } from 'node:crypto';
import { normalizeFindingText } from './location.js';
import type { FindingConflictAdjudicationAttempt, FindingLedger, FindingLedgerConflict, RawFinding } from './types.js';

/**
 * "1回制限" (Phase B design item 1): a conflict is only ever adjudicated once
 * per distinct body of evidence. evidenceHash is a deterministic digest of the
 * evidence CONTENT that would be shown to the adjudicator for a given conflict
 * (codex B2: hashing ids alone missed content edits and changed spuriously on
 * id re-namespacing):
 *
 * - the BODY (title / description / location / severity / suggestion) of every
 *   raw finding referenced by the conflict directly (conflict.rawFindingIds)
 *   or attached to a finding the conflict names (finding.rawFindingIds);
 *   normalized, de-duplicated by content, and sorted
 * - the dispute records (reason + evidence) on those findings — normalized,
 *   de-duplicated, sorted
 * - the conflict's own description (normalized)
 *
 * All inputs are ledger-resident (no dependency on ephemeral per-step text such
 * as the coder's prior response), so the hash can be recomputed identically
 * when building FindingsRuleContext (to decide whether a conflict counts as
 * "unadjudicated"), when the adjudication step records its attempt, and again
 * immediately before applying the decision (codex B2: the applied hash must
 * EQUAL the hash the LLM was prompted with; a mismatch discards the decision).
 * New raw finding content or a new dispute changes the hash and makes the
 * conflict eligible for adjudication again; a raw finding id changing without
 * a content change does not.
 */
export function computeConflictEvidenceHash(
  conflict: Pick<FindingLedgerConflict, 'findingIds' | 'rawFindingIds' | 'description'>,
  ledger: Pick<FindingLedger, 'findings' | 'rawFindings'>,
): string {
  const findingsById = new Map(ledger.findings.map((finding) => [finding.id, finding]));
  const rawFindingsById = new Map(ledger.rawFindings.map((raw) => [raw.rawFindingId, raw]));

  const rawFindingIds = new Set(conflict.rawFindingIds);
  const disputeTexts = new Set<string>();

  for (const findingId of conflict.findingIds) {
    const finding = findingsById.get(findingId);
    if (finding === undefined) {
      continue;
    }
    for (const rawFindingId of finding.rawFindingIds) {
      rawFindingIds.add(rawFindingId);
    }
    for (const dispute of finding.disputes ?? []) {
      disputeTexts.add(`${normalizeFindingText(dispute.reason)}\n${normalizeFindingText(dispute.evidence)}`);
    }
  }

  const rawContents = new Set<string>();
  for (const rawFindingId of rawFindingIds) {
    const raw = rawFindingsById.get(rawFindingId);
    // A referenced raw whose body is not in the ledger (should not happen for
    // reconciler-produced ledgers) still has to contribute deterministically;
    // fall back to the id.
    rawContents.add(raw !== undefined ? rawEvidenceContent(raw) : `missing:${rawFindingId}`);
  }

  const payload = JSON.stringify({
    conflictDescription: normalizeFindingText(conflict.description),
    rawFindings: [...rawContents].sort(),
    disputes: [...disputeTexts].sort(),
  });
  return createHash('sha256').update(payload).digest('hex');
}

function rawEvidenceContent(raw: RawFinding): string {
  return JSON.stringify([
    normalizeFindingText(raw.title),
    normalizeFindingText(raw.description),
    raw.location !== undefined ? normalizeFindingText(raw.location) : '',
    raw.severity,
    raw.suggestion !== undefined ? normalizeFindingText(raw.suggestion) : '',
  ]);
}

/**
 * A conflict is eligible for finding-conflict-adjudication only when the
 * current evidence hash has NEVER been seen before — neither in a completed
 * adjudication record nor in a started attempt (codex B3: comparing only the
 * latest record allowed re-adjudication when the evidence reverted to a past
 * state, and ignoring started attempts allowed an interrupted run to
 * re-adjudicate the same evidence after resume). Only genuinely new evidence
 * (content change) re-opens eligibility.
 */
export function isConflictUnadjudicated(
  conflict: Pick<FindingLedgerConflict, 'adjudications' | 'adjudicationAttempts'>,
  currentEvidenceHash: string,
): boolean {
  const seen = (conflict.adjudications ?? []).some((record) => record.evidenceHash === currentEvidenceHash)
    || (conflict.adjudicationAttempts ?? []).some((attempt) => attempt.evidenceHash === currentEvidenceHash);
  return !seen;
}

/** Convenience: eligibility over a full ledger snapshot (rule context and the adjudication runner share this predicate). */
export function isLedgerConflictUnadjudicated(
  conflict: FindingLedgerConflict,
  ledger: Pick<FindingLedger, 'findings' | 'rawFindings'>,
): boolean {
  return isConflictUnadjudicated(conflict, computeConflictEvidenceHash(conflict, ledger));
}

/**
 * A PENDING attempt (its evidenceHash has no completed adjudication record)
 * started by the SAME run. Such an attempt is a reusable reservation (codex
 * R2): a rate-limit fallback re-execution of the adjudication step within the
 * same run may retry the LLM call against it instead of being blocked as
 * "already adjudicated". A pending attempt from a DIFFERENT runId (an
 * interrupted run that was resumed) stays blocking — that is the intended
 * safe-side escalation to ABORT. A completed adjudication blocks regardless of
 * runId.
 */
export function findReusablePendingAttempt(
  conflict: Pick<FindingLedgerConflict, 'adjudications' | 'adjudicationAttempts'>,
  currentEvidenceHash: string,
  runId: string,
): FindingConflictAdjudicationAttempt | undefined {
  const completed = (conflict.adjudications ?? []).some((record) => record.evidenceHash === currentEvidenceHash);
  if (completed) {
    return undefined;
  }
  return (conflict.adjudicationAttempts ?? []).find((attempt) => (
    attempt.evidenceHash === currentEvidenceHash && attempt.startedAt.runId === runId
  ));
}
