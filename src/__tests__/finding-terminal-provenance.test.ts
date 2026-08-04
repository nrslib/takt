import { describe, expect, it } from 'vitest';
import { findingContentAddress } from '../core/models/finding-contract-identity.js';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import {
  computeFileQuoteEvidenceRecordId,
  createEngineProofRecord,
} from '../core/models/finding-evidence-record.js';
import { computeFindingLifecycleProjectionDigest } from '../core/models/finding-lifecycle-identity.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingManagerOutput,
  RawFinding,
} from '../core/workflow/findings/types.js';
import { applyFindingLifecycleCommands } from '../core/workflow/findings/lifecycle-transaction.js';
import { issueManagerLifecycleAuthority } from '../core/workflow/findings/manager-lifecycle-authority.js';
import { assembleAndApplyManagerLifecycleTransactions } from '../core/workflow/findings/manager-lifecycle-assembly.js';
import { captureFindingLifecycleHead } from '../core/workflow/findings/lifecycle-mutation.js';
import { buildTerminalAdjudicationCandidateSnapshot } from '../core/workflow/findings/terminal-adjudication-candidates.js';
import {
  canonicalRawFindingFixture,
  rawCanonicalSnapshotFixture,
} from './helpers/finding-lifecycle-fixture.js';

const OBSERVATION = {
  runId: 'run-terminal-provenance',
  stepName: 'reviewers',
  timestamp: '2026-08-02T21:39:18.247Z',
};

const NEXT_OBSERVATION = {
  ...OBSERVATION,
  timestamp: '2026-08-02T21:40:18.247Z',
};

const RAW = canonicalRawFindingFixture({
  rawFindingId: 'run-terminal-provenance:reviewers:1:robustness-review:item-a50bebae',
  stepName: 'robustness-review',
  reviewer: 'robustness-review',
  familyTag: null,
  severity: null,
  title: null,
  description: 'Review-scope claim without reviewer-authored evidence.',
  suggestion: null,
  relation: 'new',
  targetFindingId: null,
  target: { kind: 'review_scope' },
  evidence: [],
});

const STABLE_KEY = findingContentAddress('test-provisional-stable-key', {
  rawFindingId: RAW.rawFindingId,
});
const LINEAGE_KEY = findingContentAddress('test-provisional-lineage-key', {
  rawFindingId: RAW.rawFindingId,
});

function provisional(): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    target: RAW.target,
    targetIdentityHash: RAW.targetIdentityHash,
    claimIdentityHash: RAW.claimIdentityHash,
    semanticClaimIdentityHash: RAW.semanticClaimIdentityHash,
    severity: RAW.severity,
    title: RAW.title,
    description: RAW.description ?? undefined,
    evidenceIds: [],
    reviewers: [RAW.reviewer],
    rawFindingIds: [RAW.rawFindingId],
    firstSeen: OBSERVATION,
    lastSeen: OBSERVATION,
    revision: 1,
    provisional: {
      kind: 'raw-adjudication-unresolved',
      stableKey: STABLE_KEY,
      lineageKey: LINEAGE_KEY,
      sourceRawFindingIds: [RAW.rawFindingId],
      reason: 'Engine proof failed deterministic admission.',
      firstObservedAt: OBSERVATION,
      lastObservedAt: OBSERVATION,
      gateEffect: 'block',
      firstObservedRound: 1,
      recoveryReviewerStableKey: findingContentAddress('test-reviewer-stable-key', {
        reviewer: RAW.reviewer,
      }),
    },
  };
}

function ledger(): FindingLedger {
  const snapshot = rawCanonicalSnapshotFixture(RAW, OBSERVATION);
  return {
    workflowName: 'peer-review',
    nextId: 1,
    updatedAt: OBSERVATION.timestamp,
    findings: [],
    evidenceRecords: [],
    rawFindings: [RAW],
    conflicts: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    ...createEmptyFindingContractRegistries(),
    rawCanonicalSnapshots: [snapshot],
  };
}

function isolationProof(input: {
  finding: FindingLedgerEntry;
  targetFindingId: string | null;
  subjectFindingId?: string;
  expectedHeadDigest?: string;
}) {
  return createEngineProofRecord({
    kind: 'engine_proof',
    purpose: 'lifecycle_authority',
    verifierId: 'takt.finding-lifecycle-policy',
    verifierVersion: '1',
    workflowName: 'peer-review',
    runId: OBSERVATION.runId,
    scopeIdentity: 'finding-storage:test:root',
    snapshotId: findingContentAddress('test-review-scope-snapshot', {}),
    claimIdentityHash: input.finding.claimIdentityHash,
    targetFindingId: input.targetFindingId,
    subject: {
      kind: 'finding_provisional_isolation',
      findingId: input.subjectFindingId ?? input.finding.id,
      provisionalKind: input.finding.provisional!.kind,
      stableKey: input.finding.provisional!.stableKey,
      claimBindingAuthorizationReferences: [],
    },
    dependencyDigests: [input.expectedHeadDigest ?? findingContentAddress(
      'test-absent-lifecycle-head',
      { findingId: input.finding.id },
    )],
    resultDigest: findingContentAddress('test-provisional-isolation', {
      findingId: input.finding.id,
      sourceRawFindingIds: input.finding.provisional!.sourceRawFindingIds,
    }),
    issuedAt: NEXT_OBSERVATION.timestamp,
  });
}

function withoutRevision(
  finding: FindingLedgerEntry,
): Omit<FindingLedgerEntry, 'revision'> {
  const { revision: _revision, ...change } = finding;
  void _revision;
  return change;
}

function applyProvisionalUpdate(input: {
  ledger: FindingLedger;
  finding: FindingLedgerEntry;
  proofId: string;
  sourceRawFindingIds: readonly string[];
}): FindingLedger {
  return applyFindingLifecycleCommands({
    ledger: input.ledger,
    commands: [{
      operation: 'update_provisional',
      changes: {
        findings: [{
          ...withoutRevision(input.finding),
          evidenceIds: [...new Set([...input.finding.evidenceIds, input.proofId])].sort(),
        }],
        conflicts: [],
      },
      authority: { kind: 'verified_evidence' },
      evidenceSourcesByTarget: new Map([[
        `finding\0${input.finding.id}`,
        {
          sourceRawFindingIds: input.sourceRawFindingIds,
          authorityEvidenceIds: [input.proofId],
        },
      ]]),
    }],
    occurredAt: NEXT_OBSERVATION,
  });
}

function initialLanding(): FindingLedger {
  const finding = provisional();
  const proof = isolationProof({ finding, targetFindingId: null });
  return applyProvisionalUpdate({
    ledger: { ...ledger(), evidenceRecords: [proof] },
    finding,
    proofId: proof.evidenceId,
    sourceRawFindingIds: [RAW.rawFindingId],
  });
}

function sameClaimRaw(rawFindingId: string): RawFinding {
  return canonicalRawFindingFixture({
    ...RAW,
    rawFindingId,
    evidence: [],
  });
}

function withRawFinding(base: FindingLedger, raw: RawFinding): FindingLedger {
  return {
    ...base,
    rawFindings: [...base.rawFindings, raw],
    rawCanonicalSnapshots: [
      ...base.rawCanonicalSnapshots,
      rawCanonicalSnapshotFixture(raw, NEXT_OBSERVATION),
    ],
  };
}

function emptyManagerOutput(): FindingManagerOutput {
  return {
    anchorAdjudications: [],
    matches: [],
    newFindings: [],
    resolvedFindings: [],
    reopenedFindings: [],
    conflicts: [],
    resolvedConflicts: [],
    waivedFindings: [],
    disputeNotes: [],
    invalidatedFindings: [],
    duplicateFindings: [],
    dismissedFindings: [],
  };
}

describe('terminal candidate provenance', () => {
  it('binds an evidence-less manager provisional raw to its landing event', () => {
    const applied = initialLanding();
    const proof = applied.evidenceRecords[0]!;

    const landingEvent = applied.lifecycleEvents[0]!;
    expect(applied.evidenceBindings).toContainEqual(expect.objectContaining({
      evidenceId: proof.evidenceId,
      sourceRawFindingId: RAW.rawFindingId,
    }));
    const candidate = buildTerminalAdjudicationCandidateSnapshot({
      ledger: applied,
      finding: applied.findings[0]!,
      currentRound: 2,
    });
    expect(candidate?.sourceClaims[0]?.provenanceEventId).toBe(landingEvent.eventId);
  });

  it('binds an evidence-less null-target raw when updating an existing provisional', () => {
    const current = initialLanding();
    const raw = sameClaimRaw('run-terminal-provenance:reviewers:2:robustness-review:item-repeat');
    const withRaw = withRawFinding(current, raw);
    const before = withRaw.findings[0]!;
    const after: FindingLedgerEntry = {
      ...before,
      rawFindingIds: [...before.rawFindingIds, raw.rawFindingId].sort(),
      lastSeen: NEXT_OBSERVATION,
      revision: before.revision + 1,
      provisional: {
        ...before.provisional!,
        sourceRawFindingIds: [
          ...before.provisional!.sourceRawFindingIds,
          raw.rawFindingId,
        ].sort(),
        lastObservedAt: NEXT_OBSERVATION,
      },
    };
    const expectedHead = captureFindingLifecycleHead(withRaw, 'finding', before.id)!;
    const proof = isolationProof({
      finding: after,
      targetFindingId: before.id,
      expectedHeadDigest: expectedHead.projectionDigest,
    });
    const applied = applyProvisionalUpdate({
      ledger: { ...withRaw, evidenceRecords: [...withRaw.evidenceRecords, proof] },
      finding: after,
      proofId: proof.evidenceId,
      sourceRawFindingIds: [raw.rawFindingId],
    });

    expect(applied.evidenceBindings).toContainEqual(expect.objectContaining({
      evidenceId: proof.evidenceId,
      sourceRawFindingId: raw.rawFindingId,
      target: expect.objectContaining({
        entityId: before.id,
        expectedHead: expect.objectContaining({ revision: before.revision }),
      }),
    }));
  });

  it('rejects a command source raw outside the after provisional projection', () => {
    const current = initialLanding();
    const otherRaw = sameClaimRaw('run-terminal-provenance:reviewers:2:robustness-review:item-other');
    const withOtherRaw = withRawFinding(current, otherRaw);
    const before = withOtherRaw.findings[0]!;
    const after: FindingLedgerEntry = {
      ...before,
      lastSeen: NEXT_OBSERVATION,
      revision: before.revision + 1,
      provisional: {
        ...before.provisional!,
        reason: 'The repeated observation remains isolated.',
        lastObservedAt: NEXT_OBSERVATION,
      },
    };
    const expectedHead = captureFindingLifecycleHead(withOtherRaw, 'finding', before.id)!;
    const proof = isolationProof({
      finding: after,
      targetFindingId: before.id,
      expectedHeadDigest: expectedHead.projectionDigest,
    });

    expect(() => applyProvisionalUpdate({
      ledger: {
        ...withOtherRaw,
        evidenceRecords: [...withOtherRaw.evidenceRecords, proof],
      },
      finding: after,
      proofId: proof.evidenceId,
      sourceRawFindingIds: [otherRaw.rawFindingId],
    })).toThrow(/outside its provisional projection/);
  });

  it('rejects an isolation proof issued for a stale provisional head', () => {
    const current = initialLanding();
    const firstRaw = sameClaimRaw('run-terminal-provenance:reviewers:2:robustness-review:item-first-update');
    const withFirstRaw = withRawFinding(current, firstRaw);
    const beforeFirst = withFirstRaw.findings[0]!;
    const afterFirst: FindingLedgerEntry = {
      ...beforeFirst,
      rawFindingIds: [...beforeFirst.rawFindingIds, firstRaw.rawFindingId].sort(),
      revision: beforeFirst.revision + 1,
      provisional: {
        ...beforeFirst.provisional!,
        sourceRawFindingIds: [
          ...beforeFirst.provisional!.sourceRawFindingIds,
          firstRaw.rawFindingId,
        ].sort(),
      },
    };
    const firstHead = captureFindingLifecycleHead(withFirstRaw, 'finding', beforeFirst.id)!;
    const staleProof = isolationProof({
      finding: afterFirst,
      targetFindingId: beforeFirst.id,
      expectedHeadDigest: firstHead.projectionDigest,
    });
    const firstUpdate = applyProvisionalUpdate({
      ledger: {
        ...withFirstRaw,
        evidenceRecords: [...withFirstRaw.evidenceRecords, staleProof],
      },
      finding: afterFirst,
      proofId: staleProof.evidenceId,
      sourceRawFindingIds: [firstRaw.rawFindingId],
    });
    const beforeSecond = firstUpdate.findings[0]!;
    const afterSecond: FindingLedgerEntry = {
      ...beforeSecond,
      revision: beforeSecond.revision + 1,
      provisional: {
        ...beforeSecond.provisional!,
        reason: 'The existing provisional remains isolated.',
      },
    };

    expect(() => applyProvisionalUpdate({
      ledger: firstUpdate,
      finding: afterSecond,
      proofId: staleProof.evidenceId,
      sourceRawFindingIds: [],
    })).toThrow(/Provisional isolation proof .* has a stale expected head/);
  });

  it('rejects another provisional proof for an existing provisional update', () => {
    const current = initialLanding();
    const before = current.findings[0]!;
    const after: FindingLedgerEntry = {
      ...before,
      revision: before.revision + 1,
      provisional: {
        ...before.provisional!,
        reason: 'The existing provisional remains isolated.',
      },
    };
    const expectedHead = captureFindingLifecycleHead(current, 'finding', before.id)!;
    const proof = isolationProof({
      finding: after,
      targetFindingId: after.id,
      subjectFindingId: 'F-0002',
      expectedHeadDigest: expectedHead.projectionDigest,
    });

    expect(() => applyProvisionalUpdate({
      ledger: { ...current, evidenceRecords: [...current.evidenceRecords, proof] },
      finding: after,
      proofId: proof.evidenceId,
      sourceRawFindingIds: [],
    })).toThrow(/subject "finding_provisional_isolation" is not eligible/);
  });

  it('binds an existing provisional raw through manager proof issuance and assembly', () => {
    const current = initialLanding();
    const raw = sameClaimRaw('run-terminal-provenance:reviewers:2:robustness-review:item-production');
    const proposedBase = withRawFinding(current, raw);
    const before = current.findings[0]!;
    const after: FindingLedgerEntry = {
      ...before,
      rawFindingIds: [...before.rawFindingIds, raw.rawFindingId].sort(),
      lastSeen: NEXT_OBSERVATION,
      revision: before.revision + 1,
      provisional: {
        ...before.provisional!,
        sourceRawFindingIds: [
          ...before.provisional!.sourceRawFindingIds,
          raw.rawFindingId,
        ].sort(),
        lastObservedAt: NEXT_OBSERVATION,
      },
    };
    const command = {
      operation: 'update_provisional' as const,
      changes: { findings: [withoutRevision(after)], conflicts: [] },
      authority: { kind: 'verified_evidence' as const },
      evidenceSourcesByTarget: new Map([[
        `finding\0${before.id}`,
        { sourceRawFindingIds: [raw.rawFindingId], authorityEvidenceIds: [] },
      ]]),
    };
    const managerDecisionProposed = { ...proposedBase, findings: [after] };
    const managerOutput = emptyManagerOutput();
    const proofed = issueManagerLifecycleAuthority({
      current,
      managerDecisionProposed,
      proposed: managerDecisionProposed,
      managerDecisionCommands: [command],
      settlementCommands: [],
      managerOutput,
      cwd: process.cwd(),
      workflowName: current.workflowName,
      runId: OBSERVATION.runId,
      scopeIdentity: 'finding-storage:test:production',
      reviewScopeSnapshotId: findingContentAddress('test-production-snapshot', {}),
      observation: NEXT_OBSERVATION,
    });
    const applied = assembleAndApplyManagerLifecycleTransactions({
      current,
      managerDecisionProposed,
      managerDecisionCommands: [command],
      proposed: proofed.ledger,
      managerOutput,
      provisionalProofIdsByFinding: proofed.provisionalProofIdsByFinding,
      invalidationProofIdsByFinding: proofed.invalidationProofIdsByFinding,
      duplicateProofIdsByCommandKey: proofed.duplicateProofIdsByCommandKey,
      managerDecisionProvisionalTransitionProofIdsByCommandKey:
        proofed.managerDecisionProvisionalTransitionProofIdsByCommandKey,
      provisionalTransitionProofIdsByCommandKey:
        proofed.provisionalTransitionProofIdsByCommandKey,
      invalidationReasonsByFinding: proofed.invalidationReasonsByFinding,
      resolutionRenotifications: [],
      settlementCommands: [],
      actionRecoveryPlan: null,
      occurredAt: NEXT_OBSERVATION,
    });
    const proofId = proofed.provisionalProofIdsByFinding.get(before.id)?.[0];

    expect(proofId).toBeDefined();
    expect(applied.evidenceBindings).toContainEqual(expect.objectContaining({
      evidenceId: proofId,
      sourceRawFindingId: raw.rawFindingId,
    }));
  });

  it('issues provisional isolation authority from the head after an earlier clean match', () => {
    const current = initialLanding();
    const before = current.findings[0]!;
    const cleanRaw = canonicalRawFindingFixture({
      ...RAW,
      rawFindingId: 'run-terminal-provenance:reviewers:2:robustness-review:item-clean-match',
      relation: 'persists',
      targetFindingId: before.id,
      evidence: [{
        kind: 'file_quote',
        path: 'src/example.ts',
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: RAW.description!,
        snapshotId: findingContentAddress('test-clean-match-snapshot', {}),
      }],
    });
    const quote = cleanRaw.evidence[0]!;
    if (quote.kind !== 'file_quote') {
      throw new Error('Expected a file quote fixture');
    }
    const cleanEvidencePayload = {
      ...quote,
      claimIdentityHash: cleanRaw.claimIdentityHash,
      fileHash: findingContentAddress('test-clean-match-file', {}),
    };
    const cleanEvidence = {
      evidenceId: computeFileQuoteEvidenceRecordId(cleanEvidencePayload),
      ...cleanEvidencePayload,
    };
    const provisionalRaw = sameClaimRaw(
      'run-terminal-provenance:reviewers:2:robustness-review:item-compound-provisional',
    );
    const proposedBase = {
      ...withRawFinding(withRawFinding(current, cleanRaw), provisionalRaw),
      evidenceRecords: [...current.evidenceRecords, cleanEvidence],
    };
    const afterPersist: FindingLedgerEntry = {
      ...before,
      lifecycle: 'persists',
      rawFindingIds: [...before.rawFindingIds, cleanRaw.rawFindingId].sort(),
      evidenceIds: [...before.evidenceIds, cleanEvidence.evidenceId].sort(),
      lastSeen: NEXT_OBSERVATION,
      revision: before.revision + 1,
    };
    const afterUpdate: FindingLedgerEntry = {
      ...afterPersist,
      rawFindingIds: [...afterPersist.rawFindingIds, provisionalRaw.rawFindingId].sort(),
      revision: afterPersist.revision + 1,
      provisional: {
        ...afterPersist.provisional!,
        sourceRawFindingIds: [
          ...afterPersist.provisional!.sourceRawFindingIds,
          provisionalRaw.rawFindingId,
        ].sort(),
        lastObservedAt: NEXT_OBSERVATION,
      },
    };
    const persistCommand = {
      operation: 'persist_finding' as const,
      changes: { findings: [withoutRevision(afterPersist)], conflicts: [] },
      authority: { kind: 'verified_evidence' as const },
      evidenceSourcesByTarget: new Map([[
        `finding\0${before.id}`,
        { sourceRawFindingIds: [cleanRaw.rawFindingId], authorityEvidenceIds: [] },
      ]]),
    };
    const updateCommand = {
      operation: 'update_provisional' as const,
      changes: { findings: [withoutRevision(afterUpdate)], conflicts: [] },
      authority: { kind: 'verified_evidence' as const },
      evidenceSourcesByTarget: new Map([[
        `finding\0${before.id}`,
        { sourceRawFindingIds: [provisionalRaw.rawFindingId], authorityEvidenceIds: [] },
      ]]),
    };
    const managerDecisionProposed = { ...proposedBase, findings: [afterUpdate] };
    const managerOutput = {
      ...emptyManagerOutput(),
      matches: [{ findingId: before.id, rawFindingIds: [cleanRaw.rawFindingId] }],
    };
    const proofed = issueManagerLifecycleAuthority({
      current,
      managerDecisionProposed,
      proposed: managerDecisionProposed,
      managerDecisionCommands: [persistCommand, updateCommand],
      settlementCommands: [],
      managerOutput,
      cwd: process.cwd(),
      workflowName: current.workflowName,
      runId: OBSERVATION.runId,
      scopeIdentity: 'finding-storage:test:compound-production',
      reviewScopeSnapshotId: findingContentAddress('test-compound-production-snapshot', {}),
      observation: NEXT_OBSERVATION,
    });
    const proofId = proofed.provisionalProofIdsByFinding.get(before.id)?.[0];
    const proof = proofed.ledger.evidenceRecords.find(
      (record) => record.evidenceId === proofId,
    );

    expect(proof).toEqual(expect.objectContaining({
      kind: 'engine_proof',
      dependencyDigests: [computeFindingLifecycleProjectionDigest(afterPersist)],
    }));
    expect(proof?.dependencyDigests).not.toContain(
      captureFindingLifecycleHead(current, 'finding', before.id)!.projectionDigest,
    );

    const applied = assembleAndApplyManagerLifecycleTransactions({
      current,
      managerDecisionProposed,
      managerDecisionCommands: [persistCommand, updateCommand],
      proposed: proofed.ledger,
      managerOutput,
      provisionalProofIdsByFinding: proofed.provisionalProofIdsByFinding,
      invalidationProofIdsByFinding: proofed.invalidationProofIdsByFinding,
      duplicateProofIdsByCommandKey: proofed.duplicateProofIdsByCommandKey,
      managerDecisionProvisionalTransitionProofIdsByCommandKey:
        proofed.managerDecisionProvisionalTransitionProofIdsByCommandKey,
      provisionalTransitionProofIdsByCommandKey:
        proofed.provisionalTransitionProofIdsByCommandKey,
      invalidationReasonsByFinding: proofed.invalidationReasonsByFinding,
      resolutionRenotifications: [],
      settlementCommands: [],
      actionRecoveryPlan: null,
      occurredAt: NEXT_OBSERVATION,
    });

    expect(applied.lifecycleEvents.slice(-2).map((event) => event.operation))
      .toEqual(['persist_finding', 'update_provisional']);
    expect(applied.evidenceBindings).toContainEqual(expect.objectContaining({
      evidenceId: proofId,
      sourceRawFindingId: provisionalRaw.rawFindingId,
      target: expect.objectContaining({
        expectedHead: expect.objectContaining({ revision: afterPersist.revision }),
      }),
    }));
  });
});
