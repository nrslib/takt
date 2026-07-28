import type {
  FindingConflictAdjudicationOutcome,
  FindingConflictAdjudicationOutput,
  FindingConflictAdjudicationTransition,
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
  FindingReconcileContext,
} from './types.js';

/**
 * outcome -> finding-side transition is a fixed, engine-owned mapping.
 *
 * finding_valid always keeps the FINDING open (the reviewer's finding is
 * legitimate either way); what varies with actionableFix is the CONFLICT's
 * fate and the workflow routing (FindingConflictAdjudicationDisposition below),
 * so the finding-side effect remains a pure function of outcome.
 */
export const FINDING_CONFLICT_ADJUDICATION_OUTCOME_TRANSITION: Readonly<
  Record<FindingConflictAdjudicationOutcome, FindingConflictAdjudicationTransition>
> = {
  finding_valid: 'keep_open',
  finding_stale: 'resolved',
  evidence_invalid: 'invalidated',
  undetermined: 'keep_open',
};

/**
 * Engine-facing routing summary of an applied adjudication:
 *
 * - 'finding_closed'  — finding_stale / evidence_invalid: the finding moved off
 *   open and the conflict is resolved. Route back to the originating step so it
 *   re-evaluates against the updated ledger.
 * - 'actionable_fix'  — finding_valid with a non-empty actionableFix: the
 *   adjudicator sided with the reviewer AND stated a concrete coder fix. The
 *   conflict is resolved (its adjudication record + resolvedEvidence say "in
 *   favor of the reviewer"), the finding stays open, and the workflow routes to
 *   the fix path.
 * - 'unresolved'      — undetermined, or finding_valid WITHOUT an actionable
 *   fix: a "valid" verdict that names no concrete fix demonstrates no
 *   fixability and is treated exactly like undetermined. Conflict stays
 *   active; the gate stays shut and the workflow falls through to ABORT.
 */
export type FindingConflictAdjudicationDisposition = 'finding_closed' | 'actionable_fix' | 'unresolved';

export function resolveAdjudicationDisposition(
  output: Pick<FindingConflictAdjudicationOutput, 'outcome' | 'actionableFix'>,
): FindingConflictAdjudicationDisposition {
  if (output.outcome === 'finding_stale' || output.outcome === 'evidence_invalid') {
    return 'finding_closed';
  }
  if (output.outcome === 'finding_valid' && (output.actionableFix?.trim().length ?? 0) > 0) {
    return 'actionable_fix';
  }
  return 'unresolved';
}

export interface ApplyFindingConflictAdjudicationInput {
  ledger: FindingLedger;
  output: FindingConflictAdjudicationOutput;
  evidenceHash: string;
  /** Working directory the reviewed code lives in (see admission-validation.ts). */
  cwd: string;
  context: FindingReconcileContext;
}

export interface ApplyFindingConflictAdjudicationResult {
  ledger: FindingLedger;
  transition: FindingConflictAdjudicationTransition;
  disposition: FindingConflictAdjudicationDisposition;
}

function observationFromContext(context: FindingReconcileContext): FindingLedgerEntry['firstSeen'] {
  return { runId: context.runId, stepName: context.stepName, timestamp: context.timestamp };
}

function assertKnownConflict(
  conflictsById: ReadonlyMap<string, FindingLedgerConflict>,
  conflictId: string,
): FindingLedgerConflict {
  const conflict = conflictsById.get(conflictId);
  if (conflict === undefined) {
    throw new Error(`Unknown conflict id "${conflictId}"`);
  }
  return conflict;
}

/**
 * The fix step reads open findings from the ledger summary (suggestion is
 * included in both renderFindingLedgerInstructionSummary and
 * FindingsRuleContext.open.items), so appending the adjudicator's actionableFix
 * to the finding's suggestion is the channel that reaches the coder without any
 * new plumbing.
 */
function appendActionableFixToSuggestion(existing: string | undefined, actionableFix: string): string {
  const annotated = `[adjudicated fix] ${actionableFix.trim()}`;
  return existing !== undefined && existing.trim().length > 0 ? `${existing}\n${annotated}` : annotated;
}

/**
 * Applies one finding-conflict-adjudication decision to the ledger. Pure
 * function over its inputs. The adjudicator's free text is annotation only;
 * the lifecycle authority is the typed, pre-reserved conflict evidence binding.
 */
export function applyFindingConflictAdjudication(
  input: ApplyFindingConflictAdjudicationInput,
): ApplyFindingConflictAdjudicationResult {
  const { ledger, output, evidenceHash, context } = input;
  const conflictsById = new Map(ledger.conflicts.map((conflict) => [conflict.id, conflict]));
  const conflict = assertKnownConflict(conflictsById, output.conflictId);
  if (conflict.status !== 'active') {
    throw new Error(`Cannot adjudicate conflict "${conflict.id}" because it is not active`);
  }

  const expectedTransition = FINDING_CONFLICT_ADJUDICATION_OUTCOME_TRANSITION[output.outcome];
  const disposition = resolveAdjudicationDisposition(output);

  const decidedAt = context.timestamp;
  const observation = observationFromContext(context);

  let updatedFindings = ledger.findings;
  if (expectedTransition === 'resolved') {
    updatedFindings = ledger.findings.map((finding) => {
      if (!conflict.findingIds.includes(finding.id) || finding.status !== 'open') {
        return finding;
      }
      return {
        ...finding,
        status: 'resolved',
        lifecycle: 'resolved',
        resolvedAt: decidedAt,
        resolvedEvidence: `Conflict adjudication ${conflict.id}@${evidenceHash}: finding_stale`,
        revision: finding.revision + 1,
      };
    });
  } else if (expectedTransition === 'invalidated') {
    updatedFindings = ledger.findings.map((finding) => {
      if (!conflict.findingIds.includes(finding.id) || finding.status !== 'open') {
        return finding;
      }
      return {
        ...finding,
        status: 'invalidated',
        lifecycle: 'invalidated',
        invalidatedAt: decidedAt,
        invalidatedEvidence: `Conflict adjudication ${conflict.id}@${evidenceHash}: evidence_invalid`,
        revision: finding.revision + 1,
      };
    });
  } else if (disposition === 'actionable_fix') {
    // finding_valid with an actionable fix: the finding stays open (it is
    // real and must be fixed), and the actionableFix is appended to its
    // suggestion so the fix step's ledger summary carries it to the coder.
    updatedFindings = ledger.findings.map((finding) => {
      if (!conflict.findingIds.includes(finding.id) || finding.status !== 'open') {
        return finding;
      }
      return {
        ...finding,
        suggestion: appendActionableFixToSuggestion(finding.suggestion, output.actionableFix ?? ''),
        lastSeen: observation,
        revision: finding.revision + 1,
      };
    });
  }
  const adjudicationRecord = {
    evidenceHash,
    outcome: output.outcome,
    ...(output.actionableFix !== undefined ? { actionableFix: output.actionableFix } : {}),
    ...(output.rationale !== undefined ? { rationale: output.rationale } : {}),
    decidedAt: observation,
  };

  const updatedConflicts = ledger.conflicts.map((candidate) => {
    if (candidate.id !== conflict.id) {
      return candidate;
    }
    const withRecord: FindingLedgerConflict = {
      ...candidate,
      adjudications: [...(candidate.adjudications ?? []), adjudicationRecord],
      revision: candidate.revision + 1,
    };
    if (disposition === 'unresolved') {
      // Conflict stays active — it is adjudicated for this evidenceHash, but
      // unresolved, so FindingsRuleContext.conflicts.unadjudicated will no
      // longer count it (routes to ABORT next round instead of back here).
      return withRecord;
    }
    const resolved: FindingLedgerConflict = {
      ...withRecord,
      status: 'resolved',
      resolvedAt: decidedAt,
      resolvedEvidence: `Conflict adjudication ${candidate.id}@${evidenceHash}: ${output.outcome}`,
    };
    return resolved;
  });

  return {
    ledger: {
      ...ledger,
      findings: updatedFindings,
      conflicts: updatedConflicts,
      updatedAt: decidedAt,
    },
    transition: expectedTransition,
    disposition,
  };
}

/** Picks the target conflict for the next adjudication call: the first active conflict (ledger order) whose current evidence has never been adjudicated (see adjudication-evidence.ts). Returns undefined when there is nothing left to adjudicate this round. */
export function selectConflictForAdjudication(
  ledger: FindingLedger,
  isUnadjudicated: (conflict: FindingLedgerConflict) => boolean,
): FindingLedgerConflict | undefined {
  return ledger.conflicts.find((conflict) => conflict.status === 'active' && isUnadjudicated(conflict));
}
