import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APPLICATION_ID,
  EXPECTED_SCHEMA_HASH,
  SCHEMA_VERSION,
} from '../infra/run-storage/contract.js';
import { openRunStorage } from '../infra/run-storage/root.js';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
  resumeRealRunStorage,
} from './helpers/run-storage.js';

afterEach(cleanupRealRunStorages);

function tableNames(databasePath: string): string[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table'
      ORDER BY name
    `).all().map((row) => String(row.name));
  } finally {
    database.close();
  }
}

function columnNames(databasePath: string, table: string): string[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name));
  } finally {
    database.close();
  }
}

function mutateDatabase(
  databasePath: string,
  command: (database: DatabaseSync) => void,
): void {
  const database = new DatabaseSync(databasePath);
  try {
    command(database);
  } finally {
    database.close();
  }
}

function mutateWithTriggerDisabled(
  databasePath: string,
  triggerName: string,
  command: (database: DatabaseSync) => void,
): void {
  mutateDatabase(databasePath, (database) => {
    const trigger = database.prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'trigger' AND name = ?
    `).get(triggerName) as { readonly sql: string } | undefined;
    if (trigger === undefined) {
      throw new Error(`Missing test trigger "${triggerName}"`);
    }
    database.exec(`DROP TRIGGER ${triggerName}`);
    try {
      command(database);
    } finally {
      if (database.isTransaction) {
        database.exec('ROLLBACK');
      }
      database.exec(trigger.sql);
    }
  });
}

describe('run storage schema contract', () => {
  it('keeps workflow and engine identity outside the SQLite schema', () => {
    const disabled = createRealRunStorage({ findingContractEnabled: false });
    const enabled = createRealRunStorage({ findingContractEnabled: true });
    disabled.root.close();
    enabled.root.close();

    for (const databasePath of [disabled.databasePath, enabled.databasePath]) {
      expect(tableNames(databasePath)).not.toEqual(expect.arrayContaining([
        'engine_builds',
        'workflow_definitions',
        'finding_resume_authorities',
        'finding_revision_publications',
        'run_ancestry',
        'run_resume_sources',
      ]));
      expect(columnNames(databasePath, 'runs')).not.toEqual(
        expect.arrayContaining(['engine_build_id', 'workflow_definition_id']),
      );
      expect(columnNames(databasePath, 'scopes')).not.toContain(
        'workflow_definition_id',
      );
      expect(columnNames(databasePath, 'finding_ledger_revisions')).not.toContain(
        'workflow_name',
      );
      expect(columnNames(databasePath, 'finding_ledger_heads')).not.toContain(
        'workflow_name',
      );
    }
  });

  it('uses schema version 3 without migrating old schemas', () => {
    const { databasePath, root } = createRealRunStorage();
    root.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 3,
      });
      expect(database.prepare(`
        SELECT schema_version AS schemaVersion
        FROM storage_contract
      `).get()).toEqual({ schemaVersion: 3 });
    } finally {
      database.close();
    }
  });

  it('stores the fixed schema identity contract', () => {
    const { databasePath, root } = createRealRunStorage();
    root.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare('PRAGMA application_id').get()).toEqual({
        application_id: APPLICATION_ID,
      });
      expect(database.prepare('PRAGMA user_version').get()).toEqual({
        user_version: SCHEMA_VERSION,
      });
      expect(database.prepare(`
        SELECT schema_hash AS schemaHash
        FROM storage_contract
      `).get()).toEqual({
        schemaHash: EXPECTED_SCHEMA_HASH,
      });
    } finally {
      database.close();
    }
  });

  it.each([
    {
      label: 'application id',
      mutate: (database: DatabaseSync) => {
        database.exec('PRAGMA application_id = 1');
      },
      expected: /application_id mismatch/i,
    },
    {
      label: 'schema version',
      mutate: (database: DatabaseSync) => {
        database.exec('PRAGMA user_version = 99');
      },
      expected: /schema_version mismatch/i,
    },
    {
      label: 'stored schema hash',
      mutate: (database: DatabaseSync) => {
        database.prepare(`
          UPDATE storage_contract SET schema_hash = ?
        `).run('0'.repeat(64));
      },
      expected: /stored schema hash mismatch/i,
    },
  ])('rejects invalid $label when opening a run', ({ mutate, expected }) => {
    const { databasePath, root } = createRealRunStorage();
    root.close();
    mutateDatabase(databasePath, mutate);

    expect(() => openRunStorage({ databasePath })).toThrow(expected);
  });

  it('rejects a fixed DDL mismatch when opening a run', () => {
    const { databasePath, root } = createRealRunStorage();
    root.close();
    mutateDatabase(databasePath, (database) => {
      database.exec('CREATE TABLE unexpected_table (value TEXT) STRICT');
    });

    expect(() => openRunStorage({ databasePath }))
      .toThrow(/schema hash mismatch/i);
  });

  it('keeps composite scope authority in execution, reports, and Finding state', () => {
    const { databasePath, root } = createRealRunStorage();
    root.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const foreignKeyColumns = (table: string) => database.prepare(
        `PRAGMA foreign_key_list(${table})`,
      ).all().map((row) => String(row.from));

      expect(foreignKeyColumns('phase_executions')).toEqual(
        expect.arrayContaining(['run_id', 'scope_id', 'step_execution_id']),
      );
      expect(foreignKeyColumns('report_revisions')).toEqual(
        expect.arrayContaining([
          'run_id',
          'owner_scope_id',
          'producer_scope_id',
          'producer_execution_id',
        ]),
      );
      expect(foreignKeyColumns('finding_raw_entries')).toEqual(
        expect.arrayContaining(['run_id', 'scope_id', 'revision']),
      );
    } finally {
      database.close();
    }
  });

  it('creates Finding state lazily from the resolved runtime workflow', () => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
    expect(root.readResumeSnapshot().findingHeads).toEqual([]);
    const lease = root.claimLease({
      ownerKey: 'lazy-finding',
      leaseDurationMs: 10_000,
    });
    const runtime = root.runtime({ lease });
    const execution = runtime.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'runtime-workflow',
      producer: execution.handle,
    });
    expect(store.loadLedger().workflowName).toBe('runtime-workflow');
    expect(root.readResumeSnapshot().findingHeads).toHaveLength(1);
    root.close();
    expect(columnNames(databasePath, 'finding_ledger_heads')).not.toContain(
      'workflow_name',
    );
  });

  it('rejects an enabled Finding scope whose current head is missing', () => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
    const owner = root.claimLease({
      ownerKey: 'missing-current-head',
      leaseDurationMs: 10_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });
    runtime.findingManager({
      workflowName: 'runtime-workflow',
      producer: execution.handle,
    }).loadLedger();
    root.close();

    mutateWithTriggerDisabled(
      databasePath,
      'finding_ledger_heads_delete_guard',
      (database) => {
        database.prepare(`
          DELETE FROM finding_ledger_heads
          WHERE run_id = 'run-1' AND scope_id = 'root'
        `).run();
      },
    );

    expect(() => openRunStorage({ databasePath }))
      .toThrow(/Finding Contract scope authority invariant/i);
  });

  it('rejects Finding Contract scope demotion at the DDL boundary', () => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
    const owner = root.claimLease({
      ownerKey: 'scope-demotion',
      leaseDurationMs: 10_000,
    });
    root.runtime({ lease: owner }).scopes.createParallelChild({
      scopeKey: 'scope-demotion-child',
    });
    const childScopeId = root.readResumeSnapshot().scopes.find(
      (scope) => scope.kind === 'parallel',
    )!.scopeId;
    root.close();

    const database = new DatabaseSync(databasePath);
    try {
      expect(() => database.prepare(`
        UPDATE scopes
        SET finding_contract_enabled = 0
        WHERE run_id = 'run-1' AND scope_id = 'root'
      `).run()).toThrow(/root scope identity/i);
      expect(() => database.prepare(`
        UPDATE scopes
        SET finding_contract_enabled = 0
        WHERE run_id = 'run-1' AND scope_id = ?
      `).run(childScopeId)).toThrow(/child scope identity/i);
    } finally {
      database.close();
    }
  });

  it('stores portable report identity with owner-scoped uniqueness', () => {
    const { databasePath, root } = createRealRunStorage();
    root.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const columns = database.prepare('PRAGMA table_info(report_streams)')
        .all()
        .map((row) => String(row.name));
      const uniqueIndexes = database.prepare('PRAGMA index_list(report_streams)')
        .all()
        .filter((row) => Number(row.unique) === 1)
        .map((row) => database.prepare(
          `PRAGMA index_info(${String(row.name)})`,
        ).all().map((column) => String(column.name)));

      expect(columns).toContain('portable_identity');
      expect(uniqueIndexes).toContainEqual([
        'run_id',
        'owner_scope_id',
        'portable_identity',
      ]);
    } finally {
      database.close();
    }
  });

  it('rejects a gap in the append-only step iteration sequence', () => {
    const { databasePath, root } = createRealRunStorage();
    root.close();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec('PRAGMA foreign_keys = ON');
      const authority = database.prepare(`
        SELECT run_id AS runId, scope_id AS scopeId
        FROM scopes
        WHERE parent_scope_id IS NULL
      `).get() as { readonly runId: string; readonly scopeId: string };
      database.prepare(`
        UPDATE scope_runtime
        SET current_step_id = 'review', status = 'running',
          revision = 1, updated_at = 1000
        WHERE run_id = ? AND scope_id = ?
      `).run(authority.runId, authority.scopeId);

      expect(() => database.prepare(`
        INSERT INTO step_executions (
          run_id, scope_id, execution_id, step_id,
          iteration, status, started_at
        ) VALUES (
          ?, ?, 'invalid-gap', 'review',
          2, 'running', 1000
        )
      `).run(authority.runId, authority.scopeId))
        .toThrow(/step iteration sequence/i);
    } finally {
      database.close();
    }
  });

  it('terminalizes run, root scope, and lease atomically without resurrection', () => {
    const { root, clock } = createRealRunStorage();
    const owner = root.claimLease({
      ownerKey: 'terminal-owner',
      leaseDurationMs: 9_000,
    });
    clock.set(2_000);

    root.finishRun(owner, {
      status: 'failed',
      failureReason: 'test failure',
      publication: {
        status: 'failed',
        iteration: 1,
        reason: 'test failure',
        payload: '{}',
      },
    });
    const snapshot = root.readResumeSnapshot();

    expect(snapshot.run).toMatchObject({
      status: 'failed',
      terminalAt: 2_000,
    });
    expect(snapshot.scopes[0]).toMatchObject({
      terminalAt: 2_000,
      runtime: { status: 'failed', updatedAt: 2_000 },
    });
    expect(snapshot.leases[0]).toMatchObject({
      terminal_status: 'failed',
      terminalized_at: 2_000,
    });
    expect(() => root.finishRun(owner, {
      status: 'completed',
      publication: {
        status: 'completed',
        iteration: 1,
        payload: '{}',
      },
    })).toThrow(/stale|terminal/i);
  });

  it('takes bootstrap and lazy Finding timestamps from the trusted clock', () => {
    const { root } = createRealRunStorage({ findingContractEnabled: true });
    const bootstrap = root.readResumeSnapshot();
    expect(bootstrap.run.createdAt).toBe(1_000);
    expect(bootstrap.scopes[0]).toMatchObject({
      createdAt: 1_000,
      runtime: { updatedAt: 1_000 },
    });

    const lease = root.claimLease({
      ownerKey: 'trusted-clock-finding',
      leaseDurationMs: 10_000,
    });
    const runtime = root.runtime({ lease });
    const execution = runtime.execution.startStep({
      stepKey: 'trusted-clock-review',
      expectedScopeRevision: 0,
    });
    runtime.findingManager({
      workflowName: 'trusted-clock-workflow',
      producer: execution.handle,
    }).loadLedger();
    expect(root.readResumeSnapshot().findingRevisions[0]?.updated_at).toBe(1_000);
  });

  it('resumes Finding state under a different workflow name', async () => {
    const source = createRealRunStorage({ findingContractEnabled: true });
    const lease = source.root.claimLease({
      ownerKey: 'source-finding',
      leaseDurationMs: 10_000,
    });
    const sourceRuntime = source.root.runtime({ lease });
    const execution = sourceRuntime.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });
    const sourceStore = sourceRuntime.findingManager({
      workflowName: 'source-workflow',
      producer: execution.handle,
    });
    await sourceStore.updateLedger((current) => ({
      ledger: { ...current, nextId: 7 },
      result: undefined,
    }));

    const target = resumeRealRunStorage(source.root, {
      slug: 'renamed-workflow-run',
      findingContractEnabled: true,
    });
    const targetLease = target.root.claimLease({
      ownerKey: 'target-finding',
      leaseDurationMs: 10_000,
    });
    const targetRuntime = target.root.runtime({ lease: targetLease });
    const targetExecution = targetRuntime.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });
    const targetStore = targetRuntime.findingManager({
      workflowName: 'target-workflow',
      producer: targetExecution.handle,
    });
    expect(targetStore.loadLedger()).toMatchObject({
      workflowName: 'target-workflow',
      nextId: 7,
    });
    expect(target.root.readResumeSnapshot().findingRevisions).toHaveLength(1);
  });
});
