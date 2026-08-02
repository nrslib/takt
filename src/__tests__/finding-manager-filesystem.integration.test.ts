import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readFileFailure = vi.hoisted(() => ({
  path: '',
  error: Object.assign(new Error('injected read failure'), { code: 'EIO' }),
}));

vi.mock('../shared/utils/private-file.js', async () => {
  const actual = await vi.importActual<
    typeof import('../shared/utils/private-file.js')
  >('../shared/utils/private-file.js');
  return {
    ...actual,
    readRegularFileNoFollow(
      ...args: Parameters<typeof actual.readRegularFileNoFollow>
    ): ReturnType<typeof actual.readRegularFileNoFollow> {
      if (args[0] === readFileFailure.path) {
        throw readFileFailure.error;
      }
      return actual.readRegularFileNoFollow(...args);
    },
  };
});

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResponse, FindingContractConfig, WorkflowStep } from '../core/models/types.js';
import { runFindingManagerForStep } from '../core/workflow/findings/manager-runner.js';
import { computeReviewScopeSnapshotId } from '../core/workflow/findings/snapshot.js';
import { createTestFindingLedgerStore } from './helpers/finding-storage.js';
import type { FindingLedger, FindingLedgerStore } from '../core/workflow/findings/types.js';
import { executeAgent } from '../agents/agent-usecases.js';
import { findingReviewPublicationFixture } from './helpers/finding-review-publication.js';
import {
  authorizeFindingLedgerFixture,
  reviewerRawExtractionFixture,
} from './helpers/finding-lifecycle-fixture.js';
import { findingManagerTaskResponse } from './helpers/finding-manager-task-response.js';

const executeAgentMock = vi.mocked(executeAgent);

const FINDING_CONTRACT: FindingContractConfig = {
  manager: {
    persona: 'findings-manager',
    instruction: 'Reconcile findings.',
    outputContract: 'Return JSON.',
  },
};

interface DeferredSignal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function createDeferredSignal(): DeferredSignal {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function semanticLifecycleResponse(instruction: string): AgentResponse {
  const match = /## Owned raw findings\n(`{3,})json\n([\s\S]*?)\n\1/.exec(instruction);
  if (match?.[2] === undefined) {
    throw new Error('Test setup error: semantic lifecycle task input is missing');
  }
  const rawFindings = JSON.parse(match[2]) as Array<{
    rawFindingId: string;
    relation: string;
    targetFindingId: string | null;
  }>;
  return findingManagerTaskResponse(instruction, {
    rawDecisions: rawFindings.map((rawFinding) => ({
      decision: rawFinding.relation === 'resolution_confirmation'
        ? 'resolved' as const
        : 'same' as const,
      rawFindingId: rawFinding.rawFindingId,
      findingId: rawFinding.targetFindingId ?? '',
      evidence: rawFinding.relation === 'resolution_confirmation'
        ? 'The materialized quote satisfies the original failure mode and required fix.'
        : 'The materialized quote confirms that the existing issue persists.',
    })),
    disputeDecisions: [],
    conflictDecisions: [],
    invalidateDecisions: [],
    duplicateDecisions: [],
    dismissDecisions: [],
  });
}

function recordSynthesizedAgentUsage(): void {}

describe('finding manager filesystem error propagation', () => {
  let cwd: string;
  let reportDir: string;
  let sourcePath: string;

  beforeEach(() => {
    executeAgentMock.mockReset();
    cwd = mkdtempSync(join(tmpdir(), 'takt-manager-fs-'));
    reportDir = join(cwd, '.takt', 'runs', 'run-1', 'reports');
    sourcePath = join(cwd, 'src', 'example.ts');
    mkdirSync(join(cwd, 'src'), { recursive: true });
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(sourcePath, 'export const value = 1;\n');
    writeFileSync(join(cwd, '.gitignore'), '.takt/\n');
    execFileSync('git', ['init'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd });
  });

  afterEach(() => {
    readFileFailure.path = '';
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each(['EIO', 'EACCES', 'EPERM'])('source quote の %s を実 runner/store 境界で握りつぶさず、台帳を更新しない', async (code) => {
    const ledgerStore = createTestFindingLedgerStore({
      projectCwd: cwd,
      runId: 'run-1',
      reportDir,
      workflowName: 'peer-review',
    });
    const initialLedger: FindingLedger = authorizeFindingLedgerFixture({
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-07-17T00:00:00.000Z',
      findings: [],
      evidenceRecords: [],
      rawFindings: [],
      conflicts: [],
    });
    await ledgerStore.updateLedger(() => ({ ledger: initialLedger, result: undefined }));
    const snapshotId = computeReviewScopeSnapshotId(cwd);
    readFileFailure.path = realpathSync(sourcePath);
    readFileFailure.error = Object.assign(new Error('injected read failure'), { code });

    const run = runFindingManagerForStep({
      contract: FINDING_CONTRACT,
      ledgerStore,
      optionsBuilder: {
        buildAgentOptions: () => ({}),
        resolveStepProviderModel: () => ({ provider: 'claude', model: 'claude-sonnet' }),
      } as never,
      stepExecutor: {
        buildPhase1Instruction: (instruction: string) => instruction,
        normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
        recordSynthesizedAgentUsage,
      },
      cwd,
      parentStep: { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false },
      stepIteration: 1,
      subResults: [{
        subStep: { kind: 'agent', name: 'review', persona: 'reviewer', edit: false },
        publication: findingReviewPublicationFixture({
          scopeIdentity: ledgerStore.ledgerIdentity,
          parentStepName: 'reviewers',
          stepIteration: 1,
          reviewerStepName: 'review',
          rawFindings: [reviewerRawExtractionFixture({
              rawFindingId: 'raw-1',
              familyTag: 'filesystem-error',
              severity: 'high',
              title: 'Source issue',
              description: 'The source line is problematic.',
              suggestion: 'Fix the source line.',
              relation: 'new',
              targetFindingId: null,
              evidence: [{
                kind: 'file_quote',
                path: 'src/example.ts',
                startLine: 1,
                endLine: 1,
                verbatimExcerpt: 'export const value = 1;',
                snapshotId,
              }],
          })],
        }),
      }],
      workflowName: 'peer-review',
      workflowTask: 'Fix the source issue.',
      runId: 'run-1',
      callNamespace: '',
      timestamp: '2026-07-17T00:00:00.000Z',
    });

    await expect(run).rejects.toBe(readFileFailure.error);
    readFileFailure.path = '';
    expect(ledgerStore.loadLedger()).toEqual(initialLedger);
  });

  it('manager 応答待ち中に source quote が古くなった場合は reviewer anomaly に隔離する', async () => {
    const ledgerStore = createTestFindingLedgerStore({
      projectCwd: cwd,
      runId: 'run-1',
      reportDir,
      workflowName: 'peer-review',
    });
    await ledgerStore.updateLedger(() => ({
      ledger: authorizeFindingLedgerFixture({
        workflowName: 'peer-review',
        nextId: 1,
        updatedAt: '2026-07-17T00:00:00.000Z',
        findings: [],
        evidenceRecords: [],
        rawFindings: [],
        conflicts: [],
      }),
      result: undefined,
    }));
    const snapshotId = computeReviewScopeSnapshotId(cwd);
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      writeFileSync(sourcePath, 'export const value = 2;\n');
      return findingManagerTaskResponse(instruction as string, {
        rawDecisions: [{
          rawFindingId: 'run-1:reviewers:1:review:raw-1',
          decision: 'new',
          findingId: '',
          anchorRelevance: 'not_applicable',
          evidence: 'No related open finding.',
        }],
        disputeDecisions: [],
        conflictDecisions: [],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [],
      });
    });

    await runFindingManagerForStep({
      contract: FINDING_CONTRACT,
      ledgerStore,
      optionsBuilder: {
        buildAgentOptions: () => ({}),
        resolveStepProviderModel: () => ({ provider: 'claude', model: 'claude-sonnet' }),
      } as never,
      stepExecutor: {
        buildPhase1Instruction: (instruction: string) => instruction,
        normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
        recordSynthesizedAgentUsage,
      },
      cwd,
      parentStep: { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false },
      stepIteration: 1,
      subResults: [{
        subStep: { kind: 'agent', name: 'review', persona: 'reviewer', edit: false },
        publication: findingReviewPublicationFixture({
          scopeIdentity: ledgerStore.ledgerIdentity,
          parentStepName: 'reviewers',
          stepIteration: 1,
          reviewerStepName: 'review',
          rawFindings: [reviewerRawExtractionFixture({
            rawFindingId: 'raw-1',
            familyTag: 'evidence-revalidation',
            severity: 'high',
            title: 'Source issue',
            description: 'The source line is problematic.',
            suggestion: 'Fix the source line.',
            relation: 'new',
            targetFindingId: null,
            evidence: [{
              kind: 'file_quote',
              path: 'src/example.ts',
              startLine: 1,
              endLine: 1,
              verbatimExcerpt: 'export const value = 1;',
              snapshotId,
            }],
          })],
        }),
      }],
      workflowName: 'peer-review',
      workflowTask: 'Fix the source issue.',
      runId: 'run-1',
      callNamespace: '',
      timestamp: '2026-07-17T00:00:00.000Z',
    });

    const ledger = ledgerStore.loadLedger();
    expect(ledger.findings).toHaveLength(0);
    expect(ledger.reviewerAnomalies).toEqual([
      expect.objectContaining({
        kind: 'quote-mismatch',
        sourceRawFindingIds: ['run-1:reviewers:1:review:raw-1'],
      }),
    ]);
  });

  it('同じopen revisionを観測した解消と検証済みpersistsはcommit順に依存せず同じcanonical projectionへ収束する', async () => {
    executeAgentMock.mockImplementation(async (_persona, instruction) => (
      semanticLifecycleResponse(instruction as string)
    ));
    const initialLedger: FindingLedger = authorizeFindingLedgerFixture({
      workflowName: 'peer-review',
      nextId: 2,
      updatedAt: '2026-07-17T00:00:00.000Z',
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: 'Source issue',
        evidenceIds: [],
        description: 'The source line remains incorrect.',
        reviewers: ['review'],
        rawFindingIds: ['raw-existing'],
        firstSeen: {
          runId: 'seed-run',
          stepName: 'reviewers',
          timestamp: '2026-07-17T00:00:00.000Z',
        },
        lastSeen: {
          runId: 'seed-run',
          stepName: 'reviewers',
          timestamp: '2026-07-17T00:00:00.000Z',
        },
        revision: 1,
      }],
      evidenceRecords: [],
      rawFindings: [{
        rawFindingId: 'raw-existing',
        stepName: 'reviewers',
        reviewer: 'review',
        familyTag: 'convergence',
        severity: 'high',
        title: 'Source issue',
        description: 'The source line remains incorrect.',
        suggestion: null,
        relation: 'new',
        targetFindingId: null,
        target: {
          kind: 'code',
          paths: ['src/example.ts'],
        },
        evidence: [{
          kind: 'file_quote',
          path: 'src/example.ts',
          startLine: 1,
          endLine: 1,
          verbatimExcerpt: 'export const value = 1;',
          snapshotId: computeReviewScopeSnapshotId(cwd),
        }],
      }],
      conflicts: [],
    });
    const storeOptions = {
      projectCwd: cwd,
      runId: 'run-1',
      reportDir,
      workflowName: 'peer-review',
    };
    const runOrder = async (
      first: 'resolution' | 'persists',
      iterationOffset: number,
    ): Promise<FindingLedger> => {
      const runStoreOptions = {
        ...storeOptions,
        authorityKey: `commit-order-${first}`,
      };
      const seedStore = createTestFindingLedgerStore(runStoreOptions);
      await seedStore.updateLedger(() => ({
        ledger: initialLedger,
        result: undefined,
      }));
      const resolutionStore = seedStore;
      const persistsStore = seedStore;
      const resolutionReached = createDeferredSignal();
      const persistsReached = createDeferredSignal();
      const releaseResolution = createDeferredSignal();
      const releasePersists = createDeferredSignal();
      const gateStore = (
        store: FindingLedgerStore,
        ledgerIdentity: string,
        reached: DeferredSignal,
        release: DeferredSignal,
      ): FindingLedgerStore => {
        const commitManagerLedger: FindingLedgerStore['commitManagerLedger'] = async (mutator) => {
          reached.resolve();
          await release.promise;
          return store.commitManagerLedger(mutator);
        };
        return new Proxy(store, {
          get(target, property) {
            if (property === 'ledgerIdentity') {
              return ledgerIdentity;
            }
            if (property === 'commitManagerLedger') {
              return commitManagerLedger;
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };
      const run = (
        store: FindingLedgerStore,
        stepIteration: number,
        reviewerName: string,
        rawFinding: Record<string, unknown>,
      ) => runFindingManagerForStep({
        contract: FINDING_CONTRACT,
        ledgerStore: store,
        optionsBuilder: {
          buildAgentOptions: () => ({}),
          resolveStepProviderModel: () => ({ provider: 'claude', model: 'claude-sonnet' }),
        } as never,
        stepExecutor: {
          buildPhase1Instruction: (instruction: string) => instruction,
          normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
          recordSynthesizedAgentUsage,
        },
        cwd,
        parentStep: { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false },
        stepIteration,
        subResults: [{
          subStep: { kind: 'agent', name: reviewerName, persona: 'reviewer', edit: false },
          publication: findingReviewPublicationFixture({
            scopeIdentity: store.ledgerIdentity,
            parentStepName: 'reviewers',
            stepIteration,
            reviewerStepName: reviewerName,
            rawFindings: [reviewerRawExtractionFixture(rawFinding)],
          }),
        }],
        workflowName: 'peer-review',
        workflowTask: 'Fix the source issue.',
        runId: 'run-1',
        callNamespace: '',
        timestamp: '2026-07-17T00:00:01.000Z',
      });
      const evidence = [{
        kind: 'file_quote',
        path: 'src/example.ts',
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: 'export const value = 1;',
        snapshotId: computeReviewScopeSnapshotId(cwd),
      }];
      const resolutionRun = run(
        gateStore(
          resolutionStore,
          `resolution-${iterationOffset}`,
          resolutionReached,
          releaseResolution,
        ),
        iterationOffset,
        'resolution-review',
        {
          rawFindingId: `resolution-${iterationOffset}`,
          familyTag: 'convergence',
          severity: 'high',
          title: 'Source issue fixed',
          description: 'The source issue is fixed.',
          suggestion: null,
          relation: 'resolution_confirmation',
          targetFindingId: 'F-0001',
          evidence,
        },
      );
      const persistsRun = run(
        gateStore(
          persistsStore,
          `persists-${iterationOffset}`,
          persistsReached,
          releasePersists,
        ),
        iterationOffset + 1,
        'persists-review',
        {
          rawFindingId: `persists-${iterationOffset}`,
          familyTag: 'convergence',
          severity: 'high',
          title: 'Source issue',
          description: 'The source line remains incorrect.',
          suggestion: null,
          relation: 'persists',
          targetFindingId: 'F-0001',
          evidence,
        },
      );
      await Promise.all([resolutionReached.promise, persistsReached.promise]);
      if (first === 'resolution') {
        releaseResolution.resolve();
        await resolutionRun;
        releasePersists.resolve();
        await persistsRun;
      } else {
        releasePersists.resolve();
        await persistsRun;
        releaseResolution.resolve();
        await resolutionRun;
      }
      return seedStore.loadLedger();
    };
    const canonicalProjection = (ledger: FindingLedger) => ({
      findings: ledger.findings.map((finding) => ({
        id: finding.id,
        status: finding.status,
        lifecycle: finding.lifecycle,
        revision: finding.revision,
        rawFindingIds: [...finding.rawFindingIds].sort(),
        provisionalKind: finding.provisional?.kind,
        resolvedEvidence: finding.resolvedEvidence,
        reopenedEvidence: finding.reopenedEvidence,
      })).sort((left, right) => left.id.localeCompare(right.id)),
      conflicts: ledger.conflicts.map((conflict) => ({
        id: conflict.id,
        status: conflict.status,
        findingIds: [...conflict.findingIds].sort(),
        rawFindingIds: [...conflict.rawFindingIds].sort(),
        description: conflict.description,
      })).sort((left, right) => left.id.localeCompare(right.id)),
    });

    const resolutionThenPersists = await runOrder('resolution', 10);
    const persistsThenResolution = await runOrder('persists', 10);

    expect(canonicalProjection(resolutionThenPersists)).toEqual(
      canonicalProjection(persistsThenResolution),
    );
    const converged = canonicalProjection(resolutionThenPersists);
    expect(converged.findings).toEqual([
      expect.objectContaining({
        id: 'F-0001',
        status: 'open',
        lifecycle: 'reopened',
        revision: 3,
        provisionalKind: undefined,
        resolvedEvidence: undefined,
      }),
    ]);
    expect(converged.findings[0]?.rawFindingIds).toEqual([
      'raw-existing',
      expect.stringContaining('resolution-10'),
      expect.stringContaining('persists-10'),
    ]);
    expect(converged.conflicts).toEqual([
      expect.objectContaining({
        status: 'active',
        findingIds: ['F-0001'],
        rawFindingIds: [
          expect.stringContaining('resolution-10'),
          expect.stringContaining('persists-10'),
        ],
      }),
    ]);
    expect(executeAgentMock).toHaveBeenCalledTimes(2);
  });
});
