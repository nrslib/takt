import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAgent } from '../agents/agent-usecases.js';
import { findingContentAddress } from '../core/models/finding-contract-identity.js';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import type { TerminalAdjudicationProposal } from '../core/models/finding-contract-types.js';
import { createEngineProofRecord } from '../core/models/finding-evidence-record.js';
import type { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { responseUpperBound } from '../core/workflow/findings/finding-manager-provider-call.js';
import { applyFindingLifecycleCommands } from '../core/workflow/findings/lifecycle-transaction.js';
import type { RunFindingManagerForStepInput } from '../core/workflow/findings/manager-contracts.js';
import type { FindingLedger, FindingLedgerEntry } from '../core/workflow/findings/types.js';
import { runTerminalAdjudication } from '../core/workflow/findings/terminal-adjudication-runner.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import {
  canonicalRawFindingFixture,
  rawCanonicalSnapshotFixture,
} from './helpers/finding-lifecycle-fixture.js';
import { createTestFindingLedgerStore } from './helpers/finding-storage.js';

vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: vi.fn() }));
const executeAgentMock = vi.mocked(executeAgent);

const OBSERVATION = {
  runId: 'run-terminal-runner',
  stepName: 'findings-terminal-adjudication',
  timestamp: '2026-08-03T00:00:00.000Z',
};
const LANDING_OBSERVATION = {
  ...OBSERVATION,
  stepName: 'reviewer',
  timestamp: '2026-08-02T00:00:00.000Z',
};
const WORKFLOW_TASK = 'Review src/provisional.ts.';
const REVIEW_SCOPE_SNAPSHOT = {
  reviewScopeSnapshotId: '2'.repeat(64),
  trackedDiff: undefined,
  untrackedEvidence: [],
  queryInventory: [],
  changedPaths: ['src/provisional.ts'],
};
const RAW = canonicalRawFindingFixture({
  rawFindingId: 'raw-terminal-runner',
  stepName: 'reviewer',
  reviewer: 'reviewer',
  familyTag: 'terminal',
  severity: 'medium',
  title: 'Provisional finding',
  description: 'The claim requires terminal adjudication.',
  suggestion: null,
  relation: 'new',
  targetFindingId: null,
  target: { kind: 'code', paths: ['src/provisional.ts'] },
  evidence: [],
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
    firstSeen: LANDING_OBSERVATION,
    lastSeen: LANDING_OBSERVATION,
    revision: 1,
    provisional: {
      kind: 'raw-meaning-ambiguous',
      stableKey: 'terminal-runner-stable',
      lineageKey: 'terminal-runner-lineage',
      sourceRawFindingIds: [RAW.rawFindingId],
      reason: 'Requires terminal adjudication.',
      firstObservedAt: LANDING_OBSERVATION,
      lastObservedAt: LANDING_OBSERVATION,
      gateEffect: 'block',
      firstObservedRound: 1,
    },
  };
}

function withoutRevision(
  finding: FindingLedgerEntry,
): Omit<FindingLedgerEntry, 'revision'> {
  const { revision: _revision, ...change } = finding;
  void _revision;
  return change;
}

function seededLedger(): FindingLedger {
  const finding = provisional();
  const proof = createEngineProofRecord({
    kind: 'engine_proof',
    purpose: 'lifecycle_authority',
    verifierId: 'takt.finding-lifecycle-policy',
    verifierVersion: '1',
    workflowName: 'terminal-runner',
    runId: OBSERVATION.runId,
    scopeIdentity: 'finding-storage:test:root',
    snapshotId: REVIEW_SCOPE_SNAPSHOT.reviewScopeSnapshotId,
    claimIdentityHash: finding.claimIdentityHash,
    targetFindingId: null,
    subject: {
      kind: 'finding_provisional_isolation',
      findingId: finding.id,
      provisionalKind: finding.provisional!.kind,
      stableKey: finding.provisional!.stableKey,
      claimBindingAuthorizationReferences: [],
    },
    dependencyDigests: [findingContentAddress('terminal-runner-absent-head', {
      findingId: finding.id,
    })],
    resultDigest: findingContentAddress('terminal-runner-isolation', {
      findingId: finding.id,
    }),
    issuedAt: LANDING_OBSERVATION.timestamp,
  });
  const initial: FindingLedger = {
    workflowName: 'terminal-runner',
    nextId: 2,
    updatedAt: LANDING_OBSERVATION.timestamp,
    findings: [],
    evidenceRecords: [proof],
    rawFindings: [RAW],
    conflicts: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    ...createEmptyFindingContractRegistries(),
    rawCanonicalSnapshots: [rawCanonicalSnapshotFixture(RAW, LANDING_OBSERVATION)],
    stopBudget: {
      roundMarkers: ['round-1'],
      firstRoundAt: LANDING_OBSERVATION.timestamp,
      exhausted: false,
    },
  };
  return applyFindingLifecycleCommands({
    ledger: initial,
    commands: [{
      operation: 'update_provisional',
      changes: {
        findings: [{
          ...withoutRevision(finding),
          evidenceIds: [proof.evidenceId],
        }],
        conflicts: [],
      },
      authority: { kind: 'verified_evidence' },
      evidenceSourcesByTarget: new Map([[
        `finding\0${finding.id}`,
        {
          sourceRawFindingIds: [RAW.rawFindingId],
          authorityEvidenceIds: [proof.evidenceId],
        },
      ]]),
    }],
    occurredAt: LANDING_OBSERVATION,
  });
}

const PROPOSALS = [
  {
    kind: 'promote_independent',
    proposedProduct: {
      target: RAW.target,
      targetIdentityHash: RAW.targetIdentityHash,
      familyTag: RAW.familyTag!,
      severity: RAW.severity!,
      title: RAW.title!,
      description: RAW.description!,
      suggestion: RAW.suggestion ?? null,
      claimIdentityHash: RAW.claimIdentityHash,
      semanticClaimIdentityHash: RAW.semanticClaimIdentityHash,
      evidenceRecordIds: [],
    },
    authorityRefIds: ['3'.repeat(64)],
    rationale: 'The claim should become an independent product finding.',
  },
  {
    kind: 'merge_existing',
    targetRefId: '4'.repeat(64),
    authorityRefIds: ['3'.repeat(64)],
    rationale: 'The claim matches an existing finding.',
  },
  {
    kind: 'dismiss',
    basis: 'false_positive',
    authorityRefIds: ['3'.repeat(64)],
    rationale: 'The claim is a false positive.',
  },
  {
    kind: 'undetermined',
    rationale: 'No exact authority is available.',
  },
] as const satisfies readonly TerminalAdjudicationProposal[];

describe('terminal adjudication runner provider envelope', () => {
  let cwd: string;
  let ledgerStore: FindingLedgerStore;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-terminal-runner-'));
    mkdirSync(join(cwd, '.takt', 'runs', OBSERVATION.runId, 'reports'), { recursive: true });
    ledgerStore = createTestFindingLedgerStore({
      projectCwd: cwd,
      runId: OBSERVATION.runId,
      reportDir: join(cwd, '.takt', 'runs', OBSERVATION.runId, 'reports'),
      workflowName: 'terminal-runner',
    });
    await ledgerStore.updateLedger(() => ({ ledger: seededLedger(), result: undefined }));
  });

  afterEach(() => {
    executeAgentMock.mockReset();
    rmSync(cwd, { recursive: true, force: true });
  });

  function runInput(): RunFindingManagerForStepInput {
    return {
      contract: {
        manager: {
          persona: 'manager',
          instruction: 'Manage findings.',
          outputContract: 'Return structured findings.',
        },
        adjudicator: { persona: 'supervisor' },
      },
      cwd,
      workflowProvider: 'claude',
      ledgerStore,
      optionsBuilder: {
        buildAgentOptions: () => ({ provider: 'claude', cwd }),
      } as unknown as OptionsBuilder,
      stepExecutor: {
        buildPhase1Instruction: (instruction: string) => instruction,
        normalizeStructuredOutput: (_step, response) => response,
        recordSynthesizedAgentUsage: () => {},
      },
      parentStep: {
        kind: 'agent',
        name: 'reviewer',
        personaDisplayName: 'reviewer',
        persona: 'reviewer',
        instruction: 'Review.',
      },
      stepIteration: 1,
      subResults: [],
      workflowName: 'terminal-runner',
      workflowTask: WORKFLOW_TASK,
      runId: OBSERVATION.runId,
      callNamespace: 'terminal-runner',
      timestamp: OBSERVATION.timestamp,
      managerAuthority: 'standard',
    };
  }

  async function run(): Promise<void> {
    await runTerminalAdjudication({
      runInput: runInput(),
      observation: OBSERVATION,
      roundIdentity: findingContentAddress('terminal-runner-round', {}),
      scopeIdentity: findingContentAddress('terminal-runner-scope', {}),
      reviewScopeSnapshot: REVIEW_SCOPE_SNAPSHOT,
    });
  }

  it.each(PROPOSALS)('accepts the $kind proposal envelope and digests the full response', async (proposal) => {
    const structuredOutput = { proposal };
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput,
      timestamp: new Date(OBSERVATION.timestamp),
    });

    await run();
    const ledger = ledgerStore.loadLedger();
    const responseDigest = responseUpperBound({
      responseBytes: JSON.stringify(structuredOutput),
    }).responseDigest;

    expect(ledger.terminalAdjudicationAttempts).toEqual([
      expect.objectContaining({
        stage: 'completed',
        result: expect.objectContaining({
          kind: 'verification_undetermined',
          proposal: expect.objectContaining({ kind: proposal.kind }),
        }),
      }),
    ]);
    expect(ledger.findingManagerProviderCalls).toEqual([
      expect.objectContaining({
        state: 'settled',
        purpose: 'terminal_adjudication',
        resultKind: 'accepted',
        responseDigest,
      }),
    ]);
  });

  it('rejects a legacy response shape as parse_failed and retains its response digest', async () => {
    const structuredOutput = { outcome: 'finding_stale' };
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput,
      timestamp: new Date(OBSERVATION.timestamp),
    });

    await run();
    const ledger = ledgerStore.loadLedger();
    const responseDigest = responseUpperBound({
      responseBytes: JSON.stringify(structuredOutput),
    }).responseDigest;

    expect(ledger.terminalAdjudicationAttempts).toEqual([
      expect.objectContaining({
        stage: 'completed',
        result: expect.objectContaining({
          kind: 'diagnostic_undetermined',
          code: 'parse_failed',
          responseDigest,
        }),
      }),
    ]);
    expect(ledger.findingManagerProviderCalls).toEqual([
      expect.objectContaining({
        state: 'settled',
        resultKind: 'rejected',
        failurePhase: 'parse_failed',
        responseDigest,
      }),
    ]);
  });

  it('records provider_failed with a null response digest', async () => {
    executeAgentMock.mockRejectedValue(new Error('provider unavailable'));

    await run();
    const ledger = ledgerStore.loadLedger();

    expect(ledger.terminalAdjudicationAttempts).toEqual([
      expect.objectContaining({
        stage: 'completed',
        result: expect.objectContaining({
          kind: 'diagnostic_undetermined',
          code: 'provider_failed',
          responseDigest: null,
        }),
      }),
    ]);
    expect(ledger.findingManagerProviderCalls).toEqual([
      expect.objectContaining({
        state: 'settled',
        resultKind: 'rejected',
        failurePhase: 'provider_failed',
      }),
    ]);
    expect(ledger.findingManagerProviderCalls[0]).not.toHaveProperty('responseDigest');
  });
});
