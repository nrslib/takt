import type { ProvisionalFindingSpec } from './reconciler.js';
import { verifySameProofAgainstLedger } from './raw-capabilities.js';
import { createEmptyManagerOutput } from './manager-output.js';
import type {
  FindingLedger,
  FindingManagerOutput,
  InterpretationApplicationResult,
} from './types.js';
import type { ManagerDecisionStageResult } from './manager-contracts.js';
import { provisionalSpecForRaw } from './manager-provisional.js';
import { fullIdentityKeyOf } from './manager-provisional-settlement.js';

export interface LadderCommitPlan {
  output: FindingManagerOutput;
  provisionalSpecs: ProvisionalFindingSpec[];
  interpretationResults: Map<string, InterpretationApplicationResult>;
}

function withInterpretationResult(
  current: Map<string, InterpretationApplicationResult>,
  key: string | undefined,
  result: InterpretationApplicationResult,
): Map<string, InterpretationApplicationResult> {
  return key === undefined ? current : new Map([...current, [key, result]]);
}

export function buildLadderCommitPlan(
  ladder: ManagerDecisionStageResult['ladder'],
  freshLedger: FindingLedger,
): LadderCommitPlan {
  const initialResults = new Map<string, InterpretationApplicationResult>(
    [...ladder.provisionalByInterpretationKey].map(([key, spec]) => {
      const existsOpen = freshLedger.findings.some(
        (finding) => finding.status === 'open' && finding.provisional?.stableKey === spec.stableKey,
      );
      return [key, existsOpen ? 'provisional_updated' : 'provisional_created'];
    }),
  );
  const initial: LadderCommitPlan = {
    output: createEmptyManagerOutput(),
    provisionalSpecs: [],
    interpretationResults: initialResults,
  };
  const withMatches = ladder.pendingSameWithProof.reduce<LadderCommitPlan>((plan, pending) => {
    const verification = verifySameProofAgainstLedger(pending.proof, freshLedger);
    if (!verification.ok) {
      return {
        ...plan,
        provisionalSpecs: [...plan.provisionalSpecs, provisionalSpecForRaw({
          wire: pending.target.wire,
          canonical: pending.target.canonical,
          reason: `Deterministic same proof became stale before save: ${verification.reason}`,
        })],
        interpretationResults: withInterpretationResult(
          plan.interpretationResults,
          pending.viaInterpretationKey,
          'stale_precondition',
        ),
      };
    }
    return {
      ...plan,
      output: {
        ...plan.output,
        matches: [...plan.output.matches, {
          findingId: pending.proof.targetFindingId,
          rawFindingIds: [pending.target.wire.rawFindingId],
          evidence: `Deterministic same proof ${pending.proof.proofId.slice(0, 12)} (exact normalized identity match)`,
        }],
      },
      interpretationResults: withInterpretationResult(
        plan.interpretationResults,
        pending.viaInterpretationKey,
        'matched_with_proof',
      ),
    };
  }, initial);
  const withIndependent = ladder.pendingIndependentNew.reduce<LadderCommitPlan>((plan, pending) => ({
    ...plan,
    output: {
      ...plan.output,
      newFindings: [...plan.output.newFindings, {
        rawFindingIds: [pending.wire.rawFindingId],
        title: pending.wire.title,
        severity: pending.wire.severity,
      }],
    },
    interpretationResults: withInterpretationResult(
      plan.interpretationResults,
      pending.viaInterpretationKey,
      'created',
    ),
  }), withMatches);
  const withConflicts = ladder.pendingConflicts.reduce<LadderCommitPlan>((plan, pending) => {
    const target = freshLedger.findings.find((finding) => finding.id === pending.targetFindingId);
    if (target === undefined || target.status !== 'open') {
      return {
        ...plan,
        provisionalSpecs: [...plan.provisionalSpecs, provisionalSpecForRaw({
          wire: pending.target.wire,
          canonical: pending.target.canonical,
          reason: `Conflict target "${pending.targetFindingId}" is no longer open; observation kept provisional`,
        })],
        interpretationResults: withInterpretationResult(
          plan.interpretationResults,
          pending.viaInterpretationKey,
          'provisional_created',
        ),
      };
    }
    return {
      ...plan,
      output: {
        ...plan.output,
        conflicts: [...plan.output.conflicts, {
          findingIds: [pending.targetFindingId],
          rawFindingIds: [pending.target.wire.rawFindingId],
          description: `Ambiguous observation "${pending.target.wire.title}" relates to finding "${pending.targetFindingId}" but its identity could not be determined`,
        }],
      },
      provisionalSpecs: [...plan.provisionalSpecs, provisionalSpecForRaw({
        wire: pending.target.wire,
        canonical: pending.target.canonical,
        reason: `Held as provisional while an active conflict against finding "${pending.targetFindingId}" is adjudicated`,
      })],
      interpretationResults: withInterpretationResult(
        plan.interpretationResults,
        pending.viaInterpretationKey,
        'conflict_created',
      ),
    };
  }, withIndependent);
  const freshRawsById = new Map(freshLedger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  return ladder.pendingAppliedReattach.reduce<LadderCommitPlan>((plan, pending) => {
    const identity = fullIdentityKeyOf(
      pending.target.wire.location,
      pending.target.wire.title,
      pending.target.wire.description,
    );
    const candidates = freshLedger.findings.filter((finding) => {
      if (finding.status !== 'open') {
        return false;
      }
      if (fullIdentityKeyOf(finding.location, finding.title, finding.description) === identity) {
        return true;
      }
      return finding.rawFindingIds.some((rawFindingId) => {
        const raw = freshRawsById.get(rawFindingId);
        return raw !== undefined && fullIdentityKeyOf(raw.location, raw.title, raw.description) === identity;
      });
    });
    if (candidates.length !== 1) {
      return {
        ...plan,
        provisionalSpecs: [...plan.provisionalSpecs, provisionalSpecForRaw({
          wire: pending.target.wire,
          canonical: pending.target.canonical,
          reason: 'Same-evidence observation reappeared after its interpretation was applied, but its previously created finding could not be uniquely re-identified; kept provisional',
        })],
      };
    }
    return {
      ...plan,
      output: {
        ...plan.output,
        matches: [...plan.output.matches, {
          findingId: candidates[0]!.id,
          rawFindingIds: [pending.target.wire.rawFindingId],
          evidence: 'Same-evidence observation reattached to its previously applied finding (exact identity)',
        }],
      },
    };
  }, withConflicts);
}
