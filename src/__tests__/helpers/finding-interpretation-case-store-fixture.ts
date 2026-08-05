import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  beginInterpretationCases,
  completeInterpretationCases,
} from '../../core/workflow/findings/interpretation-case-coordinator.js';
import { dispatchFindingManagerProviderCall } from '../../core/workflow/findings/finding-manager-provider-call.js';
import { computeFileQuoteEvidenceId } from '../../core/workflow/findings/evidence-domain.js';
import type { CanonicalIntakeItem } from '../../core/workflow/findings/manager-admission.js';
import {
  canonicalizeReviewerRawFinding,
  createReviewerRawFindingCandidates,
  toLedgerRawFinding,
} from '../../core/workflow/findings/raw-canonicalization.js';
import type {
  FindingManagerProviderBudgetLimits,
  FindingLedger,
  FindingObservation,
  FindingEvidenceRecord,
  InterpretationBatchReceipt,
  InterpretationCase,
  InterpretationDecision,
} from '../../core/workflow/findings/types.js';
import {
  FindingStorageResolver,
  ROOT_FINDING_AUTHORITY_KEY,
} from '../../infra/finding-storage/index.js';
import { SqliteFindingLedgerStore } from '../../infra/finding-storage/store.js';
import {
  applyFindingLedgerFixtureRevision,
  authorizeFindingLedgerFixture,
  emptyFindingAuthorityProjection,
  reviewerRawExtractionFixture,
} from './finding-lifecycle-fixture.js';

export const OBSERVATION: FindingObservation = {
  runId: 'run-case-store',
  stepName: 'reviewers',
  timestamp: '2026-08-02T00:00:00.000Z',
};

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-interpretation-case-store-'));
  roots.push(root);
  return root;
}

export function cleanupInterpretationCaseRoots(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

export function baseLedger(input: {
  findingId?: string;
  title?: string;
  description?: string;
  status?: 'open' | 'resolved';
} = {}): FindingLedger {
  const status = input.status ?? 'open';
  const findingId = input.findingId ?? 'F-0001';
  return authorizeFindingLedgerFixture({
    workflowName: 'case-store',
    nextId: Number.parseInt(findingId.slice(2), 10) + 1,
    updatedAt: OBSERVATION.timestamp,
    findings: [{
      id: findingId,
      status,
      lifecycle: status === 'open' ? 'persists' : 'resolved',
      severity: 'high',
      title: input.title ?? 'Existing target',
      description: input.description ?? 'Existing target description',
      target: { kind: 'code', paths: ['src/shared.ts'] },
      evidenceIds: [],
      rawFindingIds: [],
      reviewers: ['reviewer'],
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
      revision: 2,
    }],
    rawFindings: [],
    conflicts: [],
    ...emptyFindingAuthorityProjection(),
  });
}

export function emptyLedger(): FindingLedger {
  return authorizeFindingLedgerFixture({
    workflowName: 'case-store',
    nextId: 1,
    updatedAt: OBSERVATION.timestamp,
    findings: [],
    rawFindings: [],
    conflicts: [],
    ...emptyFindingAuthorityProjection(),
  });
}

export function taintedItems(input: {
  rawFindingIds: readonly string[];
  ledger: FindingLedger;
  description?: string;
  relation?: 'new' | 'persists' | 'resolution_confirmation';
  targetFindingId?: string | null;
  evidenceLine?: number;
  familyTag?: string | null;
  clarificationAttempted?: boolean;
  reviewerPersonaKey?: string;
  evidenceSnapshotId?: string;
}): CanonicalIntakeItem[] {
  const relation = input.relation ?? 'persists';
  const targetFindingId = input.targetFindingId === undefined ? 'F-0001' : input.targetFindingId;
  const extractions = input.rawFindingIds.map((rawFindingId) => (
    reviewerRawExtractionFixture({
      rawFindingId,
      familyTag: input.familyTag === undefined ? 'architecture' : input.familyTag,
      severity: 'high',
      title: 'Shared semantic defect',
      description: input.description ?? 'The same defect remains observable.',
      suggestion: null,
      relation,
      targetFindingId,
      target: { kind: 'code', paths: ['src/shared.ts'] },
      evidenceRequests: [{
        kind: 'file_quote',
        path: 'src/shared.ts',
        startLine: input.evidenceLine ?? 1,
        endLine: input.evidenceLine ?? 1,
      }],
      rawExcerpt: `${rawFindingId}: shared semantic defect`,
    })
  ));
  const candidates = createReviewerRawFindingCandidates(extractions, {
    workflowName: input.ledger.workflowName,
    callNamespace: '',
    parentStepName: 'reviewers',
    stepIteration: 1,
    runId: OBSERVATION.runId,
    reviewerStepName: 'architecture-review',
    reviewerPersonaKey: input.reviewerPersonaKey ?? 'architecture-reviewer',
    ledger: input.ledger,
    reviewReport: extractions.map((item) => item.rawExcerpt).join('\n'),
    issueEvidenceRequests: ({ requests }) => ({
      evidence: requests.flatMap((request) => request.kind === 'file_quote'
        ? [{
            ...request,
            snapshotId: input.evidenceSnapshotId ?? '1'.repeat(64),
            verbatimExcerpt: `line ${request.startLine}`,
          }]
        : []),
      engineProofRecords: [],
      coverageGaps: [],
      materializedQuoteBytes: 0,
    }),
    commitEvidenceIssuance: () => {},
  }).candidates;
  return candidates.map((candidate) => {
    const { canonical } = canonicalizeReviewerRawFinding(candidate, {
      ledger: input.ledger,
      clarificationAttempted: input.clarificationAttempted ?? true,
      priorAmbiguityCodes: ['missing-required-field'],
    });
    return { canonical, wire: toLedgerRawFinding(canonical) };
  });
}

export interface Harness {
  root: string;
  resolver: FindingStorageResolver;
  store: SqliteFindingLedgerStore;
  beginInterpretationCases: (input: {
    items: CanonicalIntakeItem[];
    provisionalOnlyRawFindingIds: ReadonlySet<string>;
  }) => ReturnType<typeof beginInterpretationCases>;
  completeInterpretationCases: (input: {
    receipt: InterpretationBatchReceipt;
    responses: Array<{ caseId: string; decision: InterpretationDecision }>;
    providerFailures: Array<{ caseId: string; reason: string }>;
  }) => ReturnType<typeof completeInterpretationCases>;
}

export function verifiedEvidenceRecords(
  items: readonly CanonicalIntakeItem[],
): ReadonlyMap<string, readonly FindingEvidenceRecord[]> {
  return new Map(items.map((item) => [
    item.canonical.rawFindingId,
    [
      ...item.wire.evidence.flatMap((evidence): FindingEvidenceRecord[] => {
        if (evidence.kind !== 'file_quote') {
          return [];
        }
        const fileHash = createHash('sha256')
          .update(evidence.verbatimExcerpt, 'utf8')
          .digest('hex');
        return [{
          ...evidence,
          evidenceId: computeFileQuoteEvidenceId({
            claimIdentityHash: item.canonical.claimIdentityHash,
            path: evidence.path,
            startLine: evidence.startLine,
            endLine: evidence.endLine,
            verbatimExcerpt: evidence.verbatimExcerpt,
            snapshotId: evidence.snapshotId,
            fileHash,
          }),
          claimIdentityHash: item.canonical.claimIdentityHash,
          fileHash,
        }];
      }),
      ...item.canonical.issuedEngineProofRecords,
    ],
  ]));
}

export function openHarness(input: {
  root?: string;
  maxEpochsPerLineage?: number;
  budgetLimits?: FindingManagerProviderBudgetLimits;
  prepareProviderRequest?: (
    ledger: FindingLedger,
    cases: readonly Extract<InterpretationCase, { kind: 'provider_case' }>[],
  ) => {
    requestBytes: string;
    adapterSupportsUtf8ByteUpperBound: boolean;
  };
} = {}): Harness {
  const root = input.root ?? tempRoot();
  const resolver = new FindingStorageResolver({
    databasePath: join(root, 'finding-contract.sqlite'),
    runId: OBSERVATION.runId,
    now: () => OBSERVATION.timestamp,
  });
  const store = resolver.resolveAuthority({
    authorityKey: ROOT_FINDING_AUTHORITY_KEY,
    workflowName: 'case-store',
    reportDir: join(root, 'reports'),
  });
  if (!(store instanceof SqliteFindingLedgerStore)) {
    throw new Error('Expected SQLite finding store');
  }
  return {
    root,
    resolver,
    store,
    beginInterpretationCases: (request) => beginInterpretationCases({
      store,
      observation: OBSERVATION,
      maxEpochsPerLineage: input.maxEpochsPerLineage ?? 4,
      roundMarker: 'round-case-store',
      scopeIdentity: '2'.repeat(64),
      budgetLimits: input.budgetLimits ?? {
        maxCallsPerRound: 4,
        maxAdapterVisibleInputBytesPerCall: 100_000,
        maxOutputTokensPerCall: 10_000,
        maxChargedInputTokensPerRound: 400_000,
        maxChargedOutputTokensPerRound: 40_000,
      },
      maxCasesPerProviderCall: 16,
      prepareProviderRequest: input.prepareProviderRequest ?? ((_ledger, cases) => ({
          requestBytes: JSON.stringify(cases
            .map((plannedCase) => plannedCase.caseId)
            .sort()),
          adapterSupportsUtf8ByteUpperBound: true,
        })),
      verifiedEvidenceRecordsByRawFindingId: verifiedEvidenceRecords(request.items),
      ...request,
    }),
    completeInterpretationCases: async (request) => {
      const attemptIds = new Set(request.receipt.fences.map((fence) => fence.attemptId));
      const providerCallIds = [...new Set(store.loadLedger().interpretationAttempts
        .filter((attempt) => attemptIds.has(attempt.attemptId))
        .map((attempt) => attempt.providerCallId))];
      const reservedProviderCallIds = new Set(store.loadLedger().findingManagerProviderCalls
        .filter((call) => providerCallIds.includes(call.providerCallId) && call.state === 'reserved')
        .map((call) => call.providerCallId));
      if (reservedProviderCallIds.size > 0) {
        await store.updateLedger((ledger) => {
          let calls = ledger.findingManagerProviderCalls;
          for (const providerCallId of reservedProviderCallIds) {
            calls = dispatchFindingManagerProviderCall({
              calls,
              providerCallId,
              requestBytes: JSON.stringify(
                request.receipt.fences
                  .filter((fence) => ledger.interpretationAttempts.find(
                    (attempt) => attempt.attemptId === fence.attemptId,
                  )?.providerCallId === providerCallId)
                  .map((fence) => fence.caseId)
                  .sort(),
              ),
              adapterSupportsUtf8ByteUpperBound: true,
              dispatchedAt: OBSERVATION,
            }).calls;
          }
          return {
            ledger: { ...ledger, findingManagerProviderCalls: calls },
            result: undefined,
          };
        });
      }
      return completeInterpretationCases({
        store,
        observation: OBSERVATION,
        providerCallResults: providerCallIds.map((providerCallId) => ({
          providerCallId,
          resultKind: 'accepted' as const,
          responseBytes: '{}',
        })),
        ...request,
      });
    },
  };
}

export async function seed(harness: Harness, ledger: FindingLedger): Promise<void> {
  await harness.store.updateLedger(() => ({ ledger, result: undefined }));
}

export function readAuthorityRow(root: string): {
  revision: number;
  ledgerJson: string;
} {
  const database = new DatabaseSync(join(root, 'finding-contract.sqlite'), { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT revision, ledger_json AS ledgerJson
      FROM finding_authorities
      WHERE authority_key = ?
    `).get(ROOT_FINDING_AUTHORITY_KEY) as { revision: number; ledgerJson: string } | undefined;
    if (row === undefined) {
      throw new Error('Finding authority row is missing');
    }
    return row;
  } finally {
    database.close();
  }
}

export function response(
  plannedCase: { caseId: string },
  decision: InterpretationDecision,
) {
  return {
    caseId: plannedCase.caseId,
    decision,
  };
}

export function failure(
  plannedCase: { caseId: string },
  reason: string,
) {
  return {
    caseId: plannedCase.caseId,
    reason,
  };
}

export function advanceOpenFindingRevision(
  ledger: FindingLedger,
  findingId = 'F-0001',
): FindingLedger {
  const current = ledger.findings.find((finding) => finding.id === findingId);
  if (current === undefined || current.status !== 'open') {
    throw new Error(`Expected open finding "${findingId}"`);
  }
  return applyFindingLedgerFixtureRevision({
    ledger,
    entityKind: 'finding',
    entity: {
      ...current,
      lifecycle: 'persists',
      revision: current.revision + 1,
      lastSeen: {
        ...OBSERVATION,
        timestamp: '2026-08-02T00:01:00.000Z',
      },
    },
  });
}

export function addExactProductFinding(
  ledger: FindingLedger,
  findingId: string,
  sourceFindingId?: string,
): FindingLedger {
  const source = ledger.findings.find((finding) => (
    finding.provisional === undefined
    && (sourceFindingId === undefined || finding.id === sourceFindingId)
  ));
  if (source === undefined || source.target === null) {
    throw new Error('Expected a product finding source');
  }
  return applyFindingLedgerFixtureRevision({
    ledger,
    entityKind: 'finding',
    entity: {
      ...JSON.parse(JSON.stringify(source)) as typeof source,
      id: findingId,
      status: 'open',
      lifecycle: 'new',
      evidenceIds: [],
      rawFindingIds: [],
      firstSeen: { ...OBSERVATION },
      lastSeen: { ...OBSERVATION },
      revision: 1,
    },
  });
}
