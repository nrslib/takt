import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { stagePendingManagerCommit } from '../core/workflow/findings/manager-pending-commit.js';
import {
  ContextCapability,
  RunReadContext,
} from '../infra/run-storage/context.js';
import { createPublicReportStreamIdentity } from '../infra/run-storage/report-stream-identity.js';
import { ReportRepository } from '../infra/run-storage/reports.js';
import {
  openRunStorage,
  resumeRunStorage,
} from '../infra/run-storage/root.js';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
  createTestBootstrapSeed,
} from './helpers/run-storage.js';

afterEach(cleanupRealRunStorages);

function forgeReportStreamId(databasePath: string, forgedStreamId: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER report_streams_identity_guard;
    DROP TRIGGER report_revisions_update_guard;
    BEGIN IMMEDIATE;
  `);
  database.prepare('UPDATE report_revisions SET stream_id = ?').run(forgedStreamId);
  database.prepare('UPDATE report_streams SET stream_id = ?').run(forgedStreamId);
  database.exec('COMMIT');
  database.close();
}

function forgeReportStreamName(databasePath: string, forgedStreamName: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    DROP TRIGGER report_streams_identity_guard;
    BEGIN IMMEDIATE;
  `);
  database.prepare('UPDATE report_streams SET stream_name = ?').run(forgedStreamName);
  database.exec('COMMIT');
  database.close();
}

function forgeReportPortableIdentity(
  databasePath: string,
  forgedPortableIdentity: string,
): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    DROP TRIGGER report_streams_identity_guard;
    BEGIN IMMEDIATE;
  `);
  database.prepare('UPDATE report_streams SET portable_identity = ?')
    .run(forgedPortableIdentity);
  database.exec('COMMIT');
  database.close();
}

function deriveStreamId(
  runId: string,
  ownerScopeId: string,
  portableIdentity: string,
): string {
  return createHash('sha256')
    .update([runId, ownerScopeId, portableIdentity].join('\0'))
    .digest('hex');
}

function insertOrphanReportStream(
  databasePath: string,
  row: {
    readonly runId: string;
    readonly streamId: string;
    readonly streamName: string;
    readonly portableIdentity: string;
  },
): void {
  const database = new DatabaseSync(databasePath);
  database.prepare(`
    INSERT INTO report_streams (
      run_id,
      owner_scope_id,
      stream_id,
      stream_name,
      portable_identity,
      created_at
    ) VALUES (?, 'root', ?, ?, ?, 1000)
  `).run(
    row.runId,
    row.streamId,
    row.streamName,
    row.portableIdentity,
  );
  database.close();
}

function mutateReportRevision(
  databasePath: string,
  mutate: (database: DatabaseSync) => void,
): void {
  const database = new DatabaseSync(databasePath);
  const trigger = database.prepare(`
    SELECT sql
    FROM sqlite_schema
    WHERE type = 'trigger' AND name = 'report_revisions_update_guard'
  `).get() as { readonly sql: string };
  database.exec('DROP TRIGGER report_revisions_update_guard');
  try {
    mutate(database);
  } finally {
    database.exec(trigger.sql);
    database.close();
  }
}

function orphanForgery(
  kind: 'public path' | 'portable identity' | 'stream id',
  runId: string,
): {
  readonly runId: string;
  readonly streamId: string;
  readonly streamName: string;
  readonly portableIdentity: string;
} {
  if (kind === 'public path') {
    const streamName = 'nested\\orphan.json';
    return {
      runId,
      streamId: deriveStreamId(runId, 'root', streamName),
      streamName,
      portableIdentity: streamName,
    };
  }
  if (kind === 'portable identity') {
    const portableIdentity = 'forged-portable.json';
    return {
      runId,
      streamId: deriveStreamId(runId, 'root', portableIdentity),
      streamName: 'orphan.json',
      portableIdentity,
    };
  }
  return {
    runId,
    streamId: 'f'.repeat(64),
    streamName: 'orphan.json',
    portableIdentity: 'orphan.json',
  };
}

describe('run report authority', () => {
  it('rejects an ill-formed UTF-16 stream name before identity derivation at every name boundary', () => {
    const { root } = createRealRunStorage();
    const owner = root.claimLease({
      ownerKey: 'owner-1',
      leaseDurationMs: 9_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });
    const illFormedName = 'review-\uD800.json';

    expect(() => runtime.reports.publish({
      publicationKey: 'publication-ill-formed',
      streamName: illFormedName,
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{}',
      producer: execution.handle,
    })).toThrow(/well-formed UTF-16/i);
    expect(() => runtime.reports.history(illFormedName))
      .toThrow(/well-formed UTF-16/i);
    expect(() => createPublicReportStreamIdentity(illFormedName))
      .toThrow(/well-formed UTF-16/i);

    runtime.reports.publish({
      publicationKey: 'publication-replacement',
      streamName: 'review-\uFFFD.json',
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{}',
      producer: execution.handle,
    });
    expect(runtime.reports.history('review-\uFFFD.json')).toHaveLength(1);
    expect(root.readResumeSnapshot().reports).toEqual([
      expect.objectContaining({
        streamName: 'review-\uFFFD.json',
        revision: 1,
      }),
    ]);
  });

  it('accepts Unicode 17 assigned supplementary and combining code points in stream names', () => {
    const { root } = createRealRunStorage();
    const owner = root.claimLease({
      ownerKey: 'owner-1',
      leaseDurationMs: 9_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });

    for (const [index, streamName] of [
      'review-\u{1F600}.json',
      'review-\u0301.json',
    ].entries()) {
      runtime.reports.publish({
        publicationKey: `publication-assigned-${index}`,
        streamName,
        expectedRevision: 0,
        codecName: 'json-v1',
        content: '{}',
        producer: execution.handle,
      });
      expect(runtime.reports.history(streamName)).toHaveLength(1);
    }
  });

  it('rejects code points outside the Unicode 17 assigned repertoire', () => {
    const { root } = createRealRunStorage();
    const owner = root.claimLease({
      ownerKey: 'owner-1',
      leaseDurationMs: 9_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });
    const unassignedName = 'review-\u0378.json';

    expect(() => runtime.reports.publish({
      publicationKey: 'publication-unassigned',
      streamName: unassignedName,
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{}',
      producer: execution.handle,
    })).toThrow(/Unicode 17.*assigned repertoire/i);
    expect(() => runtime.reports.history(unassignedName))
      .toThrow(/Unicode 17.*assigned repertoire/i);
    expect(() => createPublicReportStreamIdentity(unassignedName))
      .toThrow(/Unicode 17.*assigned repertoire/i);
  });

  it.each([
    'public path',
    'portable identity',
    'stream id',
  ] as const)('rejects a revisionless orphan with a forged %s while opening storage', (kind) => {
    const { databasePath, root } = createRealRunStorage();
    const runId = root.readResumeSnapshot().run.runId;
    root.close();
    insertOrphanReportStream(
      databasePath,
      orphanForgery(kind, runId),
    );

    expect(() => openRunStorage({ databasePath }))
      .toThrow(/report path|portable identity|stream identity/i);
  });

  it('rejects a valid revisionless stream while opening storage', () => {
    const { databasePath, root } = createRealRunStorage();
    const runId = root.readResumeSnapshot().run.runId;
    root.close();
    const streamName = 'orphan.json';
    insertOrphanReportStream(databasePath, {
      runId,
      streamId: deriveStreamId(runId, 'root', streamName),
      streamName,
      portableIdentity: streamName,
    });

    expect(() => openRunStorage({ databasePath }))
      .toThrow(/current revision mismatch/i);
  });

  it.each([
    {
      label: 'content digest',
      mutate: (database: DatabaseSync) => database.prepare(`
        UPDATE report_revisions SET content = '{"tampered":true}'
      `).run(),
      expected: /report digest mismatch/i,
    },
    {
      label: 'publication identity',
      mutate: (database: DatabaseSync) => database.prepare(`
        UPDATE report_revisions SET publication_id = ?
      `).run('0'.repeat(64)),
      expected: /publication identity mismatch/i,
    },
    {
      label: 'producer provenance',
      mutate: (database: DatabaseSync) => database.prepare(`
        UPDATE report_revisions SET producer_step_id = 'forged-step'
      `).run(),
      expected: /producer provenance mismatch/i,
    },
    {
      label: 'revision sequence',
      mutate: (database: DatabaseSync) => database.prepare(`
        UPDATE report_revisions SET revision = 2
      `).run(),
      expected: /revision sequence mismatch/i,
    },
  ])('validates every report revision $label while opening storage', ({
    mutate,
    expected,
  }) => {
    const { databasePath, root } = createRealRunStorage();
    const owner = root.claimLease({
      ownerKey: 'open-validation-owner',
      leaseDurationMs: 9_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'open-validation',
      expectedScopeRevision: 0,
    });
    runtime.reports.publish({
      publicationKey: 'open-validation-publication',
      streamName: 'open-validation.json',
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{"valid":true}',
      producer: execution.handle,
    });
    root.close();
    mutateReportRevision(databasePath, mutate);

    expect(() => openRunStorage({ databasePath })).toThrow(expected);
  });

  it.each([
    {
      label: 'content digest',
      mutate: (database: DatabaseSync) => database.prepare(`
        UPDATE report_revisions
        SET content = '{"tampered":true}'
        WHERE revision = 2
      `).run(),
      expected: /report digest mismatch/i,
    },
    {
      label: 'publication identity',
      mutate: (database: DatabaseSync) => database.prepare(`
        UPDATE report_revisions
        SET publication_key = 'forged-publication-key'
        WHERE revision = 2
      `).run(),
      expected: /publication identity mismatch/i,
    },
    {
      label: 'producer provenance',
      mutate: (database: DatabaseSync) => database.prepare(`
        UPDATE report_revisions
        SET producer_step_id = 'forged-step'
        WHERE revision = 2
      `).run(),
      expected: /producer provenance mismatch/i,
    },
    {
      label: 'revision gap',
      mutate: (database: DatabaseSync) => database.prepare(`
        UPDATE report_revisions SET revision = 3 WHERE revision = 2
      `).run(),
      expected: /revision sequence mismatch/i,
    },
  ])('rejects live report $label corruption at every read and replay boundary', ({
    label,
    mutate,
    expected,
  }) => {
    const { databasePath, root } = createRealRunStorage();
    const owner = root.claimLease({
      ownerKey: `live-report-${label}`,
      leaseDurationMs: 9_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'live-report-validation',
      expectedScopeRevision: 0,
    });
    const firstPublication = {
      publicationKey: 'live-publication-1',
      streamName: 'live-report.json',
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{"revision":1}',
      producer: execution.handle,
    } as const;
    const replayedPublication = {
      ...firstPublication,
      publicationKey: 'live-publication-2',
      expectedRevision: 1,
      content: '{"revision":2}',
    } as const;
    runtime.reports.publish(firstPublication);
    runtime.reports.publish(replayedPublication);
    mutateReportRevision(databasePath, mutate);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    const context = new RunReadContext(database, new ContextCapability());
    const repository = new ReportRepository();
    const stream = createPublicReportStreamIdentity('live-report.json');
    const run = database.prepare(
      'SELECT run_id AS runId FROM runs',
    ).get() as { readonly runId: string };
    const repositoryInput = {
      runId: run.runId,
      ownerScopeId: 'root',
      stream,
    };
    expect(() => repository.history(context, repositoryInput)).toThrow(expected);
    expect(() => repository.revision(context, {
      ...repositoryInput,
      revision: 1,
    })).toThrow(expected);
    expect(() => repository.latest(context, repositoryInput)).toThrow(expected);
    database.close();

    expect(() => runtime.reports.publish(replayedPublication)).toThrow(expected);
    expect(() => root.readResumeSnapshot()).toThrow(expected);
    expect(() => resumeRunStorage({
      databasePath: `${databasePath}.corrupt-resume-${label.replaceAll(' ', '-')}`,
      source: root,
      bootstrapSeed: createTestBootstrapSeed({
        sessionId: 'corrupt-report-resume-session',
      }),
      run: {
        runId: 'corrupt-report-resume',
        workflowName: 'default',
        findingContractEnabled: false,
      },
    })).toThrow(expected);
  });

  it.each([
    'public path',
    'portable identity',
    'stream id',
  ] as const)('rejects a revisionless orphan with a forged %s while resuming storage', (kind) => {
    const { databasePath, root } = createRealRunStorage();
    const runId = root.readResumeSnapshot().run.runId;
    insertOrphanReportStream(
      databasePath,
      orphanForgery(kind, runId),
    );

    expect(() => root.readResumeSnapshot())
      .toThrow(/report path|portable identity|stream identity/i);
  });

  it.each([
    'nested\\review.json',
    'nested//review.json',
    'nested/./review.json',
    'nested/../review.json',
    'resume-artifacts.json',
    '.takt-report-internal/review.json',
  ])('rejects non-canonical or reserved public stream name %s at write and read boundaries', (streamName) => {
    const { root } = createRealRunStorage();
    const owner = root.claimLease({
      ownerKey: 'owner-1',
      leaseDurationMs: 9_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });

    expect(() => runtime.reports.publish({
      publicationKey: 'publication-1',
      streamName,
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{}',
      producer: execution.handle,
    })).toThrow(/report.*path|reserved|internal/i);
    expect(() => runtime.reports.history(streamName))
      .toThrow(/report.*path|reserved|internal/i);
  });

  it('uses one portable case-fold identity without accepting a case alias as another stream', () => {
    const { root } = createRealRunStorage();
    const owner = root.claimLease({
      ownerKey: 'owner-1',
      leaseDurationMs: 9_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });
    runtime.reports.publish({
      publicationKey: 'publication-upper',
      streamName: 'Review.json',
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{"case":"upper"}',
      producer: execution.handle,
    });

    expect(() => runtime.reports.publish({
      publicationKey: 'publication-lower',
      streamName: 'review.json',
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{"case":"lower"}',
      producer: execution.handle,
    })).toThrow(/report stream.*portable identity|report stream.*collision/i);
    expect(runtime.reports.history('Review.json')).toHaveLength(1);
    expect(() => runtime.reports.history('review.json'))
      .toThrow(/report stream.*portable identity|report stream.*collision/i);
  });

  it.each([
    ['ASCII case', 'Review.json', 'review.json'],
    ['Unicode sigma', 'review-σ.json', 'review-ς.json'],
    ['full case-fold expansion', 'Straße.json', 'STRASSE.json'],
    ['NFC-equivalent spelling', 'café.json', 'cafe\u0301.json'],
  ])('rejects a %s alias as another stream for the same owner', (
    _case,
    firstName,
    aliasName,
  ) => {
    const { root } = createRealRunStorage();
    const owner = root.claimLease({
      ownerKey: 'owner-1',
      leaseDurationMs: 9_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });
    runtime.reports.publish({
      publicationKey: 'publication-first',
      streamName: firstName,
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{}',
      producer: execution.handle,
    });

    expect(() => runtime.reports.publish({
      publicationKey: 'publication-alias',
      streamName: aliasName,
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{}',
      producer: execution.handle,
    })).toThrow(/report stream.*portable identity|report stream.*collision/i);
    expect(() => runtime.reports.history(aliasName))
      .toThrow(/report stream.*portable identity|report stream.*collision/i);
  });

  it('stores publication revision history with owner and producer attribution', () => {
    const { root } = createRealRunStorage();
    const owner = root.claimLease({
      ownerKey: 'owner-1',
      leaseDurationMs: 9_000,
    });
    const rootRuntime = root.runtime({ lease: owner });
    const reviewerScope = rootRuntime.scopes.createParallelChild({
      scopeKey: 'reviewer',
    });
    const reviewer = root.runtime({ lease: owner, scope: reviewerScope });
    const execution = reviewer.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });
    const attribution = {
      producer: execution.handle,
    };

    rootRuntime.reports.publish({
      ...attribution,
      publicationKey: 'publication-1',
      streamName: 'review.json',
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{"revision":1}',
    });
    rootRuntime.reports.publish({
      ...attribution,
      publicationKey: 'publication-2',
      streamName: 'review.json',
      expectedRevision: 1,
      codecName: 'json-v1',
      content: '{"revision":2}',
    });

    expect(rootRuntime.reports.history('review.json')).toEqual([
      expect.objectContaining({
        revision: 1,
        ownerScopeId: 'root',
        producerStepId: 'review',
      }),
      expect.objectContaining({
        revision: 2,
        ownerScopeId: 'root',
        producerStepId: 'review',
      }),
    ]);
  });

  it('rejects attribution to an execution in a different scope', () => {
    const { root } = createRealRunStorage();
    const owner = root.claimLease({
      ownerKey: 'owner-1',
      leaseDurationMs: 9_000,
    });
    const rootRuntime = root.runtime({ lease: owner });
    rootRuntime.scopes.createParallelChild({ scopeKey: 'reviewer' });
    const execution = rootRuntime.execution.startStep({
      stepKey: 'root-step',
      expectedScopeRevision: 0,
    });

    expect(() => rootRuntime.reports.publish({
      publicationKey: 'publication-1',
      streamName: 'invalid.json',
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{}',
      producer: Object.freeze({}) as never,
    })).toThrow(/forged/i);
  });

  it('rejects a forged stream identity at receipt, history, and resume boundaries', () => {
    const { databasePath, root } = createRealRunStorage();
    const owner = root.claimLease({
      ownerKey: 'owner-1',
      leaseDurationMs: 9_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });
    const publication = {
      publicationKey: 'publication-1',
      streamName: 'review.json',
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{"revision":1}',
      producer: execution.handle,
    } as const;
    runtime.reports.publish(publication);

    const forgedStreamId = 'f'.repeat(64);
    forgeReportStreamId(databasePath, forgedStreamId);

    expect(() => runtime.reports.publish(publication)).toThrow(/stream identity/i);
    expect(() => runtime.reports.history('review.json')).toThrow(/stream identity/i);
    expect(() => root.readResumeSnapshot()).toThrow(/report.*identity/i);
  });

  it('reconstructs stored stream identity through the public path contract', () => {
    const { databasePath, root } = createRealRunStorage();
    const owner = root.claimLease({
      ownerKey: 'owner-1',
      leaseDurationMs: 9_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });
    runtime.reports.publish({
      publicationKey: 'publication-1',
      streamName: 'review.json',
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{}',
      producer: execution.handle,
    });

    forgeReportStreamName(databasePath, 'nested\\review.json');

    expect(() => runtime.reports.history('review.json'))
      .toThrow(/report path.*canonical/i);
    expect(() => root.readResumeSnapshot())
      .toThrow(/report path.*canonical/i);
  });

  it('rejects a forged stored portable identity at history and resume boundaries', () => {
    const { databasePath, root } = createRealRunStorage();
    const owner = root.claimLease({
      ownerKey: 'owner-1',
      leaseDurationMs: 9_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });
    runtime.reports.publish({
      publicationKey: 'publication-1',
      streamName: 'review-σ.json',
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{}',
      producer: execution.handle,
    });

    forgeReportPortableIdentity(databasePath, 'review-ς.json');

    expect(() => runtime.reports.history('review-σ.json'))
      .toThrow(/portable identity mismatch/i);
    expect(() => root.readResumeSnapshot())
      .toThrow(/portable identity mismatch/i);
  });

  it('rejects a forged stream identity through revision-backed receipt finalization', async () => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
    const owner = root.claimLease({
      ownerKey: 'owner-1',
      leaseDurationMs: 9_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'finding-manager',
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
      retryCount: 0,
      ledgerUpdated: false,
      finalErrors: [],
      attempts: [],
    };
    const publication = store.bindManagerValidationPublication(
      'round-1',
      store.planManagerValidationPublication('round-1', report),
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
    const forgedStreamId = 'e'.repeat(64);
    forgeReportStreamId(databasePath, forgedStreamId);

    await expect(Promise.resolve().then(() => (
      store.finalizeManagerValidationPublication(
        publication,
        { ...receipt, streamId: forgedStreamId },
      )
    ))).rejects.toThrow(/stream identity/i);
  });
});
