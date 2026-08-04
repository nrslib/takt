import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '../shared/utils/canonical-json.js';
import {
  APPLICATION_ID,
  EXPECTED_SCHEMA_HASH,
  SCHEMA_VERSION,
  STORAGE_CONTRACT_FINGERPRINT,
} from '../infra/run-storage/contract.js';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LeaseHandle } from '../infra/run-storage/runtime-handles.js';
import {
  createRunStorage,
  openRunStorage,
  resumeRunStorage,
} from '../infra/run-storage/root.js';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
} from './helpers/run-storage.js';

afterEach(cleanupRealRunStorages);

function mutateDatabase(
  databasePath: string,
  command: (database: DatabaseSync) => void,
): void {
  const database = new DatabaseSync(databasePath);
  command(database);
  database.close();
}

function mutateWithTriggerDisabled(
  databasePath: string,
  triggerName: string,
  command: (database: DatabaseSync) => void,
): void {
  mutateWithTriggersDisabled(databasePath, [triggerName], command);
}

function mutateWithTriggersDisabled(
  databasePath: string,
  triggerNames: readonly string[],
  command: (database: DatabaseSync) => void,
): void {
  const database = new DatabaseSync(databasePath);
  const triggers = triggerNames.map((triggerName) => database.prepare(`
    SELECT sql
    FROM sqlite_schema
    WHERE type = 'trigger' AND name = ?
  `).get(triggerName) as { readonly sql: string });
  for (const triggerName of triggerNames) {
    database.exec(`DROP TRIGGER ${triggerName}`);
  }
  try {
    command(database);
  } finally {
    if (database.isTransaction) {
      database.exec('ROLLBACK');
    }
    for (const trigger of triggers) {
      database.exec(trigger.sql);
    }
    database.close();
  }
}

describe('run storage schema contract', () => {
  it('creates one fixed schema for FC on and off without legacy authority tables', () => {
    const disabled = createRealRunStorage({ findingContractEnabled: false });
    const enabled = createRealRunStorage({ findingContractEnabled: true });
    disabled.root.close();
    enabled.root.close();

    const disabledDb = new DatabaseSync(disabled.databasePath, { readOnly: true });
    const enabledDb = new DatabaseSync(enabled.databasePath, { readOnly: true });
    const tableNames = (database: DatabaseSync) => database.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table'
      ORDER BY name
    `).all().map((row) => row.name);
    expect(tableNames(disabledDb)).toEqual(tableNames(enabledDb));
    expect(tableNames(disabledDb)).toContain('finding_ledger_revisions');
    expect(tableNames(disabledDb)).not.toContain('finding_ledger_state');
    expect(tableNames(disabledDb)).not.toContain('run_head');
    expect(disabledDb.prepare(`
      SELECT count(*) AS count FROM finding_ledger_heads
    `).get()).toEqual({ count: 0 });
    expect(enabledDb.prepare(`
      SELECT count(*) AS count FROM finding_ledger_heads
    `).get()).toEqual({ count: 1 });
    disabledDb.close();
    enabledDb.close();
  });

  it('stores the fixed schema and fingerprint contract', () => {
    const { databasePath, root } = createRealRunStorage();
    root.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });

    expect(database.prepare('PRAGMA application_id').get())
      .toEqual({ application_id: APPLICATION_ID });
    expect(database.prepare('PRAGMA user_version').get())
      .toEqual({ user_version: SCHEMA_VERSION });
    expect(database.prepare(`
      SELECT schema_hash AS schemaHash, fingerprint
      FROM storage_contract
    `).get()).toEqual({
      schemaHash: EXPECTED_SCHEMA_HASH,
      fingerprint: STORAGE_CONTRACT_FINGERPRINT,
    });
    database.close();
  });

  it.each([
    {
      label: 'application id',
      mutate: (database: DatabaseSync) => database.exec('PRAGMA application_id = 1'),
      expected: /application_id mismatch/i,
    },
    {
      label: 'schema version',
      mutate: (database: DatabaseSync) => database.exec('PRAGMA user_version = 99'),
      expected: /schema_version mismatch/i,
    },
    {
      label: 'stored schema hash',
      mutate: (database: DatabaseSync) => database.prepare(`
        UPDATE storage_contract SET schema_hash = ?
      `).run('0'.repeat(64)),
      expected: /stored schema hash mismatch/i,
    },
    {
      label: 'stored fingerprint',
      mutate: (database: DatabaseSync) => database.prepare(`
        UPDATE storage_contract SET fingerprint = ?
      `).run('0'.repeat(64)),
      expected: /stored fingerprint mismatch/i,
    },
  ])('fails fast for invalid $label', ({ mutate, expected }) => {
    const { databasePath, root } = createRealRunStorage();
    root.close();
    mutateDatabase(databasePath, mutate);

    expect(() => openRunStorage({ databasePath })).toThrow(expected);
  });

  it('fails fast when the fixed DDL is changed', () => {
    const { databasePath, root } = createRealRunStorage();
    root.close();
    mutateDatabase(databasePath, (database) => {
      database.exec('CREATE TABLE injected (value TEXT) STRICT');
    });

    expect(() => openRunStorage({ databasePath })).toThrow(/schema hash mismatch/i);
  });

  it('derives workflow identity and verifies definition content on open', () => {
    const { databasePath, root } = createRealRunStorage();
    const snapshot = root.readResumeSnapshot();
    expect(snapshot.workflowDefinitions[0]).toMatchObject({
      name: 'default',
      codecName: 'json-v1',
      definition: '{"name":"default"}',
    });
    root.close();
    mutateDatabase(databasePath, (database) => {
      database.prepare(`
        UPDATE workflow_definitions SET definition = '{"name":"tampered"}'
      `).run();
    });

    expect(() => openRunStorage({ databasePath }))
      .toThrow(/workflow definition identity mismatch/i);
  });

  it('uses composite scope authority in execution, reports, and Finding history', () => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
    root.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const foreignKeyColumns = (table: string) => database.prepare(
      `PRAGMA foreign_key_list(${table})`,
    ).all().map((row) => row.from);

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
    database.close();
  });

  it('fails fast when a parallel Finding authority head is missing', () => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
    const owner = root.claimLease({
      ownerKey: 'parallel-head-owner',
      leaseDurationMs: 9_000,
    });
    root.runtime({ lease: owner }).scopes.createParallelChild({
      scopeKey: 'parallel-head',
    });
    const parallelScopeId = root.readResumeSnapshot().scopes.find(
      (scope) => scope.kind === 'parallel',
    )!.scopeId;
    root.close();
    mutateWithTriggerDisabled(
      databasePath,
      'finding_ledger_heads_delete_guard',
      (database) => {
        database.prepare(`
          DELETE FROM finding_ledger_heads WHERE scope_id = ?
        `).run(parallelScopeId);
      },
    );

    expect(() => openRunStorage({ databasePath }))
      .toThrow(/Finding Contract scope authority invariant/i);
  });

  it('fails fast when a workflow_call owns a Finding authority head', () => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
    const owner = root.claimLease({
      ownerKey: 'workflow-head-owner',
      leaseDurationMs: 9_000,
    });
    root.runtime({ lease: owner }).scopes.createParallelChild({
      scopeKey: 'scope-kind-forgery',
    });
    const parallelScopeId = root.readResumeSnapshot().scopes.find(
      (scope) => scope.kind === 'parallel',
    )!.scopeId;
    root.close();
    mutateWithTriggerDisabled(
      databasePath,
      'child_scope_identity_guard',
      (database) => {
        database.prepare(`
          UPDATE scopes SET kind = 'workflow_call' WHERE scope_id = ?
        `).run(parallelScopeId);
      },
    );

    expect(() => openRunStorage({ databasePath }))
      .toThrow(/Finding Contract scope authority invariant/i);
  });

  it('fails fast when a Finding head workflow differs from its scope definition', () => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
    root.close();
    mutateWithTriggerDisabled(
      databasePath,
      'finding_ledger_head_transition_guard',
      (database) => {
        database.prepare(`
          UPDATE finding_ledger_heads SET workflow_name = 'forged-workflow'
        `).run();
      },
    );

    expect(() => openRunStorage({ databasePath }))
      .toThrow(/Finding Contract scope authority invariant/i);
  });

  it.each([
    'missing workflow definition',
    'missing parallel scope',
    'missing parallel head',
    'missing current revision',
    'workflow_call head',
    'workflow name mismatch',
  ])('fails fast for live Finding authority corruption: %s', (corruption) => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
    const owner = root.claimLease({
      ownerKey: `live-finding-${corruption}`,
      leaseDurationMs: 9_000,
    });
    const rootRuntime = root.runtime({ lease: owner });
    rootRuntime.scopes.createParallelChild({
      scopeKey: 'live-finding-parallel',
    });
    const parallelScopeId = root.readResumeSnapshot().scopes.find(
      (scope) => scope.kind === 'parallel',
    )!.scopeId;

    if (corruption === 'missing workflow definition') {
      mutateDatabase(databasePath, (database) => {
        database.exec('PRAGMA foreign_keys = OFF');
        database.exec('DELETE FROM workflow_definitions');
      });
    } else if (corruption === 'missing parallel scope') {
      mutateWithTriggerDisabled(
        databasePath,
        'child_scope_delete_guard',
        (database) => {
          database.exec('PRAGMA foreign_keys = OFF');
          database.prepare(`
            DELETE FROM scopes WHERE scope_id = ?
          `).run(parallelScopeId);
        },
      );
    } else if (corruption === 'missing parallel head') {
      mutateWithTriggerDisabled(
        databasePath,
        'finding_ledger_heads_delete_guard',
        (database) => {
          database.prepare(`
            DELETE FROM finding_ledger_heads WHERE scope_id = ?
          `).run(parallelScopeId);
        },
      );
    } else if (corruption === 'missing current revision') {
      mutateWithTriggerDisabled(
        databasePath,
        'finding_ledger_revisions_delete_guard',
        (database) => {
          database.exec('PRAGMA foreign_keys = OFF');
          database.prepare(`
            DELETE FROM finding_ledger_revisions WHERE scope_id = ?
          `).run(parallelScopeId);
        },
      );
    } else if (corruption === 'workflow_call head') {
      mutateWithTriggerDisabled(
        databasePath,
        'child_scope_identity_guard',
        (database) => {
          database.prepare(`
            UPDATE scopes SET kind = 'workflow_call' WHERE scope_id = ?
          `).run(parallelScopeId);
        },
      );
    } else {
      mutateWithTriggerDisabled(
        databasePath,
        'finding_ledger_head_transition_guard',
        (database) => {
          database.prepare(`
            UPDATE finding_ledger_heads
            SET workflow_name = 'forged-workflow'
            WHERE scope_id = ?
          `).run(parallelScopeId);
        },
      );
    }

    const expected = /foreign_key_check|Finding Contract scope authority invariant/i;
    expect(() => openRunStorage({ databasePath })).toThrow(expected);
    expect(() => root.readResumeSnapshot()).toThrow(expected);
    expect(() => resumeRunStorage({
      databasePath: `${databasePath}.corrupt-resume-${corruption.replaceAll(' ', '-')}`,
      source: root,
      run: {
        slug: 'corrupt-finding-resume',
        findingContractEnabled: true,
      },
      workflowDefinition: {
        name: 'default',
        codecName: 'json-v1',
        definition: '{"name":"default"}',
      },
    })).toThrow(expected);
  });

  it('rejects a self-consistent non-head Finding revision workflow mismatch', async () => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
    const initialLedger = root.readResumeSnapshot().findingLedger!.ledger;
    const owner = root.claimLease({
      ownerKey: 'historical-workflow-mismatch',
      leaseDurationMs: 9_000,
    });
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'historical-workflow-mismatch',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    await store.updateLedger((current) => ({
      ledger: {
        ...current,
        nextId: current.nextId + 1,
      },
      result: undefined,
    }));

    const forgedLedger = {
      ...initialLedger,
      workflowName: 'forged-workflow',
    };
    const forgedDigest = createHash('sha256')
      .update(canonicalJson(forgedLedger))
      .digest('hex');
    mutateWithTriggersDisabled(
      databasePath,
      [
        'finding_ledger_revisions_update_guard',
        'finding_revision_publications_update_guard',
      ],
      (database) => {
        database.exec('BEGIN');
        database.prepare(`
          UPDATE finding_ledger_revisions
          SET workflow_name = 'forged-workflow', projection_digest = ?
          WHERE scope_id = 'root' AND revision = 1
        `).run(forgedDigest);
        database.prepare(`
          UPDATE finding_revision_publications
          SET projection_digest = ?
          WHERE scope_id = 'root' AND revision = 1
        `).run(forgedDigest);
        database.exec('COMMIT');
      },
    );

    const expected = /Finding authority revision workflow mismatch/i;
    expect(() => openRunStorage({ databasePath })).toThrow(expected);
    expect(() => root.readResumeSnapshot()).toThrow(expected);
    expect(() => resumeRunStorage({
      databasePath: `${databasePath}.corrupt-resume`,
      source: root,
      run: {
        slug: 'corrupt-finding-history-resume',
        findingContractEnabled: true,
      },
      workflowDefinition: {
        name: 'default',
        codecName: 'json-v1',
        definition: '{"name":"default"}',
      },
    })).toThrow(expected);
  });

  it('stores portable report identity and enforces owner-scoped uniqueness', () => {
    const { databasePath, root } = createRealRunStorage();
    root.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const columns = database.prepare('PRAGMA table_info(report_streams)')
      .all()
      .map((row) => row.name);
    const uniqueIndexes = database.prepare('PRAGMA index_list(report_streams)')
      .all()
      .filter((row) => row.unique === 1)
      .map((row) => database.prepare(`PRAGMA index_info(${String(row.name)})`)
        .all()
        .map((column) => column.name));

    expect(columns).toEqual(expect.arrayContaining([
      'portable_identity',
    ]));
    expect(uniqueIndexes).toContainEqual([
      'run_id',
      'owner_scope_id',
      'portable_identity',
    ]);
    database.close();
  });

  it('rejects a gap in the append-only step iteration sequence', () => {
    const { databasePath, root } = createRealRunStorage();
    root.close();
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    const authority = database.prepare(`
      SELECT run_id AS runId, scope_id AS scopeId
      FROM scopes
      WHERE parent_scope_id IS NULL
    `).get() as { readonly runId: string; readonly scopeId: string };
    database.prepare(`
      UPDATE scope_runtime
      SET
        status = 'running',
        current_step_id = 'review',
        revision = 1,
        updated_at = 1000
      WHERE run_id = ? AND scope_id = ?
    `).run(authority.runId, authority.scopeId);

    expect(() => database.prepare(`
      INSERT INTO step_executions (
        run_id, scope_id, execution_id, step_id,
        iteration, status, started_at
      ) VALUES (
        ?, ?, 'forged-gap', 'review',
        2, 'running', 1000
      )
    `).run(authority.runId, authority.scopeId))
      .toThrow(/step iteration sequence/i);
    database.close();
  });

  it('terminalizes run, root scope, and lease together without resurrection', () => {
    const { root, clock } = createRealRunStorage();
    const owner = root.claimLease({
      ownerKey: 'owner',
      leaseDurationMs: 9_000,
    });
    clock.set(2_000);
    root.terminalizeRun(owner, 'failed');
    const snapshot = root.readResumeSnapshot();

    expect(snapshot.run).toMatchObject({ status: 'failed', terminalAt: 2_000 });
    expect(snapshot.scopes[0]).toMatchObject({
      terminalAt: 2_000,
      runtime: { status: 'failed', updatedAt: 2_000 },
    });
    expect(snapshot.leases[0]).toMatchObject({
      terminal_status: 'failed',
      terminalized_at: 2_000,
    });
    expect(() => root.terminalizeRun(owner, 'completed')).toThrow(/stale|terminal/i);
  });

  it('takes bootstrap timestamps from the trusted clock', () => {
    const { root } = createRealRunStorage({ findingContractEnabled: true });
    const snapshot = root.readResumeSnapshot();

    expect(snapshot.run.createdAt).toBe(1_000);
    expect(snapshot.scopes[0]).toMatchObject({
      createdAt: 1_000,
      runtime: { updatedAt: 1_000 },
    });
    expect(snapshot.findingLedger?.updatedAt).toBe(1_000);
  });
});

describe('run execution authority', () => {
  function claim(root: ReturnType<typeof createRealRunStorage>['root']): LeaseHandle {
    return root.claimLease({
      ownerKey: 'owner-1',
      leaseDurationMs: 9_000,
    });
  }

  it('keeps root, workflow_call, and parallel scopes in one run database', () => {
    const { root } = createRealRunStorage();
    const owner = claim(root);
    const runtime = root.runtime({ lease: owner });

    runtime.scopes.createWorkflowCallChild({
      scopeKey: 'call-1',
      workflowDefinition: {
        name: 'child',
        codecName: 'json-v1',
        definition: '{"name":"child"}',
      },
    });
    runtime.scopes.createParallelChild({ scopeKey: 'parallel-1' });

    expect(root.readResumeSnapshot().scopes.map((scope) => scope.kind).sort())
      .toEqual(['parallel', 'root', 'workflow_call']);
  });

  it('advances independent event sequences for parallel child scopes', () => {
    const { root } = createRealRunStorage();
    const owner = claim(root);
    const parent = root.runtime({ lease: owner });
    const firstScope = parent.scopes.createParallelChild({ scopeKey: 'parallel-1' });
    const secondScope = parent.scopes.createParallelChild({ scopeKey: 'parallel-2' });
    const first = root.runtime({ lease: owner, scope: firstScope });
    const second = root.runtime({ lease: owner, scope: secondScope });

    expect(first.sequences.appendEvent({
      expectedSequence: 0,
      eventType: 'started',
    })).toBe(1);
    expect(second.sequences.appendEvent({
      expectedSequence: 0,
      eventType: 'started',
    })).toBe(1);
    expect(first.sequences.appendEvent({
      expectedSequence: 1,
      eventType: 'completed',
    })).toBe(2);

    expect(first.sequences.listEvents().map((event) => event.sequence)).toEqual([1, 2]);
    expect(second.sequences.listEvents().map((event) => event.sequence)).toEqual([1]);
  });

  it('persists complete resumable execution state with scoped CAS', () => {
    const { root, clock } = createRealRunStorage();
    const owner = claim(root);
    const runtime = root.runtime({ lease: owner });
    const step = runtime.execution.startStep({
      stepKey: 'implement',
      expectedScopeRevision: 0,
    });
    const phase = runtime.execution.startPhase({
      execution: step.handle,
      phase: 'agent',
      ordinal: 0,
    });
    runtime.execution.recordJudgeStage({
      phaseExecution: phase,
      stage: 'quality',
      codecName: 'json-v1',
      result: '{"ok":true}',
    });
    runtime.execution.recordStepOutput({
      execution: step.handle,
      outputName: 'answer',
      codecName: 'text-v1',
      content: 'done',
    });
    runtime.execution.recordStructuredOutput({
      execution: step.handle,
      codecName: 'json-v1',
      output: '{"status":"done"}',
    });
    runtime.runtimeValues.recordSystemContext({
      contextKey: 'initial',
      codecName: 'text-v1',
      content: 'system',
    });
    runtime.runtimeValues.recordEffectResult({
      effectKey: 'command-1',
      effectType: 'command',
      codecName: 'json-v1',
      result: '{"exit":0}',
    });
    runtime.runtimeValues.recordUserInput({
      inputKey: 'approval-1',
      codecName: 'text-v1',
      content: 'yes',
    });
    const persona = runtime.runtimeValues.startPersonaSession({
      sessionKey: 'coder',
      personaName: 'coder',
    });
    runtime.runtimeValues.appendPersonaSessionRevision({
      personaSession: persona,
      expectedRevision: 0,
      codecName: 'text-v1',
      content: 'state',
    });
    runtime.sequences.recordResponseSnapshot({
      expectedSequence: 0,
      codecName: 'text-v1',
      response: 'previous response',
    });
    const recovery = runtime.runtimeValues.createRecoveryItem({
      recoveryKey: 'recovery-1',
      itemType: 'provider',
      codecName: 'json-v1',
      content: '{}',
    });
    clock.set(2_000);
    runtime.runtimeValues.resolveRecoveryItem({
      recovery,
      status: 'applied',
    });
    runtime.execution.finishPhase({
      phaseExecution: phase,
      status: 'completed',
    });
    runtime.execution.finishStep({
      execution: step.handle,
      status: 'completed',
    });

    const scope = root.readResumeSnapshot().scopes[0];
    expect(scope?.stepExecutions).toHaveLength(1);
    expect(scope?.phaseExecutions).toHaveLength(1);
    expect(scope?.judgeStageResults).toHaveLength(1);
    expect(scope?.stepOutputs).toHaveLength(1);
    expect(scope?.structuredOutputs).toHaveLength(1);
    expect(scope?.systemContexts).toHaveLength(1);
    expect(scope?.effectResults).toHaveLength(1);
    expect(scope?.userInputs).toHaveLength(1);
    expect(scope?.personaSessions).toHaveLength(1);
    expect(scope?.responses).toHaveLength(1);
    expect(scope?.recoveryItems).toEqual([
      expect.objectContaining({ status: 'applied', terminalAt: 2_000 }),
    ]);
  });

  it('rejects stale leases, duplicate children, cross-scope writes, and resurrection', () => {
    const { root, clock } = createRealRunStorage();
    const firstOwner = claim(root);
    const rootRuntime = root.runtime({ lease: firstOwner });
    const childScope = rootRuntime.scopes.createParallelChild({ scopeKey: 'child' });
    const child = root.runtime({ lease: firstOwner, scope: childScope });
    const execution = child.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });

    expect(() => rootRuntime.scopes.createParallelChild({ scopeKey: 'child' }))
      .toThrow(/UNIQUE/);
    expect(() => rootRuntime.execution.finishStep({
      execution: execution.handle,
      status: 'completed',
    })).toThrow(/cross-scope/);

    child.execution.finishStep({
      execution: execution.handle,
      status: 'completed',
    });
    child.scopes.terminalize({
      expectedRevision: 1,
      expectedStatus: 'running',
      status: 'completed',
    });
    expect(() => Reflect.apply(child.scopes.transition, child.scopes, [{
      expectedRevision: 2,
      expectedStatus: 'completed',
      status: 'running',
      currentStepId: 'review',
    }])).toThrow(/Terminal scope/);

    root.releaseLease(firstOwner);
    clock.set(3_000);
    const secondOwner = root.claimLease({
      ownerKey: 'owner-2',
      leaseDurationMs: 9_000,
    });
    expect(() => rootRuntime.sequences.appendEvent({
      expectedSequence: 0,
      eventType: 'stale',
    })).toThrow(/stale/i);
    expect(root.runtime({ lease: secondOwner }).sequences.appendEvent({
      expectedSequence: 0,
      eventType: 'current',
    })).toBe(1);
  });
});

describe('run storage publication', () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  function databasePath(name = 'run.sqlite'): string {
    if (directory === undefined) {
      directory = mkdtempSync(join(tmpdir(), 'takt-run-storage-publication-'));
    }
    return join(directory, name);
  }

  function workflowDefinition() {
    return {
      name: 'publication',
      codecName: 'json-v1',
      definition: '{"name":"publication"}',
    } as const;
  }

  function createAt(path: string) {
    return createRunStorage({
      databasePath: path,
      run: {
        slug: 'publication-run',
        findingContractEnabled: false,
      },
      workflowDefinition: workflowDefinition(),
    });
  }

  it('creates a private database directly at the final path and rejects retry', () => {
    const path = databasePath();
    const root = createAt(path);

    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => createAt(path)).toThrow(/already exists/i);
    root.close();
  });

  it('creates a resumed database directly at the final path and reopens it', () => {
    const source = createAt(databasePath('source.sqlite'));
    const path = databasePath('resumed.sqlite');
    const resumed = resumeRunStorage({
      databasePath: path,
      source,
      run: {
        slug: 'resumed-run',
        findingContractEnabled: false,
      },
      workflowDefinition: workflowDefinition(),
    });
    const resumedRunId = resumed.readResumeSnapshot().run.runId;

    resumed.close();
    source.close();

    const reopened = openRunStorage({ databasePath: path });
    expect(reopened.readResumeSnapshot().run.runId).toBe(resumedRunId);
    reopened.close();
  });

  it('reopens committed data after normal close', () => {
    const path = databasePath();
    const root = createAt(path);
    const lease = root.claimLease({
      ownerKey: 'publication-owner',
      leaseDurationMs: 10_000,
    });
    root.runtime({ lease }).sequences.appendEvent({
      expectedSequence: 0,
      eventType: 'before-close',
    });

    root.close();

    expect(() => root.readResumeSnapshot()).toThrow(/closed/i);
    const reopened = openRunStorage({ databasePath: path });
    expect(reopened.readResumeSnapshot().scopes[0]?.events).toEqual([
      expect.objectContaining({
        sequence: 1,
        eventType: 'before-close',
      }),
    ]);
    reopened.close();
  });

  it('does not create a missing database while opening', () => {
    const path = databasePath();

    expect(() => openRunStorage({ databasePath: path })).toThrow(/does not exist/i);
    expect(existsSync(path)).toBe(false);
  });

  it('closes a failed publication and leaves its destination as an orphan', () => {
    const path = databasePath();

    expect(() => createRunStorage({
      databasePath: path,
      run: {
        slug: 'invalid-publication',
        findingContractEnabled: false,
      },
      workflowDefinition: {
        name: 'invalid-publication',
        codecName: 'json-v1',
        definition: 'not-json',
      },
    })).toThrow(/left untouched as an orphan/i);

    expect(existsSync(path)).toBe(true);
    expect(() => createAt(path)).toThrow(/already exists/i);
    expect(() => openRunStorage({ databasePath: path })).toThrow();
  });
});
