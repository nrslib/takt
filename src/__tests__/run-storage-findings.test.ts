import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
  resumeRealRunStorage,
} from './helpers/run-storage.js';
import { canonicalRawFindingFixture } from './helpers/finding-lifecycle-fixture.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { runFindingManagerForStep } from '../core/workflow/findings/manager-runner.js';
import {
  createPendingFindingReviewNormalization,
  createFindingReviewPublication,
  loadPendingFindingReviewNormalization,
  PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
  persistPendingFindingReviewNormalization,
} from '../core/workflow/findings/review-publication.js';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { inheritResumeReportSnapshot } from '../core/workflow/run/resume-report-snapshot.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  cleanupRealRunStorages();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Finding authority boundary', () => {
  it('admits a normalized broad report as a product provisional in the SQLite authority', async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-broad-review-sqlite-'));
    temporaryDirectories.push(projectCwd);
    mkdirSync(join(projectCwd, 'src'), { recursive: true });
    writeFileSync(join(projectCwd, 'src', 'index.ts'), 'export const value = 1;\n');
    initializeGitFixture(projectCwd, ['src/index.ts']);

    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
    const owner = root.claimLease({
      ownerKey: 'broad-review-owner',
      leaseDurationMs: 9_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'broad-review-manager',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    const reportContent = [
      '# Architecture Review',
      '',
      'The module boundary is too broad and couples unrelated responsibilities.',
    ].join('\n');
    const rawFindings = [{
      rawExcerpt: 'The module boundary is too broad and couples unrelated responsibilities.',
      candidate: {
        rawFindingId: null,
        familyTag: 'architecture',
        severity: 'high',
        title: 'Module boundary is too broad',
        description: 'The module boundary couples unrelated responsibilities.',
        suggestion: 'Split the responsibilities behind explicit ports.',
        relation: 'new',
        targetFindingIds: [],
        target: null,
        evidenceRequests: [],
      },
    }];
    const publication = createFindingReviewPublication({
      identity: {
        scopeIdentity: store.ledgerIdentity,
        callNamespace: '',
        parentStepName: 'reviewers',
        stepIteration: 1,
        reviewerStepName: 'architecture-review',
        reportName: 'architecture-review.md',
      },
      protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent,
      rawFindings,
    });

    const result = await runFindingManagerForStep({
      contract: {
        ledgerPath: '.takt/findings/default.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'Reconcile findings.',
          outputContract: 'Return JSON.',
        },
      },
      ledgerStore: store,
      optionsBuilder: {
        buildAgentOptions: () => ({}),
        resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
      } as never,
      stepExecutor: {
        buildPhase1Instruction: (instruction: string) => instruction,
        recordSynthesizedAgentUsage: () => {},
        normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
      } as never,
      cwd: projectCwd,
      parentStep: {
        kind: 'agent',
        name: 'reviewers',
        persona: 'reviewer',
        edit: false,
      },
      stepIteration: 1,
      subResults: [{
        subStep: {
          kind: 'agent',
          name: 'architecture-review',
          persona: 'architecture-reviewer',
          edit: false,
        },
        publication,
      }],
      workflowName: 'default',
      runId: 'run-1',
      callNamespace: '',
      timestamp: '2026-07-31T00:00:00.000Z',
    });

    expect(result.status).toBe('updated');
    expect(existsSync(databasePath)).toBe(true);
    const ledger = store.loadLedger();
    expect(ledger.rawFindings).toEqual([
      expect.objectContaining({
        target: { kind: 'review_scope' },
        title: 'Module boundary is too broad',
        description: 'The module boundary couples unrelated responsibilities.',
      }),
    ]);
    expect(ledger.findings).toEqual([
      expect.objectContaining({
        status: 'open',
        title: 'Module boundary is too broad',
        provisional: expect.objectContaining({
          gateEffect: 'block',
          reason: expect.stringContaining(
            'Review-scope finding has no concrete target for typed evidence verification',
          ),
        }),
      }),
    ]);
    expect(ledger.reviewerAnomalies ?? []).toEqual([]);
    const validationReport = runtime.reports.history(
      'findings-manager-validation.reviewers.json',
    ).at(-1);
    expect(validationReport).toBeDefined();
    const report = JSON.parse(validationReport!.content) as {
      managerTaskAudits?: Array<{ taskKind: string }>;
      provisionalLandings?: Array<{ reason: string }>;
    };
    expect(report.managerTaskAudits ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskKind: 'entity_binding' }),
      ]),
    );
    expect(report.provisionalLandings).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining(
          'Review-scope finding has no concrete target for typed evidence verification',
        ),
      }),
    ]);
  });

  it('rebinds an inherited pending review from the source SQLite scope to the target scope', () => {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-sqlite-pending-resume-'));
    temporaryDirectories.push(projectCwd);
    const source = createRealRunStorage({ findingContractEnabled: true });
    const sourceLease = source.root.claimLease({
      ownerKey: 'pending-source',
      leaseDurationMs: 9_000,
    });
    const sourceRuntime = source.root.runtime({ lease: sourceLease });
    const sourceExecution = sourceRuntime.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });
    const sourceStore = sourceRuntime.findingManager({
      workflowName: 'default',
      producer: sourceExecution.handle,
    });
    const target = resumeRealRunStorage(source.root, {
      slug: 'run-resume',
      findingContractEnabled: true,
    });
    const targetLease = target.root.claimLease({
      ownerKey: 'pending-target',
      leaseDurationMs: 9_000,
    });
    const targetRuntime = target.root.runtime({ lease: targetLease });
    const targetExecution = targetRuntime.execution.startStep({
      stepKey: 'review-resume',
      expectedScopeRevision: 0,
    });
    const targetStore = targetRuntime.findingManager({
      workflowName: 'default',
      producer: targetExecution.handle,
    });
    expect(targetStore.ledgerIdentity).not.toBe(sourceStore.ledgerIdentity);

    const sourcePaths = buildRunPaths(projectCwd, 'run-1');
    const targetPaths = buildRunPaths(projectCwd, 'run-resume');
    mkdirSync(sourcePaths.runRootAbs, { recursive: true });
    const sourcePending = persistPendingFindingReviewNormalization(
      sourcePaths.reportsAbs,
      createPendingFindingReviewNormalization({
        identity: {
          scopeIdentity: sourceStore.ledgerIdentity,
          callNamespace: '',
          parentStepName: 'review',
          stepIteration: 1,
          reviewerStepName: 'review',
          reportName: 'review.md',
        },
        workflowName: 'default',
        reportContent: '## Result: REJECT\n\nBroad architecture concern.',
        reviewerExecutionIdentity: {
          provider: 'mock',
          model: 'reviewer-model',
        },
      }),
    );
    inheritResumeReportSnapshot({
      cwd: projectCwd,
      sourceRunSlug: 'run-1',
      targetRunSlug: 'run-resume',
    });

    const loaded = loadPendingFindingReviewNormalization(
      targetPaths.reportsAbs,
      {
        scopeIdentity: targetStore.ledgerIdentity,
        callNamespace: '',
        parentStepName: 'review',
        stepIteration: 1,
        reviewerStepName: 'review',
        reportName: 'review.md',
      },
      'default',
    )!;

    expect(loaded).toMatchObject({
      scopeIdentity: targetStore.ledgerIdentity,
      reportContent: sourcePending.reportContent,
      reportDigest: sourcePending.reportDigest,
    });
    expect(loaded.publicationId).not.toBe(sourcePending.publicationId);
    expect(targetRuntime.reports.history('review.md')).toEqual([]);
  });

  it('projects normalized raw entries from an append-only ledger revision', async () => {
    const { root } = createRealRunStorage({ findingContractEnabled: true });
    const owner = root.claimLease({
      ownerKey: 'owner',
      leaseDurationMs: 9_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'findings-manager',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });

    await store.updateLedger((ledger) => ({
      ledger: {
        ...ledger,
        rawFindings: [canonicalRawFindingFixture({
          rawFindingId: 'raw-1',
          stepName: 'review',
          reviewer: 'reviewer',
          familyTag: 'architecture',
          severity: 'high',
          title: 'Authority',
          description: 'SQLite is authoritative.',
          suggestion: null,
          relation: 'new',
          targetFindingId: null,
          evidence: [],
        })],
      },
      result: undefined,
    }));

    expect(store.loadLedger().rawFindings).toEqual([
      expect.objectContaining({ rawFindingId: 'raw-1' }),
    ]);
    expect(root.readResumeSnapshot().findingHeads).toEqual([
      expect.objectContaining({ scope_id: 'root', current_revision: 2 }),
    ]);
  });

  it('keeps Finding authority empty when Finding Contract is disabled', () => {
    const { root } = createRealRunStorage({ findingContractEnabled: false });

    expect(root.readResumeSnapshot().findingHeads).toEqual([]);
    expect(root.readResumeSnapshot().findingRevisions).toEqual([]);
    expect(root.readResumeSnapshot().scopes).toEqual([
      expect.objectContaining({ scopeId: 'root' }),
    ]);
  });

  it('creates child Finding authority on its first mutation', async () => {
    const { root } = createRealRunStorage({ findingContractEnabled: true });
    const owner = root.claimLease({
      ownerKey: 'owner',
      leaseDurationMs: 9_000,
    });
    const rootRuntime = root.runtime({ lease: owner });
    const childScope = rootRuntime.scopes.createParallelChild({ scopeKey: 'child' });
    const child = root.runtime({ lease: owner, scope: childScope });
    const execution = child.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });

    const childStore = child.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    expect(childStore.loadLedger()).toMatchObject({
      workflowName: 'default',
      nextId: 1,
    });
    await childStore.updateLedger((ledger) => ({
      ledger: { ...ledger, nextId: 2 },
      result: undefined,
    }));
    const snapshot = root.readResumeSnapshot();
    expect(snapshot.findingHeads).toEqual([
      expect.objectContaining({ current_revision: 2 }),
    ]);
    expect(snapshot.findingHeads[0]?.scope_id).not.toBe('root');
    expect(snapshot.findingRevisions).toHaveLength(1);
  });

  it('validates root and parallel histories beyond their bootstrap revisions', async () => {
    const { root } = createRealRunStorage({ findingContractEnabled: true });
    const owner = root.claimLease({
      ownerKey: 'revision-history-owner',
      leaseDurationMs: 9_000,
    });
    const rootRuntime = root.runtime({ lease: owner });
    const parallelScope = rootRuntime.scopes.createParallelChild({
      scopeKey: 'revision-history-parallel',
    });
    const parallelRuntime = root.runtime({
      lease: owner,
      scope: parallelScope,
    });
    const rootExecution = rootRuntime.execution.startStep({
      stepKey: 'root-manager',
      expectedScopeRevision: 0,
    });
    const parallelExecution = parallelRuntime.execution.startStep({
      stepKey: 'parallel-manager',
      expectedScopeRevision: 0,
    });
    const rootStore = rootRuntime.findingManager({
      workflowName: 'default',
      producer: rootExecution.handle,
    });
    const parallelStore = parallelRuntime.findingManager({
      workflowName: 'default',
      producer: parallelExecution.handle,
    });

    await rootStore.updateLedger((ledger) => ({
      ledger: { ...ledger, nextId: 2 },
      result: undefined,
    }));
    await parallelStore.updateLedger((ledger) => ({
      ledger: { ...ledger, nextId: 2 },
      result: undefined,
    }));

    expect(root.readResumeSnapshot().findingHeads).toEqual([
      expect.objectContaining({ current_revision: 2 }),
      expect.objectContaining({ current_revision: 2 }),
    ]);
    const resumed = resumeRealRunStorage(root, {
      slug: 'revision-history-resume',
      findingContractEnabled: true,
    });
    expect(resumed.root.readResumeSnapshot().findingHeads).toEqual([
      expect.objectContaining({ current_revision: 1 }),
      expect.objectContaining({ current_revision: 1 }),
    ]);
  });

  it('rejects root, parallel, and workflow_call sibling producer handles', () => {
    const { root } = createRealRunStorage({ findingContractEnabled: true });
    const owner = root.claimLease({
      ownerKey: 'scope-bound-producers',
      leaseDurationMs: 9_000,
    });
    const rootRuntime = root.runtime({ lease: owner });
    const rootExecution = rootRuntime.execution.startStep({
      stepKey: 'root-review',
      expectedScopeRevision: 0,
    });
    const parallelScope = rootRuntime.scopes.createParallelChild({
      scopeKey: 'parallel-review',
    });
    const workflowScope = rootRuntime.scopes.createWorkflowCallChild({
      scopeKey: 'workflow-review',
    });
    const parallelRuntime = root.runtime({ lease: owner, scope: parallelScope });
    const workflowRuntime = root.runtime({ lease: owner, scope: workflowScope });
    const parallelExecution = parallelRuntime.execution.startStep({
      stepKey: 'parallel-review',
      expectedScopeRevision: 0,
    });
    const workflowExecution = workflowRuntime.execution.startStep({
      stepKey: 'workflow-review',
      expectedScopeRevision: 0,
    });

    expect(() => rootRuntime.findingManager({
      workflowName: 'default',
      producer: parallelExecution.handle,
    })).toThrow(/cross-scope/i);
    expect(() => parallelRuntime.findingManager({
      workflowName: 'default',
      producer: rootExecution.handle,
    })).toThrow(/cross-scope/i);
    expect(() => workflowRuntime.findingManager({
      workflowName: 'default',
      producer: parallelExecution.handle,
    })).toThrow(/cross-scope/i);
    expect(() => parallelRuntime.findingManager({
      workflowName: 'default',
      producer: workflowExecution.handle,
    })).toThrow(/cross-scope/i);
  });
});
