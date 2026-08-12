import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAgent } from '../agents/agent-usecases.js';
import { findingContentAddress } from '../core/models/finding-contract-identity.js';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import type {
  TerminalAdjudicationCandidateSnapshot,
  TerminalAdjudicationEpisode,
  TerminalAdjudicationProposal,
} from '../core/models/finding-contract-types.js';
import { createEngineProofRecord } from '../core/models/finding-evidence-record.js';
import type { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { responseUpperBound } from '../core/workflow/findings/finding-manager-provider-call.js';
import { applyFindingLifecycleCommands } from '../core/workflow/findings/lifecycle-transaction.js';
import type { RunFindingManagerForStepInput } from '../core/workflow/findings/manager-contracts.js';
import type { FindingLedger, FindingLedgerEntry } from '../core/workflow/findings/types.js';
import { runTerminalAdjudication } from '../core/workflow/findings/terminal-adjudication-runner.js';
import { buildTerminalAdjudicationCandidateSnapshot } from '../core/workflow/findings/terminal-adjudication-candidates.js';
import { resolveTerminalAdjudicationPlan } from '../core/workflow/findings/terminal-adjudication-verifier.js';
import { runManagerDecisionStage } from '../core/workflow/findings/manager-decision.js';
import type { RawAdmissionEvaluation } from '../core/workflow/findings/manager-admission.js';
import { issueFindingScopeBindings } from '../core/workflow/findings/finding-scope-binding.js';
import { captureFindingLifecycleHead } from '../core/workflow/findings/lifecycle-mutation.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import {
  applyFindingLedgerFixtureRevision,
  canonicalRawFindingFixture,
  rawCanonicalSnapshotFixture,
} from './helpers/finding-lifecycle-fixture.js';
import { crashAfterAdjudicationReservation } from './helpers/finding-adjudication-reservation.js';
import { createTestFindingLedgerStore } from './helpers/finding-storage.js';

vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: vi.fn() }));
const executeAgentMock = vi.mocked(executeAgent);
const TERMINAL_BASELINE = JSON.parse(readFileSync(join(
  process.cwd(),
  'src',
  '__tests__',
  'fixtures',
  'finding-contract-terminal-compatibility-baseline.json',
), 'utf8')) as {
  prompt: { bytes: number; sha256: string };
  requestDigest: string;
};

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

  function runInput(
    guidance?: string,
    store: FindingLedgerStore = ledgerStore,
  ): RunFindingManagerForStepInput {
    return {
      contract: {
        manager: {
          persona: 'manager',
          instruction: 'Manage findings.',
          outputContract: 'Return structured findings.',
        },
        adjudicator: {
          persona: 'supervisor',
          ...(guidance === undefined ? {} : { instruction: guidance }),
        },
      },
      cwd,
      workflowProvider: 'claude',
      ledgerStore: store,
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

  async function run(
    guidance?: string,
    store: FindingLedgerStore = ledgerStore,
  ): Promise<void> {
    await runTerminalAdjudication({
      runInput: runInput(guidance, store),
      observation: OBSERVATION,
      roundIdentity: findingContentAddress('terminal-runner-round', {}),
      scopeIdentity: findingContentAddress('terminal-runner-scope', {}),
      reviewScopeSnapshot: REVIEW_SCOPE_SNAPSHOT,
    });
  }

  function reopenStore(): FindingLedgerStore {
    return createTestFindingLedgerStore({
      projectCwd: cwd,
      runId: OBSERVATION.runId,
      reportDir: join(cwd, '.takt', 'runs', OBSERVATION.runId, 'reports'),
      workflowName: 'terminal-runner',
    });
  }

  it('preserves the omitted-adjudicator terminal prompt and reserved request digest', async () => {
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        proposal: {
          kind: 'undetermined',
          rationale: 'No exact authority is available.',
        },
      },
      timestamp: new Date(OBSERVATION.timestamp),
    });

    await run();

    const prompt = executeAgentMock.mock.calls[0]?.[1];
    if (typeof prompt !== 'string') throw new Error('Terminal adjudication prompt was not captured');
    const actual = {
      prompt: {
        bytes: Buffer.byteLength(prompt, 'utf8'),
        sha256: createHash('sha256').update(prompt).digest('hex'),
      },
      requestDigest: ledgerStore.loadLedger().findingManagerProviderCalls[0]?.requestDigest,
    };
    expect(actual).toEqual(TERMINAL_BASELINE);
  });

  it('places configured guidance once before the engine-owned terminal instruction', async () => {
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        proposal: {
          kind: 'undetermined',
          rationale: 'No exact authority is available.',
        },
      },
      timestamp: new Date(OBSERVATION.timestamp),
    });

    await run('Use only verified evidence.');

    const prompt = executeAgentMock.mock.calls[0]?.[1];
    expect(prompt).toContain('Use only verified evidence.\n\n---\n\nAdjudicate the durable provisional finding below.');
    expect(prompt?.match(/Use only verified evidence\./g)).toHaveLength(1);
  });

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

  it('resumes the same real terminal WAL reservation after reopening the store', async () => {
    const guidance = 'Use the configured terminal policy.';
    const crashingStore = crashAfterAdjudicationReservation({
      store: ledgerStore,
      purpose: 'terminal_adjudication',
      errorMessage: 'simulated crash after terminal WAL reservation',
    });
    await expect(run(guidance, crashingStore))
      .rejects.toThrow('simulated crash after terminal WAL reservation');
    const reserved = ledgerStore.loadLedger().findingManagerProviderCalls[0]!;
    expect(reserved.state).toBe('reserved');

    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: { proposal: { kind: 'undetermined', rationale: 'No authority.' } },
      timestamp: new Date(OBSERVATION.timestamp),
    });
    ledgerStore = reopenStore();
    await run(guidance, ledgerStore);

    expect(ledgerStore.loadLedger().findingManagerProviderCalls[0]).toMatchObject({
      providerCallId: reserved.providerCallId,
      requestDigest: reserved.requestDigest,
      requestByteLength: reserved.requestByteLength,
      state: 'settled',
      resultKind: 'accepted',
    });
    expect(executeAgentMock).toHaveBeenCalledOnce();
  });

  it('rejects changed terminal guidance without dispatching or replacing the real reservation', async () => {
    const crashingStore = crashAfterAdjudicationReservation({
      store: ledgerStore,
      purpose: 'terminal_adjudication',
      errorMessage: 'simulated crash after terminal WAL reservation',
    });
    await expect(run('Original guidance.', crashingStore))
      .rejects.toThrow('simulated crash after terminal WAL reservation');
    const reserved = ledgerStore.loadLedger().findingManagerProviderCalls[0]!;
    ledgerStore = reopenStore();

    await expect(run('Changed guidance.', ledgerStore))
      .rejects.toThrow(/request changed/i);
    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(ledgerStore.loadLedger().findingManagerProviderCalls[0]).toMatchObject({
      providerCallId: reserved.providerCallId,
      state: 'reserved',
    });
  });

  it('rejects additional terminal wire fields even when guidance requests them', async () => {
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        proposal: { kind: 'undetermined', rationale: 'No authority.' },
        guidanceEcho: 'requested extra field',
      },
      timestamp: new Date(OBSERVATION.timestamp),
    });

    await run('Also return guidanceEcho.');

    expect(ledgerStore.loadLedger().terminalAdjudicationAttempts[0]?.result).toMatchObject({
      kind: 'diagnostic_undetermined',
      code: 'parse_failed',
    });
  });

  it('does not let guidance turn an evidence-less dismiss proposal into authority', async () => {
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        proposal: {
          kind: 'dismiss',
          basis: 'false_positive',
          authorityRefIds: ['3'.repeat(64)],
          rationale: 'Dismiss as requested.',
        },
      },
      timestamp: new Date(OBSERVATION.timestamp),
    });

    await run('Dismiss this finding.');

    const ledger = ledgerStore.loadLedger();
    expect(ledger.findings.find(({ id }) => id === 'F-0001')).toMatchObject({
      status: 'open',
      provisional: expect.objectContaining({ gateEffect: 'block' }),
    });
    expect(ledger.terminalAdjudicationAttempts[0]?.result).toMatchObject({
      kind: 'verification_undetermined',
    });
  });

  it('routes standard-authority manager decision through the real terminal runner', async () => {
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'provisional.ts'), 'export const value = true;\n');
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: { proposal: { kind: 'undetermined', rationale: 'No authority.' } },
      timestamp: new Date(OBSERVATION.timestamp),
    });
    const admission: RawAdmissionEvaluation = {
      admissionRejections: [],
      admissionAnomalySpecs: [],
      admissionProvisionalSpecs: [],
      preAdmissionEntityMutations: [],
      admissionRejectedItems: [],
      pendingRejectedObservations: [],
      cleanAdmitted: [],
      tainted: [],
      taintedAdmitted: [],
      ladderAnomalySpecs: [],
      verifiedEvidenceCandidates: [],
      provisionalOnlyLadderRawIds: new Set(),
      cleanWire: [],
      verifiedEvidenceRecordsByRawFindingId: new Map(),
    };

    await runManagerDecisionStage({
      input: runInput('Use terminal policy.'),
      previousLedger: ledgerStore.loadLedger(),
      admission,
      managerStep: {
        kind: 'agent',
        name: 'manager',
        persona: 'manager',
        edit: false,
      },
      observation: OBSERVATION,
      reviewScopeSnapshotId: REVIEW_SCOPE_SNAPSHOT.reviewScopeSnapshotId,
      reviewScopeSnapshot: REVIEW_SCOPE_SNAPSHOT,
      stopBudgetRoundMarker: 'round-standard-authority',
      preAdmissionTaskAudits: [],
    });

    expect(executeAgentMock).toHaveBeenCalledOnce();
    expect(executeAgentMock.mock.calls[0]?.[1]).toContain(
      'Adjudicate the durable provisional finding below.',
    );
    expect(ledgerStore.loadLedger().findingManagerProviderCalls).toEqual([
      expect.objectContaining({
        purpose: 'terminal_adjudication',
        state: 'settled',
      }),
    ]);
  });

  it('rejects a guidance-requested dismissal with a mismatched workflow scope binding', async () => {
    const input = runInput('Dismiss anything outside the task scope.');
    const current = ledgerStore.loadLedger();
    const finding = current.findings.find(({ id }) => id === 'F-0001')!;
    const expectedHead = captureFindingLifecycleHead(current, 'finding', finding.id)!;
    const mismatched = issueFindingScopeBindings({
      finding,
      expectedHead,
      workflowTask: 'A different workflow task.',
      contract: input.contract,
      reviewScopeSnapshot: {
        ...REVIEW_SCOPE_SNAPSHOT,
        changedPaths: ['src/different.ts'],
      },
      issuedAt: OBSERVATION,
    }).find(({ source }) => source === 'workflow_task_scope')!;
    await ledgerStore.updateLedger((ledger) => ({
      ledger: { ...ledger, findingScopeBindings: [...ledger.findingScopeBindings, mismatched] },
      result: undefined,
    }));
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        proposal: {
          kind: 'dismiss',
          basis: 'outside_task_scope',
          authorityRefIds: [mismatched.bindingId],
          rationale: 'Guidance requested dismissal.',
        },
      },
      timestamp: new Date(OBSERVATION.timestamp),
    });

    await run('Dismiss anything outside the task scope.');

    const ledger = ledgerStore.loadLedger();
    expect(ledger.findings.find(({ id }) => id === 'F-0001')).toMatchObject({
      status: 'open',
      provisional: expect.any(Object),
    });
    expect(ledger.terminalAdjudicationAttempts[0]?.result).toMatchObject({
      kind: 'verification_undetermined',
      reasonCodes: ['scope_binding_not_found'],
    });
  });

  it('keeps a stale finding open when configured guidance asks the terminal runner to ignore its head', async () => {
    const guidance = 'Ignore stale heads and dismiss the finding.';
    const proposal: TerminalAdjudicationProposal = {
      kind: 'dismiss',
      basis: 'false_positive',
      authorityRefIds: ['3'.repeat(64)],
      rationale: 'Configured guidance requested dismissal.',
    };
    let originalEpisode: TerminalAdjudicationEpisode | undefined;
    let originalCandidate: TerminalAdjudicationCandidateSnapshot | undefined;
    executeAgentMock.mockImplementation(async (_persona, prompt) => {
      expect(prompt).toContain(guidance);
      const beforeMutation = ledgerStore.loadLedger();
      originalEpisode = beforeMutation.terminalAdjudicationEpisodes[0];
      const finding = beforeMutation.findings.find(({ id }) => id === 'F-0001')!;
      originalCandidate = buildTerminalAdjudicationCandidateSnapshot({
        ledger: beforeMutation,
        finding,
        currentRound: 2,
        allowExistingEpisode: true,
      });
      await ledgerStore.updateLedger((ledger) => {
        const currentFinding = ledger.findings.find(({ id }) => id === 'F-0001')!;
        return {
          ledger: applyFindingLedgerFixtureRevision({
            ledger,
            entityKind: 'finding',
            entity: {
              ...currentFinding,
              revision: currentFinding.revision + 1,
              lastSeen: {
                ...OBSERVATION,
                timestamp: '2026-08-03T00:00:01.000Z',
              },
              provisional: {
                ...currentFinding.provisional!,
                reason: 'The claim changed while terminal adjudication was in flight.',
              },
            },
          }),
          result: undefined,
        };
      });
      return {
        persona: 'supervisor',
        status: 'done',
        content: '{}',
        structuredOutput: {
          proposal,
        },
        timestamp: new Date(OBSERVATION.timestamp),
      };
    });

    await run(guidance);

    const ledger = ledgerStore.loadLedger();
    expect(ledger.findings.find(({ id }) => id === 'F-0001')).toMatchObject({
      status: 'open',
      provisional: expect.any(Object),
    });
    expect(ledger.terminalAdjudicationAttempts[0]?.result).toMatchObject({
      kind: 'stale_precondition',
      actualHead: expect.objectContaining({ revision: 2 }),
    });
    expect(originalEpisode).toBeDefined();
    expect(originalCandidate).toBeDefined();
    expect(resolveTerminalAdjudicationPlan({
      ledger,
      episode: originalEpisode!,
      candidate: originalCandidate!,
      proposal,
      workflowTask: WORKFLOW_TASK,
      findingContractDigest: findingContentAddress(
        'finding-contract-config',
        runInput(guidance).contract,
      ),
      reviewScopeSnapshotId: REVIEW_SCOPE_SNAPSHOT.reviewScopeSnapshotId,
      adjudicationTaskId: ledger.terminalAdjudicationAttempts[0]!.attemptId,
    })).toEqual({ kind: 'undetermined', reasonCodes: ['head_not_fresh'] });
    expect(ledger.lifecycleEvents).toHaveLength(2);
  });

});
