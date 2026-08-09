import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAgent } from '../agents/agent-usecases.js';
import { createEngineProofRecord } from '../core/models/finding-evidence-record.js';
import type { WorkflowState } from '../core/models/types.js';
import { createFindingConflictAdjudicationRunner } from '../core/workflow/findings/adjudication-runner.js';
import { buildFindingConflictAdjudicationStep } from '../core/workflow/findings/adjudication-step.js';
import {
  renderConflictAdjudicationInstruction,
  type ConflictAdjudicationHistoryOrder,
} from '../core/workflow/findings/adjudication-evidence.js';
import { landUnownedConflictRawClaims } from '../core/workflow/findings/conflict-claim-landing.js';
import { applyFindingLifecycleCommands } from '../core/workflow/findings/lifecycle-transaction.js';
import {
  buildConflictAdjudicationSnapshot,
  freshConflictAdjudicationSnapshot,
  hasAlwaysChangingConflictTarget,
  isActiveConflictUnadjudicated,
  refreshActiveConflictAdjudicationSnapshots,
} from '../core/workflow/findings/conflict-adjudication-model.js';
import { reserveFindingConflictAdjudication } from '../core/workflow/findings/adjudication-reservation.js';
import type { FindingContractConfig, FindingLedger } from '../core/workflow/findings/types.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import { crashAfterAdjudicationReservation } from './helpers/finding-adjudication-reservation.js';
import { createTestFindingLedgerStore } from './helpers/finding-storage.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { authorizeFindingLedgerFixture } from './helpers/finding-lifecycle-fixture.js';
import { verifiedFindingEvidenceFixture } from './helpers/finding-evidence.js';
import { MANAGER_INTERPRETATION_LIMITS } from '../core/workflow/findings/raw-finding-limits.js';
import {
  captureConflictTargetContentDigests,
  captureReviewScopeProofSnapshot,
} from '../core/workflow/findings/snapshot.js';
import { conflictTargetPaths } from '../core/workflow/findings/conflict-target.js';

vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: vi.fn() }));
const executeAgentMock = vi.mocked(executeAgent);

const OBSERVATION = {
  runId: 'run-0',
  stepName: 'reviewers',
  timestamp: '2026-06-13T00:00:00.000Z',
};
const SCOPE_IDENTITY = '4'.repeat(64);

function state(): WorkflowState {
  return {
    workflowName: 'runner-test',
    currentStep: 'finding-conflict-adjudication',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

function contract(cwd: string): FindingContractConfig {
  return {
    manager: {
      persona: 'findings-manager',
      instruction: 'findings-manager',
      outputContract: 'findings-manager',
    },
    adjudicator: {
      persona: 'supervisor',
      personaPath: join(cwd, 'supervisor.md'),
      personaDisplayName: 'supervisor',
      providerRoutingPersonaKey: 'supervisor',
    },
  };
}

function seededLedger(cwd: string): FindingLedger {
  const evidence = verifiedFindingEvidenceFixture({
    cwd,
    path: 'src/a.ts',
    startLine: 1,
    title: 'Disputed issue',
    description: 'The bug is present.',
    familyTag: 'bug',
    targetFindingId: 'F-0001',
  });
  const ledger = authorizeFindingLedgerFixture({
    workflowName: 'runner-test',
    nextId: 2,
    updatedAt: OBSERVATION.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      revision: 1,
      severity: 'high',
      title: 'Disputed issue',
      description: 'The bug is present.',
      evidenceIds: [evidence.record.evidenceId],
      reviewers: ['coding-review'],
      rawFindingIds: ['raw-1'],
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
    }],
    rawFindings: [{
      rawFindingId: 'raw-1',
      stepName: 'reviewers',
      reviewer: 'coding-review',
      familyTag: 'bug',
      severity: 'high',
      title: 'Disputed issue',
      description: 'The bug is present.',
      suggestion: null,
      relation: 'persists',
      targetFindingId: 'F-0001',
      targetPrecondition: {
        targetFindingId: 'F-0001',
        targetRevision: 1,
        targetStatus: 'open',
        targetEvidenceHash: '0'.repeat(64),
      },
      evidence: [evidence.evidence],
    }],
    conflicts: [{
      id: 'C-FA2947446963',
      status: 'active',
      findingIds: ['F-0001'],
      rawFindingIds: ['raw-1'],
      description: 'Reviewers disagree about F-0001.',
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
      revision: 1,
    }],
    evidenceRecords: [evidence.record],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
  });
  const landed = landUnownedConflictRawClaims({ ledger, observation: OBSERVATION });
  const reviewScopeSnapshot = captureReviewScopeProofSnapshot(cwd);
  const queryInventoryByPath = new Map(
    reviewScopeSnapshot.queryInventory.map((entry) => [entry.path, entry]),
  );
  return refreshActiveConflictAdjudicationSnapshots({
    ledger: landed,
    originStep: 'reviewers',
    createdAt: OBSERVATION,
    targetContentDigestsByConflict: new Map([[
      'C-FA2947446963',
      captureConflictTargetContentDigests(
        queryInventoryByPath,
        conflictTargetPaths({ ledger: landed, conflictId: 'C-FA2947446963' }),
      ),
    ]]),
  });
}

describe('finding-conflict-adjudication runner registry contract', () => {
  let cwd: string;
  let ledgerStore: FindingLedgerStore;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-conflict-runner-registry-'));
    mkdirSync(join(cwd, 'src'), { recursive: true });
    mkdirSync(join(cwd, '.takt', 'runs', 'run-1', 'reports'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'a.ts'), 'export const value = true;\n');
    writeFileSync(join(cwd, 'supervisor.md'), '# Supervisor\n');
    initializeGitFixture(cwd, ['src/a.ts', 'supervisor.md']);
    ledgerStore = createTestFindingLedgerStore({
      projectCwd: cwd,
      runId: 'run-1',
      reportDir: join(cwd, '.takt', 'runs', 'run-1', 'reports'),
      workflowName: 'runner-test',
    });
    await ledgerStore.updateLedger(() => ({ ledger: seededLedger(cwd), result: undefined }));
  });

  afterEach(() => {
    executeAgentMock.mockReset();
    rmSync(cwd, { recursive: true, force: true });
  });

  function runner(
    guidance?: string,
    store: FindingLedgerStore = ledgerStore,
  ) {
    const step = buildFindingConflictAdjudicationStep({
      contract: contract(cwd),
      workflowProvider: 'claude',
    });
    return {
      step,
      runner: createFindingConflictAdjudicationRunner({
        ledgerStore: store,
        optionsBuilder: {
          buildAgentOptions: () => ({
            provider: 'claude',
            cwd,
            providerOptions: { claude: {} },
            resolvedProviderOptions: { claude: {} },
          }),
          resolveStepProviderModel: () => ({ provider: 'claude', providerSource: 'workflow' }),
        },
        stepExecutor: {
          buildPhase1Instruction: (instruction: string) => instruction,
          normalizeStructuredOutput: (_step, response) => response,
        },
        getCwd: () => cwd,
        workflowName: 'runner-test',
        analyticsWorkflowName: 'runner-test',
        findingScopeIdentity: SCOPE_IDENTITY,
        runId: 'run-1',
        refreshFindingsState: () => {},
        emitEvent: () => {},
        guidance,
      }),
    };
  }

  function reopenStore(): FindingLedgerStore {
    return createTestFindingLedgerStore({
      projectCwd: cwd,
      runId: 'run-1',
      reportDir: join(cwd, '.takt', 'runs', 'run-1', 'reports'),
      workflowName: 'runner-test',
    });
  }

  it('records undetermined output in snapshots, episodes, attempts, and provider calls', async () => {
    const snapshot = freshConflictAdjudicationSnapshot(
      ledgerStore.loadLedger(),
      'C-FA2947446963',
    );
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        proposal: {
          kind: 'undetermined',
          subjectIds: snapshot.subjects.map(({ subjectId }) => subjectId).sort(),
          rationale: 'No verified terminal authority is available.',
        },
      },
      timestamp: new Date(),
    });
    const target = runner();

    await target.runner.run(target.step, state());
    const ledger = ledgerStore.loadLedger();

    expect(ledger.conflicts[0]).not.toHaveProperty('adjudications');
    expect(ledger.conflictAdjudicationSnapshots).toHaveLength(1);
    expect(ledger.conflictAdjudicationEpisodes).toHaveLength(1);
    expect(ledger.conflictAdjudicationAttempts).toHaveLength(2);
    expect(ledger.conflictAdjudicationAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conflictSnapshotId: snapshot.conflictSnapshotId,
        attemptOrdinal: 1,
        stage: 'completed',
        result: expect.objectContaining({ kind: 'verification_undetermined' }),
      }),
      expect.objectContaining({
        conflictSnapshotId: snapshot.conflictSnapshotId,
        attemptOrdinal: 2,
        stage: 'completed',
        result: expect.objectContaining({ kind: 'verification_undetermined' }),
      }),
    ]));
    expect(ledger.conflictClaimSettlements).toEqual([]);
    expect(ledger.findingManagerProviderCalls).toHaveLength(2);
    expect(ledger.findingManagerProviderCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'settled', purpose: 'conflict_adjudication' }),
    ]));
    expect(ledger.findingManagerProviderCalls.every((call) => (
      call.requestByteLength <= MANAGER_INTERPRETATION_LIMITS.maxInputBytesPerCall
    ))).toBe(true);
    expect(executeAgentMock).toHaveBeenCalledTimes(2);
  });

  it('does not re-adjudicate an unchanged conflict snapshot', async () => {
    const snapshot = freshConflictAdjudicationSnapshot(
      ledgerStore.loadLedger(),
      'C-FA2947446963',
    );
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        proposal: {
          kind: 'undetermined',
          subjectIds: snapshot.subjects.map(({ subjectId }) => subjectId).sort(),
          rationale: 'No verified terminal authority is available.',
        },
      },
      timestamp: new Date(),
    });

    const first = runner();
    await first.runner.run(first.step, state());
    executeAgentMock.mockClear();

    const second = runner();
    await second.runner.run(second.step, state());

    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(ledgerStore.loadLedger().conflictAdjudicationAttempts).toHaveLength(2);
  });

  it('re-adjudicates when a fix changes the conflict target code with the same ledger projection', async () => {
    executeAgentMock.mockImplementation(async () => {
      const snapshot = freshConflictAdjudicationSnapshot(
        ledgerStore.loadLedger(),
        'C-FA2947446963',
      );
      return {
        persona: 'supervisor',
        status: 'done' as const,
        content: '{}',
        structuredOutput: {
          proposal: {
            kind: 'undetermined' as const,
            subjectIds: snapshot.subjects.map(({ subjectId }) => subjectId).sort(),
            rationale: 'The target needs another adjudication after the fix.',
          },
        },
        timestamp: new Date(),
      };
    });

    const first = runner();
    await first.runner.run(first.step, state());
    const original = freshConflictAdjudicationSnapshot(ledgerStore.loadLedger(), 'C-FA2947446963');
    const before = ledgerStore.loadLedger();
    writeFileSync(join(cwd, 'src', 'a.ts'), 'export const value = false;\n');
    expect(ledgerStore.loadLedger().conflicts).toEqual(before.conflicts);

    executeAgentMock.mockClear();
    const second = runner();
    await second.runner.run(second.step, state());

    const changed = freshConflictAdjudicationSnapshot(ledgerStore.loadLedger(), 'C-FA2947446963');
    expect(changed.conflictSnapshotId).not.toBe(original.conflictSnapshotId);
    expect(changed.targetContentDigests).not.toEqual(original.targetContentDigests);
    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    expect(ledgerStore.loadLedger().conflictAdjudicationSnapshots).toHaveLength(2);
  });

  it('re-adjudicates only after the conflict subject snapshot changes', async () => {
    executeAgentMock.mockImplementation(async () => {
      const snapshot = freshConflictAdjudicationSnapshot(
        ledgerStore.loadLedger(),
        'C-FA2947446963',
      );
      return {
        persona: 'supervisor',
        status: 'done' as const,
        content: '{}',
        structuredOutput: {
          proposal: {
            kind: 'undetermined' as const,
            subjectIds: snapshot.subjects.map(({ subjectId }) => subjectId).sort(),
            rationale: 'No verified terminal authority is available.',
          },
        },
        timestamp: new Date(),
      };
    });

    const first = runner();
    await first.runner.run(first.step, state());
    const originalSnapshot = freshConflictAdjudicationSnapshot(
      ledgerStore.loadLedger(),
      'C-FA2947446963',
    );
    await ledgerStore.updateLedger((current) => {
      const holding = current.findings.find((finding) => finding.provisional !== undefined);
      if (holding?.provisional === undefined) {
        throw new Error('Expected a conflict holding in the changed-snapshot fixture');
      }
      const { revision: _revision, ...holdingWithoutRevision } = holding;
      void _revision;
      const changed = applyFindingLifecycleCommands({
        ledger: current,
        commands: [{
          operation: 'update_provisional',
          changes: {
            findings: [{
              ...holdingWithoutRevision,
              provisional: {
                ...holding.provisional,
                lastObservedAt: {
                  ...OBSERVATION,
                  timestamp: '2026-06-13T00:01:00.000Z',
                },
              },
            }],
            conflicts: [],
          },
          authority: { kind: 'verified_evidence' },
          evidenceSourcesByTarget: new Map([[
            `finding\0${holding.id}`,
            { sourceRawFindingIds: holding.provisional.sourceRawFindingIds, authorityEvidenceIds: [] },
          ]]),
        }],
        occurredAt: {
          ...OBSERVATION,
          timestamp: '2026-06-13T00:01:00.000Z',
        },
      });
      return {
        ledger: refreshActiveConflictAdjudicationSnapshots({
          ledger: changed,
          originStep: 'reviewers',
          createdAt: OBSERVATION,
        }),
        result: undefined,
      };
    });
    const changedSnapshot = freshConflictAdjudicationSnapshot(
      ledgerStore.loadLedger(),
      'C-FA2947446963',
    );
    expect(changedSnapshot.conflictSnapshotId).not.toBe(originalSnapshot.conflictSnapshotId);

    executeAgentMock.mockClear();
    const second = runner();
    await second.runner.run(second.step, state());

    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    expect(ledgerStore.loadLedger().conflictAdjudicationSnapshots).toHaveLength(2);
    expect(ledgerStore.loadLedger().conflictAdjudicationEpisodes).toHaveLength(2);
    expect(ledgerStore.loadLedger().conflictAdjudicationAttempts).toHaveLength(4);
  });

  it('does not re-adjudicate after a same-claim persisted observation', async () => {
    executeAgentMock.mockImplementation(async () => {
      const snapshot = freshConflictAdjudicationSnapshot(
        ledgerStore.loadLedger(),
        'C-FA2947446963',
      );
      return {
        persona: 'supervisor',
        status: 'done' as const,
        content: '{}',
        structuredOutput: {
          proposal: {
            kind: 'undetermined' as const,
            subjectIds: snapshot.subjects.map(({ subjectId }) => subjectId).sort(),
            rationale: 'No verified terminal authority is available.',
          },
        },
        timestamp: new Date(),
      };
    });

    const first = runner();
    await first.runner.run(first.step, state());
    const originalSnapshot = freshConflictAdjudicationSnapshot(
      ledgerStore.loadLedger(),
      'C-FA2947446963',
    );

    await ledgerStore.updateLedger((current) => {
      const product = current.findings.find((finding) => (
        finding.id === 'F-0001' && finding.provisional === undefined
      ));
      if (product === undefined) {
        throw new Error('Expected a product finding in the persisted-observation fixture');
      }
      const { revision: _revision, ...productWithoutRevision } = product;
      void _revision;
      const changed = applyFindingLifecycleCommands({
        ledger: current,
        commands: [{
          operation: 'persist_finding',
          changes: {
            findings: [{
              ...productWithoutRevision,
              lifecycle: 'persists',
              lastSeen: {
                ...OBSERVATION,
                timestamp: '2026-06-13T00:02:00.000Z',
              },
            }],
            conflicts: [],
          },
          authority: { kind: 'verified_evidence' },
          evidenceSourcesByTarget: new Map([[
            `finding\0${product.id}`,
            { sourceRawFindingIds: product.rawFindingIds, authorityEvidenceIds: [] },
          ]]),
        }],
        occurredAt: {
          ...OBSERVATION,
          timestamp: '2026-06-13T00:02:00.000Z',
        },
      });
      return {
        ledger: refreshActiveConflictAdjudicationSnapshots({
          ledger: changed,
          originStep: 'reviewers',
          createdAt: OBSERVATION,
        }),
        result: undefined,
      };
    });

    const afterObservation = freshConflictAdjudicationSnapshot(
      ledgerStore.loadLedger(),
      'C-FA2947446963',
    );
    expect(afterObservation.conflictSnapshotId).not.toBe(originalSnapshot.conflictSnapshotId);
    expect(isActiveConflictUnadjudicated(ledgerStore.loadLedger(), 'C-FA2947446963')).toBe(false);

    executeAgentMock.mockClear();
    const second = runner();
    await second.runner.run(second.step, state());

    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(ledgerStore.loadLedger().conflictAdjudicationSnapshots).toHaveLength(2);
    expect(ledgerStore.loadLedger().conflictAdjudicationAttempts).toHaveLength(2);
  });

  it('re-adjudicates a non-regular target even when its content digest is unavailable', async () => {
    rmSync(join(cwd, 'src', 'a.ts'));
    writeFileSync(join(cwd, 'src', 'target.ts'), 'export const value = true;\n');
    symlinkSync('target.ts', join(cwd, 'src', 'a.ts'));
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: { invalid: true },
      timestamp: new Date(),
    });

    const first = runner();
    await first.runner.run(first.step, state());
    const firstSnapshot = freshConflictAdjudicationSnapshot(
      ledgerStore.loadLedger(),
      'C-FA2947446963',
    );
    expect(firstSnapshot.targetContentDigests).toEqual([
      expect.objectContaining({ kind: 'symlink', contentDigest: null }),
    ]);
    expect(hasAlwaysChangingConflictTarget(firstSnapshot)).toBe(true);
    expect(isActiveConflictUnadjudicated(ledgerStore.loadLedger(), 'C-FA2947446963')).toBe(true);

    const second = runner();
    await second.runner.run(second.step, state());

    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    expect(ledgerStore.loadLedger().conflictAdjudicationAttempts).toHaveLength(2);
  });

  it('keeps the adjudication wire bounded when durable snapshot collections grow', async () => {
    const snapshot = freshConflictAdjudicationSnapshot(
      ledgerStore.loadLedger(),
      'C-FA2947446963',
    );
    const inflated = structuredClone(snapshot);
    inflated.subjects = inflated.subjects.map((subject, subjectIndex) => ({
      ...subject,
      sourceRawFindingIds: Array.from({ length: 4096 }, (_, index) => `${subjectIndex}-raw-${index}`),
      sourceRawPayloadDigests: Array.from({ length: 4096 }, (_, index) => `${subjectIndex}-payload-${index}`),
      evidenceBindingIds: Array.from({ length: 4096 }, (_, index) => `${subjectIndex}-binding-${index}`),
      rawClaimLandingIds: subject.role === 'holding_provisional'
        ? Array.from({ length: 4096 }, (_, index) => `${subjectIndex}-landing-${index}`)
        : [],
    }));

    const observedAt = {
      runId: 'history-test',
      stepName: 'reviewers',
      timestamp: '2026-08-08T00:00:00.000Z',
    };
    const historyValues = {
      sourceRawFindingIds: inflated.subjects.flatMap(({ sourceRawFindingIds }) => sourceRawFindingIds),
      sourceRawPayloadDigests: inflated.subjects.flatMap(({ sourceRawPayloadDigests }) => sourceRawPayloadDigests),
      evidenceBindingIds: inflated.subjects.flatMap(({ evidenceBindingIds }) => evidenceBindingIds),
      rawClaimLandingIds: [
        ...inflated.rawClaimLandingIds,
        ...inflated.subjects.flatMap(({ rawClaimLandingIds }) => rawClaimLandingIds),
      ],
      priorSettlementIds: inflated.priorSettlementIds,
    } as const;
    const history = Object.fromEntries(
      Object.entries(historyValues).map(([key, values]) => [
        key,
        new Map(values.map((value) => [value, observedAt] as const)),
      ]),
    ) as ConflictAdjudicationHistoryOrder;
    const instruction = renderConflictAdjudicationInstruction(inflated, history);

    expect(Buffer.byteLength(instruction, 'utf8'))
      .toBeLessThanOrEqual(MANAGER_INTERPRETATION_LIMITS.maxInputBytesPerCall);
    expect(instruction).toContain('"snapshotFormat": "reference-v1"');
    expect(instruction).toContain('sourceRawFindingCount');
    expect(instruction).toContain('sourceRawFindingIds');
    expect(instruction).toContain('sourceRawPayloadCount');
    expect(instruction).toContain('sourceRawPayloadIds');
    expect(instruction).toContain('0-raw-999');
    expect(instruction).toContain('evidenceBindingIds');
  });

  it('re-adjudicates once with digest-bound target windows and applies a verified result', async () => {
    const ledger = ledgerStore.loadLedger();
    const snapshot = freshConflictAdjudicationSnapshot(ledger, 'C-FA2947446963');
    const holding = snapshot.subjects.find(({ role }) => role === 'holding_provisional')!;
    const proof = createEngineProofRecord({
      kind: 'engine_proof',
      purpose: 'lifecycle_authority',
      verifierId: 'takt.finding-lifecycle-policy',
      verifierVersion: '1',
      workflowName: ledger.workflowName,
      runId: 'run-1',
      scopeIdentity: SCOPE_IDENTITY,
      snapshotId: snapshot.conflictSnapshotId,
      claimIdentityHash: null,
      targetFindingId: holding.findingId,
      subject: {
        kind: 'finding_no_issue_after_verification',
        adjudicationKind: 'conflict',
        subjectId: holding.subjectId,
        findingId: holding.findingId,
        expectedHead: holding.expectedHead,
        claimSnapshotDigest: holding.claimSnapshotDigest,
        rawClaimRefIds: holding.rawClaimLandingIds,
      },
      dependencyDigests: [snapshot.conflictSnapshotId],
      resultDigest: '3'.repeat(64),
      issuedAt: OBSERVATION.timestamp,
    });
    await ledgerStore.updateLedger((current) => ({
      ledger: { ...current, evidenceRecords: [...current.evidenceRecords, proof] },
      result: undefined,
    }));
    const undetermined = {
      persona: 'supervisor' as const,
      status: 'done' as const,
      content: '{}',
      structuredOutput: {
        proposal: {
          kind: 'undetermined' as const,
          subjectIds: snapshot.subjects.map(({ subjectId }) => subjectId).sort(),
          rationale: 'No verified terminal authority is available.',
        },
      },
      timestamp: new Date(),
    };
    executeAgentMock
      .mockResolvedValueOnce(undetermined)
      .mockResolvedValueOnce({
        persona: 'supervisor',
        status: 'done',
        content: '{}',
        structuredOutput: {
          proposal: {
            kind: 'terminate_subject',
            subjectId: holding.subjectId,
            basis: 'finding_no_issue_after_verification',
            authorityRefIds: [proof.evidenceId],
            rationale: 'The target window and engine proof support termination.',
          },
        },
        timestamp: new Date(),
      });

    const target = runner();
    await target.runner.run(target.step, state());

    const applied = ledgerStore.loadLedger();
    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    expect(executeAgentMock.mock.calls[0]?.[1]).not.toContain('Engine-provided target snapshot windows');
    expect(executeAgentMock.mock.calls[1]?.[1]).toContain('Engine-provided target snapshot windows');
    expect(executeAgentMock.mock.calls[1]?.[1]).toContain('reviewScopeSnapshotId:');
    expect(executeAgentMock.mock.calls[1]?.[1]).toContain('[FILE src/a.ts lines 1-1]');
    expect(applied.conflictAdjudicationAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ attemptOrdinal: 1, result: expect.objectContaining({ kind: 'verification_undetermined' }) }),
      expect.objectContaining({ attemptOrdinal: 2, stage: 'applied' }),
    ]));
    expect(applied.conflictClaimSettlements).toEqual([
      expect.objectContaining({ outcome: 'resolved' }),
    ]);
    expect(applied.conflicts[0]).toMatchObject({ status: 'resolved' });
  });

  it('places configured guidance once before the engine-owned conflict instruction', async () => {
    const snapshot = freshConflictAdjudicationSnapshot(
      ledgerStore.loadLedger(),
      'C-FA2947446963',
    );
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        proposal: {
          kind: 'undetermined',
          subjectIds: snapshot.subjects.map(({ subjectId }) => subjectId).sort(),
          rationale: 'No verified terminal authority is available.',
        },
      },
      timestamp: new Date(),
    });
    const target = runner('Use only exact conflict evidence.');

    await target.runner.run(target.step, state());

    const prompt = executeAgentMock.mock.calls[0]?.[1];
    expect(prompt).toContain('Use only exact conflict evidence.\n\n---\n\nAdjudicate the durable finding conflict snapshot below.');
    expect(prompt?.match(/Use only exact conflict evidence\./g)).toHaveLength(1);
  });

  it('stores malformed output as a diagnostic attempt without a legacy adjudication record', async () => {
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: { outcome: 'finding_stale' },
      timestamp: new Date(),
    });
    const target = runner();

    await target.runner.run(target.step, state());
    const ledger = ledgerStore.loadLedger();

    expect(ledger.conflicts[0]).not.toHaveProperty('adjudications');
    expect(ledger.conflictAdjudicationAttempts).toEqual([
      expect.objectContaining({
        stage: 'completed',
        result: expect.objectContaining({ kind: 'diagnostic_undetermined', code: 'parse_failed' }),
      }),
    ]);
    expect(ledger.conflictClaimSettlements).toEqual([]);
  });

  it('applies a verified holding termination and records exact claim settlement ownership', async () => {
    const ledger = ledgerStore.loadLedger();
    const snapshot = freshConflictAdjudicationSnapshot(ledger, 'C-FA2947446963');
    const holding = snapshot.subjects.find(({ role }) => role === 'holding_provisional')!;
    const proof = createEngineProofRecord({
      kind: 'engine_proof',
      purpose: 'lifecycle_authority',
      verifierId: 'takt.finding-lifecycle-policy',
      verifierVersion: '1',
      workflowName: ledger.workflowName,
      runId: 'run-1',
      scopeIdentity: SCOPE_IDENTITY,
      snapshotId: snapshot.conflictSnapshotId,
      claimIdentityHash: null,
      targetFindingId: holding.findingId,
      subject: {
        kind: 'finding_no_issue_after_verification',
        adjudicationKind: 'conflict',
        subjectId: holding.subjectId,
        findingId: holding.findingId,
        expectedHead: holding.expectedHead,
        claimSnapshotDigest: holding.claimSnapshotDigest,
        rawClaimRefIds: holding.rawClaimLandingIds,
      },
      dependencyDigests: [snapshot.conflictSnapshotId],
      resultDigest: '3'.repeat(64),
      issuedAt: OBSERVATION.timestamp,
    });
    await ledgerStore.updateLedger((current) => ({
      ledger: { ...current, evidenceRecords: [...current.evidenceRecords, proof] },
      result: undefined,
    }));
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        proposal: {
          kind: 'terminate_subject',
          subjectId: holding.subjectId,
          basis: 'finding_no_issue_after_verification',
          authorityRefIds: [proof.evidenceId],
          rationale: 'The held raw claim was refuted by an exact verifier.',
        },
      },
      timestamp: new Date(),
    });
    const target = runner();

    await target.runner.run(target.step, state());
    const applied = ledgerStore.loadLedger();

    expect(applied.conflictAdjudicationAttempts).toEqual([
      expect.objectContaining({ stage: 'applied', claimSettlementIds: [expect.any(String)] }),
    ]);
    expect(applied.conflictClaimSettlements).toEqual([
      expect.objectContaining({
        conflictSnapshotId: snapshot.conflictSnapshotId,
        subjectId: holding.subjectId,
        outcome: 'resolved',
      }),
    ]);
    expect(applied.conflicts[0]).not.toHaveProperty('adjudications');
  });

  it('resumes the same real conflict WAL reservation after reopening the store', async () => {
    const guidance = 'Use the configured conflict policy.';
    const crashingStore = crashAfterAdjudicationReservation({
      store: ledgerStore,
      purpose: 'conflict_adjudication',
      errorMessage: 'simulated crash after conflict WAL reservation',
    });
    const crashingTarget = runner(guidance, crashingStore);
    await expect(crashingTarget.runner.run(crashingTarget.step, state()))
      .rejects.toThrow('simulated crash after conflict WAL reservation');
    const reserved = ledgerStore.loadLedger().findingManagerProviderCalls[0]!;
    expect(reserved.state).toBe('reserved');

    ledgerStore = reopenStore();
    const snapshot = freshConflictAdjudicationSnapshot(
      ledgerStore.loadLedger(),
      'C-FA2947446963',
    );
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        proposal: {
          kind: 'undetermined',
          subjectIds: snapshot.subjects.map(({ subjectId }) => subjectId).sort(),
          rationale: 'No authority.',
        },
      },
      timestamp: new Date(OBSERVATION.timestamp),
    });
    const resumedTarget = runner(guidance, ledgerStore);
    await resumedTarget.runner.run(resumedTarget.step, state());

    expect(ledgerStore.loadLedger().findingManagerProviderCalls[0]).toMatchObject({
      providerCallId: reserved.providerCallId,
      requestDigest: reserved.requestDigest,
      requestByteLength: reserved.requestByteLength,
      state: 'settled',
      resultKind: 'accepted',
    });
    expect(executeAgentMock).toHaveBeenCalledTimes(2);
  });

  it('replays the exact request after a crash following provider dispatch', async () => {
    const crashingStore = new Proxy(ledgerStore, {
      get(target, property, receiver) {
        if (property !== 'updateLedger') {
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (...args: Parameters<FindingLedgerStore['updateLedger']>) => {
          const mutation = await target.updateLedger(...args);
          const dispatched = mutation.ledger.findingManagerProviderCalls.some((call) => (
            call.purpose === 'conflict_adjudication' && call.state === 'dispatched'
          ));
          if (dispatched) {
            throw new Error('simulated crash after conflict provider dispatch');
          }
          return mutation;
        };
      },
    });
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'error',
      content: 'provider failed after replay',
      error: 'provider failed after replay',
      timestamp: new Date(OBSERVATION.timestamp),
    });
    const crashingTarget = runner('Persist this exact request.', crashingStore);
    await expect(crashingTarget.runner.run(crashingTarget.step, state()))
      .rejects.toThrow('simulated crash after conflict provider dispatch');
    const dispatched = ledgerStore.loadLedger().findingManagerProviderCalls[0]!;
    expect(dispatched.state).toBe('dispatched');
    expect(dispatched.requestBytes).toBeTypeOf('string');
    expect(dispatched.requestBytes).not.toContain('providerOptions');
    expect(dispatched.requestBytes).not.toContain('resolvedProviderOptions');
    const savedInstruction = JSON.parse(dispatched.requestBytes!) as { phase1Instruction: string };

    executeAgentMock.mockClear();
    ledgerStore = reopenStore();
    const resumedTarget = runner('Changed guidance must not replace the dispatched request.', ledgerStore);
    await resumedTarget.runner.run(resumedTarget.step, state());

    expect(executeAgentMock).toHaveBeenCalledOnce();
    expect(executeAgentMock.mock.calls[0]![1]).toBe(savedInstruction.phase1Instruction);
    expect(ledgerStore.loadLedger().findingManagerProviderCalls[0]).toMatchObject({
      providerCallId: dispatched.providerCallId,
      state: 'settled',
    });
  });

  it('releases an un-dispatched reservation when the conflict snapshot changes', async () => {
    let current = ledgerStore.loadLedger();
    const store = {
      ledgerIdentity: SCOPE_IDENTITY,
      runId: 'run-1',
      workflowName: 'runner-test',
      loadLedger: () => current,
      updateLedger: async <Result>(mutator: (ledger: FindingLedger) => {
        ledger: FindingLedger;
        result: Result;
      }) => {
        const mutation = mutator(current);
        current = mutation.ledger;
        return mutation;
      },
    } as unknown as FindingLedgerStore;
    const originalSnapshot = freshConflictAdjudicationSnapshot(current, 'C-FA2947446963');
    const first = await reserveFindingConflictAdjudication({
      ledgerStore: store,
      conflictId: 'C-FA2947446963',
      expectedSnapshotId: originalSnapshot.conflictSnapshotId,
      requestedOriginStep: undefined,
      observation: OBSERVATION,
      requestBytes: 'original-request',
      scopeIdentity: SCOPE_IDENTITY,
      workflowName: 'runner-test',
      roundMarker: 'round-1',
    });
    const changedSnapshot = buildConflictAdjudicationSnapshot({
      ledger: first.ledger,
      conflictId: 'C-FA2947446963',
      originStep: 'changed-snapshot-origin',
      createdAt: OBSERVATION,
    });
    current = {
      ...first.ledger,
      conflictAdjudicationSnapshots: [changedSnapshot],
    };

    const resumed = await reserveFindingConflictAdjudication({
      ledgerStore: store,
      conflictId: 'C-FA2947446963',
      expectedSnapshotId: changedSnapshot.conflictSnapshotId,
      requestedOriginStep: undefined,
      observation: OBSERVATION,
      requestBytes: 'rebuilt-request',
      scopeIdentity: SCOPE_IDENTITY,
      workflowName: 'runner-test',
      roundMarker: 'round-2',
    });

    expect(resumed.result.started).toBe(true);
    expect(current.findingManagerProviderCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'released', requestBytes: 'original-request' }),
      expect.objectContaining({ state: 'reserved', requestBytes: 'rebuilt-request' }),
    ]));
    expect(current.conflictAdjudicationAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'interrupted', reason: 'reservation_released' }),
      expect.objectContaining({ stage: 'started', conflictSnapshotId: changedSnapshot.conflictSnapshotId }),
    ]));
  });

  it('replays a grounded reservation after a crash before its provider call', async () => {
    const snapshot = freshConflictAdjudicationSnapshot(
      ledgerStore.loadLedger(),
      'C-FA2947446963',
    );
    const undetermined = {
      persona: 'supervisor',
      status: 'done' as const,
      content: '{}',
      structuredOutput: {
        proposal: {
          kind: 'undetermined' as const,
          subjectIds: snapshot.subjects.map(({ subjectId }) => subjectId).sort(),
          rationale: 'No authority.',
        },
      },
      timestamp: new Date(OBSERVATION.timestamp),
    };
    executeAgentMock.mockResolvedValue(undetermined);
    let crashed = false;
    const crashingStore = new Proxy(ledgerStore, {
      get(target, property, receiver) {
        if (property !== 'updateLedger') {
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (...args: Parameters<FindingLedgerStore['updateLedger']>) => {
          const mutation = await target.updateLedger(...args);
          const groundingReserved = mutation.ledger.conflictAdjudicationAttempts.some((attempt) => (
            attempt.stage === 'started' && attempt.attemptOrdinal === 2
          ));
          if (!crashed && groundingReserved) {
            crashed = true;
            throw new Error('simulated crash after grounded conflict WAL reservation');
          }
          return mutation;
        };
      },
    });
    const crashingTarget = runner(undefined, crashingStore);
    await expect(crashingTarget.runner.run(crashingTarget.step, state()))
      .rejects.toThrow('simulated crash after grounded conflict WAL reservation');

    const reservedAttempt = ledgerStore.loadLedger().conflictAdjudicationAttempts.find(
      (attempt) => attempt.attemptOrdinal === 2,
    );
    const reservedCall = ledgerStore.loadLedger().findingManagerProviderCalls.find(
      (call) => call.providerCallId === reservedAttempt?.providerCallId,
    );
    expect(reservedAttempt?.stage).toBe('started');
    expect(reservedCall?.state).toBe('reserved');
    executeAgentMock.mockClear();
    ledgerStore = reopenStore();

    const resumedTarget = runner(undefined, ledgerStore);
    await resumedTarget.runner.run(resumedTarget.step, state());

    const replayedCall = ledgerStore.loadLedger().findingManagerProviderCalls.find(
      (call) => call.providerCallId === reservedCall?.providerCallId,
    );
    expect(replayedCall).toMatchObject({
      providerCallId: reservedCall?.providerCallId,
      requestDigest: reservedCall?.requestDigest,
      state: 'settled',
    });
    expect(executeAgentMock).toHaveBeenCalledOnce();
  });

  it('rebuilds a released second attempt without consuming its ordinal', async () => {
    const snapshot = freshConflictAdjudicationSnapshot(
      ledgerStore.loadLedger(),
      'C-FA2947446963',
    );
    const undetermined = {
      persona: 'supervisor' as const,
      status: 'done' as const,
      content: '{}',
      structuredOutput: {
        proposal: {
          kind: 'undetermined' as const,
          subjectIds: snapshot.subjects.map(({ subjectId }) => subjectId).sort(),
          rationale: 'No authority.',
        },
      },
      timestamp: new Date(OBSERVATION.timestamp),
    };
    executeAgentMock.mockResolvedValueOnce(undetermined);
    let crashed = false;
    const crashingStore = new Proxy(ledgerStore, {
      get(target, property, receiver) {
        if (property !== 'updateLedger') {
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (...args: Parameters<FindingLedgerStore['updateLedger']>) => {
          const mutation = await target.updateLedger(...args);
          const groundedReservation = mutation.ledger.conflictAdjudicationAttempts.some((attempt) => (
            attempt.stage === 'started' && attempt.attemptOrdinal === 2
          ));
          if (!crashed && groundedReservation) {
            crashed = true;
            throw new Error('simulated crash after second conflict WAL reservation');
          }
          return mutation;
        };
      },
    });
    const crashingTarget = runner('Original guidance.', crashingStore);
    await expect(crashingTarget.runner.run(crashingTarget.step, state()))
      .rejects.toThrow('simulated crash after second conflict WAL reservation');

    ledgerStore = reopenStore();
    executeAgentMock.mockClear();
    executeAgentMock.mockResolvedValue(undetermined);
    const resumedTarget = runner('Changed guidance.', ledgerStore);
    await resumedTarget.runner.run(resumedTarget.step, state());

    const ledger = ledgerStore.loadLedger();
    expect(ledger.conflictAdjudicationAttempts).toHaveLength(2);
    expect(ledger.conflictAdjudicationAttempts.map(({ attemptOrdinal }) => attemptOrdinal))
      .toEqual([1, 2]);
    expect(ledger.conflictAdjudicationAttempts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({
        stage: 'interrupted',
        reason: 'reservation_released',
      })]),
    );
    expect(ledger.findingManagerProviderCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'released' }),
      expect.objectContaining({ state: 'settled' }),
    ]));
    expect(executeAgentMock).toHaveBeenCalledOnce();
  });

  it('releases a reserved call when its request digest changes and rebuilds the reservation', async () => {
    const crashingStore = crashAfterAdjudicationReservation({
      store: ledgerStore,
      purpose: 'conflict_adjudication',
      errorMessage: 'simulated crash after conflict WAL reservation',
    });
    const crashingTarget = runner('Original guidance.', crashingStore);
    await expect(crashingTarget.runner.run(crashingTarget.step, state()))
      .rejects.toThrow('simulated crash after conflict WAL reservation');
    const reserved = ledgerStore.loadLedger().findingManagerProviderCalls[0]!;
    ledgerStore = reopenStore();
    const changedTarget = runner('Changed guidance.', ledgerStore);
    executeAgentMock.mockImplementation(async () => {
      const snapshot = freshConflictAdjudicationSnapshot(ledgerStore.loadLedger(), 'C-FA2947446963');
      return {
        persona: 'supervisor',
        status: 'done' as const,
        content: '{}',
        structuredOutput: {
          proposal: {
            kind: 'undetermined' as const,
            subjectIds: snapshot.subjects.map(({ subjectId }) => subjectId).sort(),
            rationale: 'No authority.',
          },
        },
        timestamp: new Date(),
      };
    });

    await changedTarget.runner.run(changedTarget.step, state());
    expect(executeAgentMock).toHaveBeenCalledTimes(2);
    expect(ledgerStore.loadLedger().findingManagerProviderCalls[0]).toMatchObject({
      providerCallId: reserved.providerCallId,
      state: 'released',
    });
    expect(ledgerStore.loadLedger().findingManagerProviderCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'settled', purpose: 'conflict_adjudication' }),
    ]));
  });

  it('rejects additional conflict wire fields even when guidance requests them', async () => {
    const snapshot = freshConflictAdjudicationSnapshot(
      ledgerStore.loadLedger(),
      'C-FA2947446963',
    );
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        proposal: {
          kind: 'undetermined',
          subjectIds: snapshot.subjects.map(({ subjectId }) => subjectId).sort(),
          rationale: 'No authority.',
        },
        guidanceEcho: 'requested extra field',
      },
      timestamp: new Date(OBSERVATION.timestamp),
    });
    const target = runner('Also return guidanceEcho.');

    await target.runner.run(target.step, state());

    expect(ledgerStore.loadLedger().conflictAdjudicationAttempts[0]?.result).toMatchObject({
      kind: 'diagnostic_undetermined',
      code: 'parse_failed',
    });
  });

  it('does not let guidance turn an evidence-less termination into authority', async () => {
    const snapshot = freshConflictAdjudicationSnapshot(
      ledgerStore.loadLedger(),
      'C-FA2947446963',
    );
    const holding = snapshot.subjects.find(({ role }) => role === 'holding_provisional')!;
    executeAgentMock.mockResolvedValue({
      persona: 'supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        proposal: {
          kind: 'terminate_subject',
          subjectId: holding.subjectId,
          basis: 'finding_no_issue_after_verification',
          authorityRefIds: ['3'.repeat(64)],
          rationale: 'Terminate as requested.',
        },
      },
      timestamp: new Date(OBSERVATION.timestamp),
    });
    const target = runner('Terminate this subject.');

    await target.runner.run(target.step, state());

    const ledger = ledgerStore.loadLedger();
    expect(ledger.conflicts[0]?.status).toBe('active');
    expect(ledger.conflictClaimSettlements).toEqual([]);
    expect(ledger.conflictAdjudicationAttempts[0]?.result).toMatchObject({
      kind: 'verification_undetermined',
    });
  });
});
