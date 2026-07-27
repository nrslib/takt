import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readFileFailure = vi.hoisted(() => ({
  path: '',
  descriptor: undefined as number | undefined,
  error: Object.assign(new Error('injected read failure'), { code: 'EIO' }),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    openSync(...args: Parameters<typeof actual.openSync>): ReturnType<typeof actual.openSync> {
      const descriptor = actual.openSync(...args);
      if (String(args[0]) === readFileFailure.path) {
        readFileFailure.descriptor = descriptor;
      }
      return descriptor;
    },
    readFileSync(...args: Parameters<typeof actual.readFileSync>): ReturnType<typeof actual.readFileSync> {
      if (args[0] === readFileFailure.descriptor) {
        readFileFailure.descriptor = undefined;
        throw readFileFailure.error;
      }
      return actual.readFileSync(...args);
    },
  };
});

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResponse, FindingContractConfig, WorkflowStep } from '../core/models/types.js';
import { runFindingManagerForStep } from '../core/workflow/findings/manager-runner.js';
import { computeReviewScopeSnapshotId } from '../core/workflow/findings/snapshot.js';
import { createFindingLedgerStore } from '../core/workflow/findings/store.js';
import type { FindingLedger, FindingLedgerStore } from '../core/workflow/findings/types.js';
import { executeAgent } from '../agents/agent-usecases.js';

const executeAgentMock = vi.mocked(executeAgent);

const FINDING_CONTRACT: FindingContractConfig = {
  ledgerPath: '.takt/findings/peer-review.json',
  rawFindingsPath: '.takt/findings/raw',
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
    readFileFailure.descriptor = undefined;
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each(['EIO', 'EACCES', 'EPERM'])('source quote の %s を実 runner/store 境界で握りつぶさず、台帳を更新しない', async (code) => {
    const ledgerStore = createFindingLedgerStore({
      projectCwd: cwd,
      reportDir,
      workflowName: 'peer-review',
      ledgerPath: FINDING_CONTRACT.ledgerPath,
      rawFindingsPath: FINDING_CONTRACT.rawFindingsPath,
    });
    const initialLedger: FindingLedger = {
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-07-17T00:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    };
    await ledgerStore.updateLedger(() => ({ ledger: initialLedger, result: undefined }));
    const ledgerPath = join(cwd, FINDING_CONTRACT.ledgerPath);
    const initialLedgerContent = readFileSync(ledgerPath, 'utf-8');
    const snapshotId = computeReviewScopeSnapshotId(cwd);
    readFileFailure.path = sourcePath;
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
      },
      cwd,
      parentStep: { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false },
      stepIteration: 1,
      subResults: [{
        subStep: { kind: 'agent', name: 'review', persona: 'reviewer', edit: false },
        response: {
          status: 'done',
          content: '',
          structuredOutput: {
            rawFindings: [{
              rawFindingId: 'raw-1',
              familyTag: 'filesystem-error',
              severity: 'high',
              title: 'Source issue',
              location: 'src/example.ts:1',
              description: 'The source line is problematic.',
              suggestion: 'Fix the source line.',
              relation: 'new',
              evidenceKind: 'source_quote',
              verbatimExcerpt: 'export const value = 1;',
              snapshotId,
            }],
          },
        } as unknown as AgentResponse,
      }],
      workflowName: 'peer-review',
      runId: 'run-1',
      callNamespace: '',
      timestamp: '2026-07-17T00:00:00.000Z',
    });

    await expect(run).rejects.toBe(readFileFailure.error);
    readFileFailure.path = '';
    expect(readFileSync(ledgerPath, 'utf-8')).toBe(initialLedgerContent);
    expect(ledgerStore.loadLedger()).toEqual(initialLedger);
  });

  it('manager 応答待ち中に source quote が古くなった場合は finding を作成しない', async () => {
    const ledgerStore = createFindingLedgerStore({
      projectCwd: cwd,
      reportDir,
      workflowName: 'peer-review',
      ledgerPath: FINDING_CONTRACT.ledgerPath,
      rawFindingsPath: FINDING_CONTRACT.rawFindingsPath,
    });
    await ledgerStore.updateLedger(() => ({
      ledger: {
        workflowName: 'peer-review',
        nextId: 1,
        updatedAt: '2026-07-17T00:00:00.000Z',
        findings: [],
        rawFindings: [],
        conflicts: [],
        interpretations: [],
      },
      result: undefined,
    }));
    const snapshotId = computeReviewScopeSnapshotId(cwd);
    executeAgentMock.mockImplementation(async () => {
      writeFileSync(sourcePath, 'export const value = 2;\n');
      return {
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [{
            rawFindingId: 'run-1:reviewers:1:review:raw-1',
            decision: 'new',
            evidence: 'No related open finding.',
          }],
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
        },
      } as unknown as AgentResponse;
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
      },
      cwd,
      parentStep: { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false },
      stepIteration: 1,
      subResults: [{
        subStep: { kind: 'agent', name: 'review', persona: 'reviewer', edit: false },
        response: {
          status: 'done',
          content: '',
          structuredOutput: { rawFindings: [{
            rawFindingId: 'raw-1',
            familyTag: 'evidence-revalidation',
            severity: 'high',
            title: 'Source issue',
            location: 'src/example.ts:1',
            description: 'The source line is problematic.',
            suggestion: 'Fix the source line.',
            relation: 'new',
            evidenceKind: 'source_quote',
            verbatimExcerpt: 'export const value = 1;',
            snapshotId,
          }] },
        } as unknown as AgentResponse,
      }],
      workflowName: 'peer-review',
      runId: 'run-1',
      callNamespace: '',
      timestamp: '2026-07-17T00:00:00.000Z',
    });

    const ledger = ledgerStore.loadLedger();
    expect(ledger.findings).toEqual([]);
    expect(ledger.reviewerAnomalies).toHaveLength(1);
  });

  it('同じopen revisionを観測した解消と検証済みpersistsはcommit順に依存せず同じcanonical projectionへ収束する', async () => {
    const initialLedger: FindingLedger = {
      workflowName: 'peer-review',
      nextId: 2,
      updatedAt: '2026-07-17T00:00:00.000Z',
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: 'Source issue',
        location: 'src/example.ts:1',
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
      rawFindings: [{
        rawFindingId: 'raw-existing',
        stepName: 'reviewers',
        reviewer: 'review',
        familyTag: 'convergence',
        severity: 'high',
        title: 'Source issue',
        location: 'src/example.ts:1',
        description: 'The source line remains incorrect.',
        relation: 'new',
      }],
      conflicts: [],
      interpretations: [],
    };
    const storeOptions = {
      projectCwd: cwd,
      reportDir,
      workflowName: 'peer-review',
      ledgerPath: FINDING_CONTRACT.ledgerPath,
      rawFindingsPath: FINDING_CONTRACT.rawFindingsPath,
    };
    const runOrder = async (
      first: 'resolution' | 'persists',
      iterationOffset: number,
    ): Promise<FindingLedger> => {
      const runStoreOptions = {
        ...storeOptions,
        ledgerPath: `${FINDING_CONTRACT.ledgerPath}.${first}-${iterationOffset}`,
      };
      const seedStore = createFindingLedgerStore(runStoreOptions);
      await seedStore.updateLedger(() => ({
        ledger: initialLedger,
        result: undefined,
      }));
      const resolutionStore = createFindingLedgerStore(runStoreOptions);
      const persistsStore = createFindingLedgerStore(runStoreOptions);
      const resolutionReached = createDeferredSignal();
      const persistsReached = createDeferredSignal();
      const releaseResolution = createDeferredSignal();
      const releasePersists = createDeferredSignal();
      const gateStore = (
        store: FindingLedgerStore,
        ledgerIdentity: string,
        reached: DeferredSignal,
        release: DeferredSignal,
      ): FindingLedgerStore => ({
        ...store,
        ledgerIdentity,
        commitManagerLedger: async (mutator) => {
          reached.resolve();
          await release.promise;
          return store.commitManagerLedger(mutator);
        },
      });
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
        },
        cwd,
        parentStep: { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false },
        stepIteration,
        subResults: [{
          subStep: { kind: 'agent', name: reviewerName, persona: 'reviewer', edit: false },
          response: {
            status: 'done',
            content: '',
            structuredOutput: { rawFindings: [rawFinding] },
          } as unknown as AgentResponse,
        }],
        workflowName: 'peer-review',
        runId: 'run-1',
        callNamespace: '',
        timestamp: '2026-07-17T00:00:01.000Z',
      });
      const evidence = {
        evidenceKind: 'source_quote',
        verbatimExcerpt: 'export const value = 1;',
        snapshotId: computeReviewScopeSnapshotId(cwd),
      };
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
          location: 'src/example.ts:1',
          description: 'The source issue is fixed.',
          suggestion: '',
          relation: 'resolution_confirmation',
          targetFindingId: 'F-0001',
          ...evidence,
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
          location: 'src/example.ts:1',
          description: 'The source line remains incorrect.',
          suggestion: '',
          relation: 'persists',
          targetFindingId: 'F-0001',
          ...evidence,
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
    expect(executeAgentMock).not.toHaveBeenCalled();
  });
});
