import { formatConflictId } from '../../core/models/finding-conflict-identity.js';
import { createAnchorAdjudication } from '../../core/models/finding-anchor-relevance.js';
import type { CanonicalIntakeItem } from '../../core/workflow/findings/manager-admission.js';
import type {
  PreparedInterpretationCasePlan,
} from '../../core/workflow/findings/interpretation-case-finalizer.js';
import { stagePreparedInterpretationCaseOwnership } from '../../core/workflow/findings/interpretation-case-finalizer.js';
import { canonicalRawIntegrityDigestOf } from '../../core/workflow/findings/raw-canonicalization.js';
import { reconcileFindingLedgerPlan } from '../../core/workflow/findings/reconciler.js';
import type {
  FindingLedger,
  FindingManagerOutput,
} from '../../core/workflow/findings/types.js';
import { applyFindingLedgerFixtureRevision } from './finding-lifecycle-fixture.js';
import { OBSERVATION } from './finding-interpretation-case-store-fixture.js';

function reconcilePrepared(input: {
  ledger: FindingLedger;
  items: readonly CanonicalIntakeItem[];
  prepared: PreparedInterpretationCasePlan;
  managerOutput: FindingManagerOutput;
  provisionalFindings: PreparedInterpretationCasePlan['provisionalFindings'];
}): FindingLedger {
  const managerOutput: FindingManagerOutput = {
    ...input.managerOutput,
    anchorAdjudications: [
      ...input.managerOutput.matches.flatMap((match) => match.rawFindingIds.map(
        (rawFindingId) => createAnchorAdjudication({
          rawFindingId,
          decision: 'same',
          anchorRelevance: 'not_applicable',
          findingId: match.findingId,
          evidence: match.evidence ?? 'Interpretation case SameProof match.',
        }),
      )),
      ...input.managerOutput.newFindings.flatMap((finding) => finding.rawFindingIds.map(
        (rawFindingId) => createAnchorAdjudication({
          rawFindingId,
          decision: 'new',
          anchorRelevance: 'not_applicable',
          evidence: 'Interpretation case independent finding creation.',
        }),
      )),
    ],
  };
  const reconciled = reconcileFindingLedgerPlan({
    previousLedger: input.ledger,
    rawFindings: input.items.map((item) => item.wire),
    managerOutput,
    provisionalFindings: input.provisionalFindings,
    entityProvisionalMutations: [],
    terminalEntityAttachmentFindingIds: new Set(),
    rawProvenanceByRawFindingId: new Map(input.items.map((item) => [
      item.canonical.rawFindingId,
      {
        reviewerStableKey: item.canonical.reviewerStableKey,
        lineageKey: item.canonical.lineageKey,
        claimIdentityHash: item.canonical.claimIdentityHash,
        canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(item.canonical),
        canonicalProvenance: item.canonical.provenance,
      },
    ])),
    verifiedEvidenceRecordsByRawFindingId: new Map(),
    context: {
      workflowName: input.ledger.workflowName,
      stepName: OBSERVATION.stepName,
      runId: OBSERVATION.runId,
      timestamp: OBSERVATION.timestamp,
    },
  });
  let settled: FindingLedger = stagePreparedInterpretationCaseOwnership({
    ledger: {
    ...reconciled.ledger,
    findings: input.ledger.findings,
    conflicts: input.ledger.conflicts,
    evidenceBindings: input.ledger.evidenceBindings,
    lifecycleReservations: input.ledger.lifecycleReservations,
    lifecycleEvents: input.ledger.lifecycleEvents,
    interpretationRawObservations: input.ledger.interpretationRawObservations,
    },
    prepared: input.prepared,
    items: input.items,
    observation: OBSERVATION,
  });
  const itemsByRawFindingId = new Map(input.items.map((item) => [
    item.canonical.rawFindingId,
    item,
  ]));
  const caseIdByRawFindingId = new Map(input.prepared.cases.flatMap((preparedCase) => (
    preparedCase.rawFindingIds.map((rawFindingId) => [rawFindingId, preparedCase.caseId] as const)
  )));
  for (const command of reconciled.lifecycleCommands) {
    for (const projection of command.changes.findings) {
      const finding = reconciled.ledger.findings.find(({ id }) => id === projection.id);
      if (finding === undefined) {
        throw new Error(`Reconciled finding "${projection.id}" is missing`);
      }
      const sourceRawFindingIds = finding.rawFindingIds.filter(
        (rawFindingId) => itemsByRawFindingId.has(rawFindingId),
      );
      for (const sourceRawFindingId of sourceRawFindingIds.length === 0 ? [null] : sourceRawFindingIds) {
        const current = settled.findings.find(({ id }) => id === finding.id);
        const caseId = sourceRawFindingId === null
          ? undefined
          : caseIdByRawFindingId.get(sourceRawFindingId);
        settled = applyFindingLedgerFixtureRevision({
          ledger: settled,
          entityKind: 'finding',
          entity: {
            ...finding,
            lifecycle: current === undefined ? finding.lifecycle : 'persists',
            revision: current === undefined ? finding.revision : current.revision + 1,
            rawFindingIds: sourceRawFindingId === null
              ? finding.rawFindingIds
              : [
                  sourceRawFindingId,
                  ...finding.rawFindingIds.filter((rawFindingId) => rawFindingId !== sourceRawFindingId),
                ],
          },
          ...(caseId === undefined
            ? {}
            : { contributionOrigin: { kind: 'interpretation_case', caseId } }),
        });
      }
    }
    for (const projection of command.changes.conflicts) {
      const conflict = reconciled.ledger.conflicts.find(({ id }) => id === projection.id);
      if (conflict === undefined) {
        throw new Error(`Reconciled conflict "${projection.id}" is missing`);
      }
      const sourceRawFindingIds = conflict.rawFindingIds.filter(
        (rawFindingId) => itemsByRawFindingId.has(rawFindingId),
      );
      for (const sourceRawFindingId of sourceRawFindingIds.length === 0 ? [null] : sourceRawFindingIds) {
        const current = settled.conflicts.find(({ id }) => id === conflict.id);
        const caseId = sourceRawFindingId === null
          ? undefined
          : caseIdByRawFindingId.get(sourceRawFindingId);
        settled = applyFindingLedgerFixtureRevision({
          ledger: settled,
          entityKind: 'conflict',
          entity: {
            ...conflict,
            revision: current === undefined ? conflict.revision : current.revision + 1,
            rawFindingIds: sourceRawFindingId === null
              ? conflict.rawFindingIds
              : [
                  sourceRawFindingId,
                  ...conflict.rawFindingIds.filter((rawFindingId) => rawFindingId !== sourceRawFindingId),
                ],
          },
          ...(caseId === undefined
            ? {}
            : { contributionOrigin: { kind: 'interpretation_case', caseId } }),
        });
      }
    }
  }
  for (const created of input.managerOutput.newFindings) {
    const landed = settled.findings.filter((finding) => (
      created.rawFindingIds.every((rawFindingId) => finding.rawFindingIds.includes(rawFindingId))
    ));
    if (landed.length !== 1) {
      throw new Error(
        `Fixture did not land all new-finding members: expected ${created.rawFindingIds.join(', ')}, candidates ${settled.findings.map((finding) => `${finding.id}=[${finding.rawFindingIds.join(', ')}]`).join('; ')}`,
      );
    }
  }
  return settled;
}

export function settlePreparedInterpretationCases(input: {
  ledger: FindingLedger;
  items: readonly CanonicalIntakeItem[];
  prepared: PreparedInterpretationCasePlan;
}): FindingLedger {
  if (input.prepared.managerOutput.conflicts.length > 0) {
    throw new Error('Use settlePreparedConflictCase for conflict + holding provisional plans');
  }
  return reconcilePrepared({
    ledger: input.ledger,
    items: input.items,
    prepared: input.prepared,
    managerOutput: input.prepared.managerOutput,
    provisionalFindings: input.prepared.provisionalFindings,
  });
}

export function settlePreparedConflictCase(input: {
  ledger: FindingLedger;
  items: readonly CanonicalIntakeItem[];
  prepared: PreparedInterpretationCasePlan;
}): FindingLedger {
  const preparedCase = input.prepared.cases[0];
  if (
    input.prepared.cases.length !== 1
    || preparedCase?.action.kind !== 'open_product_conflict'
    || input.prepared.managerOutput.conflicts.length !== 1
    || input.prepared.provisionalFindings.length !== 1
  ) {
    throw new Error('Conflict settlement fixture requires one conflict + holding provisional case');
  }
  const withoutConflict = {
    ...input.prepared.managerOutput,
    conflicts: [],
  };
  const holding = reconcilePrepared({
    ledger: input.ledger,
    items: input.items,
    prepared: input.prepared,
    managerOutput: withoutConflict,
    provisionalFindings: input.prepared.provisionalFindings,
  });
  const conflict = preparedCase.action.conflict;
  const conflictId = formatConflictId(conflict);
  let ledger = holding;
  for (const rawFindingId of preparedCase.rawFindingIds) {
    const current = ledger.conflicts.find(({ id }) => id === conflictId);
    ledger = applyFindingLedgerFixtureRevision({
      ledger,
      entityKind: 'conflict',
      entity: {
        id: conflictId,
        status: 'active',
        findingIds: [...conflict.findingIds],
        rawFindingIds: [
          rawFindingId,
          ...conflict.rawFindingIds.filter((candidate) => candidate !== rawFindingId),
        ],
        description: conflict.description,
        firstSeen: { ...OBSERVATION },
        lastSeen: { ...OBSERVATION },
        revision: current === undefined ? 1 : current.revision + 1,
      },
      contributionOrigin: {
        kind: 'interpretation_case',
        caseId: preparedCase.caseId,
      },
    });
  }
  return ledger;
}
