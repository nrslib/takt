import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { resumePendingManagerCommit } from '../core/workflow/findings/manager-commit.js';
import {
  finalizePendingManagerCommit,
  stagePendingManagerCommit,
} from '../core/workflow/findings/manager-pending-commit.js';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
  resumeRealRunStorage,
} from './helpers/run-storage.js';
import { serializeFindingManagerValidationReport } from '../core/workflow/findings/manager-report-content.js';
import { createFindingLedgerStore } from '../core/workflow/findings/store.js';
import type {
  FindingLedger,
  RawFinding,
} from '../core/workflow/findings/types.js';
import { canonicalJson } from '../shared/utils/canonical-json.js';
import { openRunStorage } from '../infra/run-storage/root.js';

afterEach(cleanupRealRunStorages);

describe('Finding manager SQLite adapter', () => {
  it('reopens valid authority after ledger, pending, finalized, and parallel updates', async () => {
    const createFindingStore = () => {
      const storage = createRealRunStorage({ findingContractEnabled: true });
      const lease = storage.root.claimLease({
        ownerKey: 'reopen-owner',
        leaseDurationMs: 9_000,
      });
      const runtime = storage.root.runtime({ lease });
      const execution = runtime.execution.startStep({
        stepKey: 'reopen-manager',
        expectedScopeRevision: 0,
      });
      return {
        ...storage,
        lease,
        runtime,
        store: runtime.findingManager({
          workflowName: 'default',
          producer: execution.handle,
        }),
      };
    };
    const reopen = (databasePath: string, root: ReturnType<
      typeof createRealRunStorage
    >['root']) => {
      root.close();
      const reopened = openRunStorage({ databasePath });
      expect(reopened.readResumeSnapshot().findingLedger).not.toBeNull();
      reopened.close();
    };

    const updated = createFindingStore();
    await updated.store.updateLedger((current) => ({
      ledger: { ...current, nextId: current.nextId + 1 },
      result: undefined,
    }));
    expect(updated.root.readResumeSnapshot().findingLedger?.revision).toBe(2);
    reopen(updated.databasePath, updated.root);

    const pending = createFindingStore();
    const pendingRunId = pending.store.runId;
    await pending.store.commitManagerLedger((current) => ({
      ledger: {
        ...current,
        stopBudget: {
          roundMarkers: ['round-pending-reopen'],
          firstRoundAt: current.updatedAt,
          exhausted: false,
        },
      },
      publication: {
        roundMarker: 'round-pending-reopen',
        report: {
          version: 1,
          runId: pendingRunId,
          stepName: 'reviewers',
          retryCount: 0,
          ledgerUpdated: true,
          finalErrors: [],
          attempts: [],
        },
      },
      result: undefined,
    }));
    expect(pending.store.loadLedger().pendingManagerCommit).toBeDefined();
    reopen(pending.databasePath, pending.root);

    const finalized = createFindingStore();
    const finalizedRunId = finalized.store.runId;
    const staged = await finalized.store.commitManagerLedger((current) => ({
      ledger: {
        ...current,
        stopBudget: {
          roundMarkers: ['round-finalized-reopen'],
          firstRoundAt: current.updatedAt,
          exhausted: false,
        },
      },
      publication: {
        roundMarker: 'round-finalized-reopen',
        report: {
          version: 1,
          runId: finalizedRunId,
          stepName: 'reviewers',
          retryCount: 0,
          ledgerUpdated: true,
          finalErrors: [],
          attempts: [],
        },
      },
      result: undefined,
    }));
    const publication = staged.ledger.pendingManagerCommit!.publication;
    const receipt = finalized.store.publishManagerValidationPublication(publication);
    await finalized.store.finalizeManagerValidationPublication(
      publication,
      receipt,
    );
    expect(finalized.store.loadLedger().pendingManagerCommit).toBeUndefined();
    reopen(finalized.databasePath, finalized.root);

    const parallel = createFindingStore();
    const parallelScope = parallel.runtime.scopes.createParallelChild({
      scopeKey: 'reopen-child',
    });
    const parallelRuntime = parallel.root.runtime({
      lease: parallel.lease,
      scope: parallelScope,
    });
    const parallelExecution = parallelRuntime.execution.startStep({
      stepKey: 'parallel-reopen-manager',
      expectedScopeRevision: 0,
    });
    const parallelStore = parallelRuntime.findingManager({
      workflowName: 'default',
      producer: parallelExecution.handle,
    });
    await parallelStore.updateLedger((current) => ({
      ledger: { ...current, nextId: current.nextId + 1 },
      result: undefined,
    }));
    expect(parallelStore.loadLedger().nextId).toBe(2);
    expect(parallel.root.readResumeSnapshot().scopes).toHaveLength(2);
    reopen(parallel.databasePath, parallel.root);
  });

  it('uses the manager report serializer bytes for save, plan, hash, and publication identity', () => {
    const { root } = createRealRunStorage({
      findingContractEnabled: true,
    });
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
    const report = {
      version: 1 as const,
      runId: store.runId,
      stepName: 'reviewers',
      retryCount: 2,
      ledgerUpdated: false,
      finalErrors: ['second final error', 'first final error'],
      attempts: [
        {
          attempt: 2,
          managerOutput: { ordered: ['second', 'first'] },
          validationErrors: ['z first', 'a second'],
        },
        {
          attempt: 1,
          managerOutput: { ordered: ['original'] },
          validationErrors: ['original failure'],
        },
      ],
    };
    const expectedContent = serializeFindingManagerValidationReport(report);
    const expectedHash = createHash('sha256').update(expectedContent).digest('hex');

    store.saveManagerValidationReport(report);
    const saved = runtime.reports.history(
      'findings-manager-validation.reviewers.json',
    )[0]!;
    expect(saved.content).toBe(expectedContent);
    expect(saved.digest).toBe(expectedHash);
    expect(saved.publicationKey).toBe(createHash('sha256').update([
      'manager-validation',
      'findings-manager-validation.reviewers.json',
      expectedHash,
    ].join('\0')).digest('hex'));

    const publication = store.planManagerValidationPublication('round-serializer', report);
    const receipt = store.publishManagerValidationPublication(publication);
    const published = runtime.reports.history(
      'findings-manager-validation.reviewers.json',
    )[1]!;
    expect(publication.contentSha256).toBe(expectedHash);
    expect(receipt).toMatchObject({
      publicationId: publication.publicationId,
      contentSha256: expectedHash,
    });
    expect(published).toMatchObject({
      content: expectedContent,
      digest: expectedHash,
      publicationKey: publication.publicationId,
    });

    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-manager-report-parity-'));
    try {
      const reportDir = join(projectCwd, '.takt', 'runs', report.runId, 'reports');
      mkdirSync(reportDir, { recursive: true });
      const filesystemStore = createFindingLedgerStore({
        projectCwd,
        runId: report.runId,
        reportDir,
        workflowName: 'default',
        ledgerPath: '.takt/findings/ledger.json',
        rawFindingsPath: '.takt/findings/raw',
      });
      const filesystemPublication = filesystemStore.planManagerValidationPublication(
        'round-serializer',
        report,
      );
      const filesystemReceipt = filesystemStore.publishManagerValidationPublication(
        filesystemPublication,
      );

      expect(filesystemPublication.contentSha256).toBe(publication.contentSha256);
      expect(filesystemPublication.publicationId).toBe(publication.publicationId);
      expect(filesystemReceipt).toMatchObject({
        publicationId: publication.publicationId,
        contentSha256: expectedHash,
      });
      expect(readFileSync(
        join(reportDir, 'findings-manager-validation.reviewers.json'),
        'utf-8',
      )).toBe(expectedContent);
      for (const [stepName, expectedFileName] of [
        ['review team', 'findings-manager-validation.review-team.json'],
        ['reviewer 日本語 A', 'findings-manager-validation.reviewer-A.json'],
        ['review/security', 'findings-manager-validation.review-security.json'],
      ] as const) {
        const specialReport = { ...report, stepName };
        expect(store.planManagerValidationPublication(
          `round-${stepName}`,
          specialReport,
        ).fileName).toBe(expectedFileName);
        expect(filesystemStore.planManagerValidationPublication(
          `round-${stepName}`,
          specialReport,
        ).fileName).toBe(expectedFileName);
      }
      const emptyAfterSanitization = {
        ...report,
        stepName: ' 日本語 / ',
      };
      expect(() => store.planManagerValidationPublication(
        'round-empty-name',
        emptyAfterSanitization,
      )).toThrow(/step name/i);
      expect(() => filesystemStore.planManagerValidationPublication(
        'round-empty-name',
        emptyAfterSanitization,
      )).toThrow(/step name/i);
    } finally {
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });

  it('returns the persisted projection produced by replaceLedger', async () => {
    const { root, clock } = createRealRunStorage({
      findingContractEnabled: true,
    });
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
    clock.set(5_000);

    const committed = await store.updateLedger((current) => ({
      ledger: {
        ...current,
        nextId: 2,
      },
      result: 'committed',
    }));

    expect(committed.result).toBe('committed');
    expect(committed.ledger).toEqual(store.loadLedger());
    expect(committed.ledger.updatedAt).toBe(new Date(5_000).toISOString());
  });

  it('resumes a pending manager commit through the SQLite store', async () => {
    const { root } = createRealRunStorage({
      findingContractEnabled: true,
    });
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
    const runId = store.runId;
    const roundMarker = 'round-1';
    const previousLedger = store.loadLedger();
    const publication = store.planManagerValidationPublication(roundMarker, {
      version: 1,
      runId,
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    });
    const stageCandidate = stagePendingManagerCommit({
      previousLedger,
      completedLedger: {
        ...previousLedger,
        stopBudget: {
          roundMarkers: [roundMarker],
          firstRoundAt: previousLedger.updatedAt,
          exhausted: false,
        },
      },
      roundMarker,
      publication,
    });
    await expect(Promise.resolve().then(() => store.updateLedger(() => ({
      ledger: stageCandidate,
      result: undefined,
    })))).rejects.toThrow(/cannot be staged through the general mutation API/i);
    const staged = await store.commitManagerLedger(() => ({
      ledger: stageCandidate,
      result: undefined,
    }));

    const resumed = await resumePendingManagerCommit(
      { ledgerStore: store } as never,
      staged.ledger,
    );

    expect(resumed?.completedRoundMarker).toBe(roundMarker);
    expect(store.loadLedger()).toEqual({
      ...previousLedger,
      stopBudget: {
        roundMarkers: [roundMarker],
        firstRoundAt: previousLedger.updatedAt,
        exhausted: false,
      },
    });
  });

  it.each([
    ['raw deletion', (_raw: RawFinding) => []],
    ['typed evidence replacement', (raw: RawFinding) => [{
      ...raw,
      evidence: { kind: 'locationless' as const, explanation: 'evidence E2' },
    }]],
  ])('rejects pending %s at SQLite stage and dedicated finalization', async (
    _label,
    attack,
  ) => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
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
    const runId = store.runId;
    const internalRunId = root.readResumeSnapshot().run.runId;
    const rawE1: RawFinding = {
      rawFindingId: 'raw-pending-integrity',
      stepName: 'reviewers',
      reviewer: 'reviewer',
      familyTag: 'bug',
      severity: 'high',
      title: 'Pending integrity raw',
      description: 'Pending integrity description',
      relation: 'new',
      evidence: { kind: 'locationless', explanation: 'evidence E1' },
    };
    await store.updateLedger((current) => ({
      ledger: { ...current, rawFindings: [rawE1] },
      result: undefined,
    }));
    const previousLedger = store.loadLedger();
    const roundMarker = `round-${_label.replaceAll(' ', '-')}`;
    const publication = store.planManagerValidationPublication(roundMarker, {
      version: 1,
      runId,
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    });
    const validStaged = stagePendingManagerCommit({
      previousLedger,
      completedLedger: {
        ...previousLedger,
        stopBudget: {
          roundMarkers: [roundMarker],
          firstRoundAt: previousLedger.updatedAt,
          exhausted: false,
        },
      },
      roundMarker,
      publication,
    });
    const maliciousStaged: FindingLedger = {
      ...validStaged,
      pendingManagerCommit: {
        ...validStaged.pendingManagerCommit!,
        completed: {
          ...validStaged.pendingManagerCommit!.completed,
          rawFindings: attack(rawE1),
        },
      },
    };

    await expect(Promise.resolve().then(() => store.updateLedger(() => ({
      ledger: maliciousStaged,
      result: undefined,
    })))).rejects.toThrow(/append-only|replaced with different content/);

    const persistedStage = await store.commitManagerLedger(() => ({
      ledger: validStaged,
      result: undefined,
    }));
    const receipt = store.publishManagerValidationPublication(publication);
    const persistedRaw = persistedStage.ledger.rawFindings[0]!;
    const persistedMalicious: FindingLedger = {
      ...persistedStage.ledger,
      pendingManagerCommit: {
        ...persistedStage.ledger.pendingManagerCommit!,
        completed: {
          ...persistedStage.ledger.pendingManagerCommit!.completed,
          rawFindings: attack(persistedRaw),
        },
      },
    };
    const pendingRecord = canonicalJson(persistedMalicious.pendingManagerCommit);
    const pendingDigest = createHash('sha256').update(pendingRecord).digest('hex');
    const projectionDigest = createHash('sha256')
      .update(canonicalJson(persistedMalicious))
      .digest('hex');
    const database = new DatabaseSync(databasePath);
    const head = database.prepare(`
      SELECT scope_id AS scopeId, current_revision AS revision
      FROM finding_ledger_heads
      WHERE run_id = ?
    `).get(internalRunId) as { scopeId: string; revision: number };
    database.exec(`
      DROP TRIGGER finding_ledger_controls_update_guard;
      DROP TRIGGER finding_ledger_revisions_update_guard;
      DROP TRIGGER finding_revision_publications_update_guard;
      BEGIN;
    `);
    database.prepare(`
      UPDATE finding_ledger_controls
      SET record = ?, digest = ?
      WHERE run_id = ? AND scope_id = ? AND revision = ?
        AND control_kind = 'pending_manager_commit'
    `).run(
      pendingRecord,
      pendingDigest,
      internalRunId,
      head.scopeId,
      head.revision,
    );
    database.prepare(`
      UPDATE finding_ledger_revisions
      SET projection_digest = ?
      WHERE run_id = ? AND scope_id = ? AND revision = ?
    `).run(projectionDigest, internalRunId, head.scopeId, head.revision);
    database.prepare(`
      UPDATE finding_revision_publications
      SET projection_digest = ?
      WHERE run_id = ? AND scope_id = ? AND revision = ?
    `).run(projectionDigest, internalRunId, head.scopeId, head.revision);
    database.exec('COMMIT');
    database.close();

    await expect(Promise.resolve().then(() => (
      store.finalizeManagerValidationPublication(publication, receipt)
    ))).rejects.toThrow(/append-only|replaced with different content/);
  });

  it('rejects exact pending finalization through general SQLite ledger mutations', async () => {
    const { root } = createRealRunStorage({
      findingContractEnabled: true,
    });
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
    const runId = store.runId;
    const roundMarker = 'round-general-finalization';
    const publication = store.planManagerValidationPublication(roundMarker, {
      version: 1,
      runId,
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    });
    const staged = await store.commitManagerLedger((current) => ({
      ledger: stagePendingManagerCommit({
        previousLedger: current,
        completedLedger: {
          ...current,
          stopBudget: {
            roundMarkers: [roundMarker],
            firstRoundAt: current.updatedAt,
            exhausted: false,
          },
        },
        roundMarker,
        publication,
      }),
      result: undefined,
    }));
    const finalized = finalizePendingManagerCommit(
      staged.ledger,
      publication.publicationId,
    );

    await expect(Promise.resolve().then(() => store.updateLedger(() => ({
      ledger: finalized,
      result: undefined,
    })))).rejects.toThrow(/pending.*dedicated finalization/i);
    expect(store.loadLedger()).toEqual(staged.ledger);
  });

  it('imports and rebinds a pending publication only from the trusted direct parent', async () => {
    const { databasePath: parentDatabasePath, root: parentRoot } = createRealRunStorage({
      findingContractEnabled: true,
    });
    const owner = parentRoot.claimLease({
      ownerKey: 'owner',
      leaseDurationMs: 9_000,
    });
    const runtime = parentRoot.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'findings-manager',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    const parentRunId = store.runId;
    const roundMarker = 'round-cross-run-resume';
    const publication = store.planManagerValidationPublication(roundMarker, {
      version: 1,
      runId: parentRunId,
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    });
    const parentStaged = await store.commitManagerLedger((current) => ({
      ledger: stagePendingManagerCommit({
        previousLedger: current,
        completedLedger: {
          ...current,
          stopBudget: {
            roundMarkers: [roundMarker],
            firstRoundAt: current.updatedAt,
            exhausted: false,
          },
        },
        roundMarker,
        publication,
      }),
      result: undefined,
    }));
    const parentBytes = readFileSync(parentDatabasePath);
    const child = resumeRealRunStorage(parentRoot, {
      slug: 'run-child',
      findingContractEnabled: true,
    });
    const childRunId = child.root.readResumeSnapshot().run.runId;
    const childOwner = child.root.claimLease({
      ownerKey: 'child-owner',
      leaseDurationMs: 9_000,
    });
    const childRuntime = child.root.runtime({ lease: childOwner });
    const childExecution = childRuntime.execution.startStep({
      stepKey: 'findings-manager',
      expectedScopeRevision: 0,
    });
    const childStore = childRuntime.findingManager({
      workflowName: 'default',
      producer: childExecution.handle,
    });
    expect(childStore.loadLedger()).toEqual(parentStaged.ledger);

    const bound = childStore.bindManagerValidationPublication(
      roundMarker,
      publication,
    );
    expect(bound).toEqual({
      ...publication,
      destinationRunId: childRunId,
    });
    expect(bound).toMatchObject({
      publicationId: publication.publicationId,
      domainId: publication.domainId,
      originRunId: parentRunId,
      contentSha256: publication.contentSha256,
      report: publication.report,
    });

    const forged = [
      { ...bound, destinationRunId: 'forged-destination' },
      { ...bound, domainId: 'forged-domain' },
      { ...bound, originRunId: 'forged-origin' },
      { ...bound, contentSha256: '0'.repeat(64) },
    ];
    for (const attack of forged) {
      await expect(childStore.rebindPendingManagerValidationPublication(attack))
        .rejects.toThrow(/not authorized for pending rebind/i);
    }
    const importedRevision = child.root.readResumeSnapshot().findingLedger!.revision;
    const importedLedger = childStore.loadLedger();
    await expect(childStore.updateLedger((current) => ({
      ledger: current,
      result: undefined,
    }))).resolves.toEqual({ ledger: importedLedger, result: undefined });
    expect(child.root.readResumeSnapshot().findingLedger!.revision)
      .toBe(importedRevision);
    await expect(Promise.resolve().then(() => childStore.updateLedger(() => ({
      ledger: {
        ...parentStaged.ledger,
        pendingManagerCommit: {
          ...parentStaged.ledger.pendingManagerCommit!,
          publication: bound,
        },
      },
      result: undefined,
    })))).rejects.toThrow(/pending.*dedicated.*rebind/i);
    await expect(childStore.rebindPendingManagerValidationPublication(bound))
      .resolves.toMatchObject({
        pendingManagerCommit: {
          publication: { destinationRunId: childRunId },
        },
      });
    await expect(childStore.rebindPendingManagerValidationPublication(bound))
      .rejects.toThrow(/already rebound/i);

    expect(store.loadLedger()).toEqual(parentStaged.ledger);
    expect(readFileSync(parentDatabasePath)).toEqual(parentBytes);
  });

  it('rolls back ledger finalization for stale and cross-stream receipts', async () => {
    const { root, clock } = createRealRunStorage({
      findingContractEnabled: true,
    });
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
    const runId = store.runId;
    const roundMarker = 'round-stale';
    const previousLedger = store.loadLedger();
    const publication = store.planManagerValidationPublication(roundMarker, {
      version: 1,
      runId,
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    });
    await store.commitManagerLedger((current) => ({
      ledger: stagePendingManagerCommit({
        previousLedger: current,
        completedLedger: {
          ...current,
          stopBudget: {
            roundMarkers: [roundMarker],
            firstRoundAt: current.updatedAt,
            exhausted: false,
          },
        },
        roundMarker,
        publication,
      }),
      result: undefined,
    }));
    const receipt = store.publishManagerValidationPublication(publication);
    const laterPublication = store.planManagerValidationPublication('round-later', {
      ...publication.report,
      retryCount: 1,
    });
    const laterReceipt = store.publishManagerValidationPublication(laterPublication);
    const otherPublication = store.planManagerValidationPublication('round-other', {
      ...publication.report,
      stepName: 'security-reviewers',
    });
    const otherReceipt = store.publishManagerValidationPublication(otherPublication);
    const revisionBeforeFailures = root.readResumeSnapshot().findingLedger?.revision;

    await expect(Promise.resolve().then(() => (
      store.finalizeManagerValidationPublication(publication, {
        ...receipt,
        revision: laterReceipt.revision,
      })
    ))).rejects.toThrow(/receipt mismatch/);
    await expect(Promise.resolve().then(() => (
      store.finalizeManagerValidationPublication(publication, {
        ...receipt,
        streamId: otherReceipt.streamId,
      })
    ))).rejects.toThrow(/receipt mismatch/);

    expect(root.readResumeSnapshot().findingLedger?.revision).toBe(revisionBeforeFailures);
    expect(store.loadLedger().pendingManagerCommit?.publication.publicationId)
      .toBe(publication.publicationId);

    clock.set(7_000);
    const finalized = await store.finalizeManagerValidationPublication(publication, receipt);
    expect(finalized.completedRoundMarker).toBe(roundMarker);
    expect(finalized.ledger).toEqual(store.loadLedger());
    expect(finalized.ledger).toEqual({
      ...previousLedger,
      updatedAt: new Date(7_000).toISOString(),
      stopBudget: {
        roundMarkers: [roundMarker],
        firstRoundAt: previousLedger.updatedAt,
        exhausted: false,
      },
    });
  });

  it('allows exactly one competing finalization through the real SQLite store', async () => {
    const { root } = createRealRunStorage({
      findingContractEnabled: true,
    });
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
    const runId = store.runId;
    const roundMarker = 'round-conflict';
    const publication = store.planManagerValidationPublication(roundMarker, {
      version: 1,
      runId,
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    });
    await store.commitManagerLedger((current) => ({
      ledger: stagePendingManagerCommit({
        previousLedger: current,
        completedLedger: {
          ...current,
          stopBudget: {
            roundMarkers: [roundMarker],
            firstRoundAt: current.updatedAt,
            exhausted: false,
          },
        },
        roundMarker,
        publication,
      }),
      result: undefined,
    }));
    const receipt = store.publishManagerValidationPublication(publication);

    const results = await Promise.allSettled([
      Promise.resolve().then(() => (
        store.finalizeManagerValidationPublication(publication, receipt)
      )),
      Promise.resolve().then(() => (
        store.finalizeManagerValidationPublication(publication, receipt)
      )),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(store.loadLedger().pendingManagerCommit).toBeUndefined();
  });

  it('rolls back a verified finalization when the ledger write fails', async () => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
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
    const runId = store.runId;
    const roundMarker = 'round-rollback';
    const publication = store.planManagerValidationPublication(roundMarker, {
      version: 1,
      runId,
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    });
    await store.commitManagerLedger((current) => ({
      ledger: stagePendingManagerCommit({
        previousLedger: current,
        completedLedger: {
          ...current,
          stopBudget: {
            roundMarkers: [roundMarker],
            firstRoundAt: current.updatedAt,
            exhausted: false,
          },
        },
        roundMarker,
        publication,
      }),
      result: undefined,
    }));
    const receipt = store.publishManagerValidationPublication(publication);
    const revisionBeforeFailure = root.readResumeSnapshot().findingLedger?.revision;
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TRIGGER reject_manager_finalize
      BEFORE UPDATE ON finding_ledger_heads
      BEGIN
        SELECT RAISE(ABORT, 'injected ledger finalization failure');
      END;
    `);
    database.close();

    await expect(Promise.resolve().then(() => (
      store.finalizeManagerValidationPublication(publication, receipt)
    ))).rejects.toThrow(/injected ledger finalization failure/);

    expect(root.readResumeSnapshot().findingLedger?.revision).toBe(revisionBeforeFailure);
    expect(store.loadLedger().pendingManagerCommit?.publication.publicationId)
      .toBe(publication.publicationId);

    const cleanupDatabase = new DatabaseSync(databasePath);
    cleanupDatabase.exec('DROP TRIGGER reject_manager_finalize');
    cleanupDatabase.close();
    await expect(store.finalizeManagerValidationPublication(publication, receipt))
      .resolves.toEqual(expect.objectContaining({ completedRoundMarker: roundMarker }));
  });

  it('keeps an older valid receipt finalizable after a later revision is published', async () => {
    const { root } = createRealRunStorage({
      findingContractEnabled: true,
    });
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
    const runId = store.runId;
    const first = store.bindManagerValidationPublication(
      'round-1',
      store.planManagerValidationPublication('round-1', {
        version: 1,
        runId,
        stepName: 'reviewers',
        retryCount: 0,
        ledgerUpdated: false,
        finalErrors: [],
        attempts: [],
      }),
    );
    await store.commitManagerLedger((current) => ({
      ledger: stagePendingManagerCommit({
        previousLedger: current,
        completedLedger: {
          ...current,
          stopBudget: {
            roundMarkers: ['round-1'],
            firstRoundAt: current.updatedAt,
            exhausted: false,
          },
        },
        roundMarker: 'round-1',
        publication: first,
      }),
      result: undefined,
    }));
    const firstReceipt = store.publishManagerValidationPublication(first);
    const second = store.bindManagerValidationPublication(
      'round-2',
      store.planManagerValidationPublication('round-2', {
        version: 1,
        runId,
        stepName: 'reviewers',
        retryCount: 1,
        ledgerUpdated: false,
        finalErrors: [],
        attempts: [],
      }),
    );
    const secondReceipt = store.publishManagerValidationPublication(second);

    expect(secondReceipt).toMatchObject({
      streamId: firstReceipt.streamId,
      revision: '2',
    });
    await expect(store.finalizeManagerValidationPublication(first, firstReceipt))
      .resolves.toEqual(expect.objectContaining({ completedRoundMarker: 'round-1' }));
  });

  it('rejects missing, cross-stream, cross-revision, and tampered receipts', async () => {
    const { root } = createRealRunStorage({
      findingContractEnabled: true,
    });
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
    const runId = store.runId;
    const publication = store.bindManagerValidationPublication(
      'round-1',
      store.planManagerValidationPublication('round-1', {
        version: 1,
        runId,
        stepName: 'reviewers',
        retryCount: 0,
        ledgerUpdated: false,
        finalErrors: [],
        attempts: [],
      }),
    );
    await store.commitManagerLedger((current) => ({
      ledger: stagePendingManagerCommit({
        previousLedger: current,
        completedLedger: {
          ...current,
          stopBudget: {
            roundMarkers: ['round-1'],
            firstRoundAt: current.updatedAt,
            exhausted: false,
          },
        },
        roundMarker: 'round-1',
        publication,
      }),
      result: undefined,
    }));
    const receipt = store.publishManagerValidationPublication(publication);
    const other = store.bindManagerValidationPublication(
      'round-1-other',
      store.planManagerValidationPublication('round-1-other', {
        ...publication.report,
        stepName: 'security-reviewers',
      }),
    );
    const otherReceipt = store.publishManagerValidationPublication(other);
    const later = store.bindManagerValidationPublication(
      'round-2',
      store.planManagerValidationPublication('round-2', {
        ...publication.report,
        retryCount: 1,
      }),
    );
    const laterReceipt = store.publishManagerValidationPublication(later);

    const invalidReceipts = [
      { ...receipt, revision: '999' },
      { ...receipt, streamId: otherReceipt.streamId },
      { ...receipt, revision: laterReceipt.revision },
      { ...receipt, contentSha256: '0'.repeat(64) },
      { ...receipt, publicationId: other.publicationId },
    ];
    for (const invalidReceipt of invalidReceipts) {
      await expect(Promise.resolve().then(() => (
        store.finalizeManagerValidationPublication(publication, invalidReceipt)
      ))).rejects.toThrow(/receipt mismatch/);
    }
    await expect(store.finalizeManagerValidationPublication(publication, receipt))
      .resolves.toEqual(expect.objectContaining({ completedRoundMarker: 'round-1' }));
  });

  it('deduplicates engine, manager-preparation, and retry snapshot saves by latest content', async () => {
    const { root, clock } = createRealRunStorage({
      findingContractEnabled: true,
    });
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
    const retryStore = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    const initial = store.loadLedger();

    clock.set(1_200);
    await store.updateLedger(() => ({ ledger: initial, result: undefined }));
    store.saveLedgerSnapshot();
    retryStore.saveLedgerSnapshot();
    expect(runtime.reports.history('findings-ledger.json')).toHaveLength(1);

    await store.updateLedger(() => ({
      ledger: { ...initial, nextId: 2 },
      result: undefined,
    }));
    store.saveLedgerSnapshot();
    retryStore.saveLedgerSnapshot();
    expect(runtime.reports.history('findings-ledger.json')).toHaveLength(2);

    await store.updateLedger(() => ({ ledger: initial, result: undefined }));
    store.saveLedgerSnapshot();
    retryStore.saveLedgerSnapshot();
    const history = runtime.reports.history('findings-ledger.json');
    expect(history).toHaveLength(3);
    expect(history[0]?.digest).toBe(history[2]?.digest);
    expect(history[0]?.publicationKey).not.toBe(history[2]?.publicationKey);
  });

  it('keeps artifact writes storage-internal without returning pseudo file paths', () => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
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

    expect(store.saveLedgerSnapshot()).toBeUndefined();
    const runId = store.runId;
    expect(store.saveRawFindings(
      runId,
      'reviewers',
      [],
    )).toBeUndefined();
    const publication = store.planManagerValidationPublication('round-1', {
      version: 1,
      runId,
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: false,
      finalErrors: [],
      attempts: [],
    });
    const bound = store.bindManagerValidationPublication('round-1', publication);
    const receipt = store.publishManagerValidationPublication(bound);

    expect(receipt).toEqual({
      publicationId: publication.publicationId,
      streamId: expect.any(String),
      revision: '1',
      contentSha256: publication.contentSha256,
    });
    expect(receipt).not.toHaveProperty('targetPath');
    expect(readFileSync(databasePath).includes(Buffer.from('sqlite-run://'))).toBe(false);
  });

  it('uses normalized SQLite rows as its only ledger authority', async () => {
    const { databasePath, root, clock } = createRealRunStorage({
      findingContractEnabled: true,
    });
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

    clock.set(1_200);
    await store.updateLedger((current) => ({
      ledger: { ...current, nextId: 2 },
      result: 'updated',
    }));
    writeFileSync(`${databasePath}.ledger.json`, JSON.stringify({
      workflowName: 'default',
      nextId: 999,
    }));

    expect(store.loadLedger()).toMatchObject({
      nextId: 2,
      updatedAt: '1970-01-01T00:00:01.200Z',
    });
    expect(root.readResumeSnapshot().findingLedger).toMatchObject({
      revision: 2,
      ledger: { nextId: 2 },
    });
  });

  it('rejects Finding authority when FC is disabled without affecting execution', () => {
    const { root } = createRealRunStorage({ findingContractEnabled: false });
    const owner = root.claimLease({
      ownerKey: 'owner',
      leaseDurationMs: 9_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'normal',
      expectedScopeRevision: 0,
    });

    expect(() => runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    })).toThrow(/Finding Contract is disabled/);
    expect(root.readResumeSnapshot().scopes[0]?.runtime).toMatchObject({
      status: 'running',
      revision: 1,
    });
  });
});
