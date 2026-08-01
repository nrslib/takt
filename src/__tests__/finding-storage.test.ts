import { DatabaseSync } from 'node:sqlite';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  FindingLedger,
  FindingManagerValidationReport,
} from '../core/workflow/findings/types.js';
import {
  FINDING_STORAGE_TABLES,
  FindingStorageResolver,
  ROOT_FINDING_AUTHORITY_KEY,
} from '../infra/finding-storage/index.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-finding-storage-'));
  roots.push(root);
  return root;
}

function createResolver(input: {
  root: string;
  runId?: string;
  source?: { databasePath: string; runId: string };
  warnings?: string[];
  timeoutMs?: number;
}): FindingStorageResolver {
  return new FindingStorageResolver({
    databasePath: join(input.root, 'finding-contract.sqlite'),
    runId: input.runId ?? 'target-run',
    ...(input.source === undefined ? {} : { source: input.source }),
    now: () => '2026-08-01T00:00:00.000Z',
    onWarning: (warning) => input.warnings?.push(warning.message),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
}

function databaseFileSnapshot(databasePath: string): Record<string, string | null> {
  return Object.fromEntries(['', '-journal', '-wal', '-shm'].map((suffix) => {
    const path = `${databasePath}${suffix}`;
    return [suffix, existsSync(path) ? readFileSync(path).toString('base64') : null];
  }));
}

interface ConcurrentOpener {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly completed: Promise<string>;
}

function launchConcurrentOpener(databasePath: string, reportDir: string): ConcurrentOpener {
  const viteNode = join(process.cwd(), 'node_modules/vite-node/vite-node.mjs');
  const fixture = join(
    process.cwd(),
    'src/__tests__/fixtures/finding-storage-open-process.ts',
  );
  const child = spawn(process.execPath, [viteNode, fixture, databasePath, reportDir]);
  let output = '';
  let errorOutput = '';
  const timeout = setTimeout(() => {
    errorOutput = 'Finding storage opener timed out after 5000ms';
    child.kill();
  }, 5_000);
  let markReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolveReady, rejectBeforeReady) => {
    markReady = resolveReady;
    rejectReady = rejectBeforeReady;
  });
  const completed = new Promise<string>((resolveCompleted, rejectCompleted) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf-8');
      if (output.includes('ready\n')) {
        markReady?.();
        markReady = undefined;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString('utf-8');
    });
    child.once('error', rejectCompleted);
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const error = new Error(errorOutput || `Finding storage opener exited ${code}`);
        rejectReady?.(error);
        rejectCompleted(error);
        return;
      }
      resolveCompleted(output);
    });
  });
  return { child, ready, completed };
}

function resolveRoot(
  resolver: FindingStorageResolver,
  root: string,
  workflowName = 'root-workflow',
) {
  return resolver.resolveAuthority({
    authorityKey: ROOT_FINDING_AUTHORITY_KEY,
    workflowName,
    reportDir: join(root, 'reports'),
  });
}

function updateTimestamp(ledger: FindingLedger, updatedAt: string): FindingLedger {
  return { ...ledger, updatedAt };
}

function report(runId: string): FindingManagerValidationReport {
  return {
    version: 1,
    runId,
    stepName: 'findings-manager',
    retryCount: 0,
    ledgerUpdated: false,
    finalErrors: [],
    attempts: [],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Finding Contract SQLite storage', () => {
  it('does not create the database until an authority is resolved', () => {
    const root = tempRoot();
    const resolver = createResolver({ root });

    expect(existsSync(resolver.databasePath)).toBe(false);
    const store = resolveRoot(resolver, root);

    expect(existsSync(resolver.databasePath)).toBe(true);
    expect(store.loadLedger()).toMatchObject({
      workflowName: 'root-workflow',
      nextId: 1,
      findings: [],
    });
    resolver.close();
  });

  it('initializes one missing target safely from two concurrent processes', async () => {
    const root = tempRoot();
    const databasePath = join(root, 'finding-contract.sqlite');
    const first = launchConcurrentOpener(databasePath, join(root, 'reports-1'));
    const second = launchConcurrentOpener(databasePath, join(root, 'reports-2'));
    await Promise.all([first.ready, second.ready]);

    first.child.stdin.end('go\n');
    second.child.stdin.end('go\n');
    const outputs = await Promise.all([first.completed, second.completed]);
    const results = outputs.map((output) => JSON.parse(
      output.split('\n').find((line) => line.startsWith('{'))!,
    ) as {
      ledgerIdentity: string;
      ledger: FindingLedger;
    });

    expect(results.map((result) => result.ledger.workflowName)).toEqual([
      'concurrent-workflow',
      'concurrent-workflow',
    ]);
    expect(results[0]?.ledgerIdentity).toBe(results[1]?.ledgerIdentity);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all()).toEqual([...FINDING_STORAGE_TABLES]
      .sort()
      .map((name) => ({ name })));
    expect(database.prepare('SELECT count(*) AS count FROM database_identity').get())
      .toEqual({ count: 1 });
    const identity = database.prepare(`
      SELECT database_instance_id AS databaseInstanceId FROM database_identity
    `).get() as { databaseInstanceId: string };
    expect(results[0]?.ledgerIdentity).toBe(
      `finding-storage:${identity.databaseInstanceId}:root`,
    );
    expect(database.prepare('SELECT count(*) AS count FROM finding_authorities').get())
      .toEqual({ count: 1 });
    database.close();
  });

  it('creates exactly the identity and current-authority business tables', () => {
    const root = tempRoot();
    const resolver = createResolver({ root });
    resolveRoot(resolver, root);
    resolver.resolveAuthority({
      authorityKey: 'root/steps/review#1',
      workflowName: 'child-workflow',
      reportDir: join(root, 'child-reports'),
    });
    resolver.close();

    const database = new DatabaseSync(resolver.databasePath, { readOnly: true });
    expect(database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all()).toEqual([
      { name: 'database_identity' },
      { name: 'finding_authorities' },
    ]);
    expect(database.prepare(`
      SELECT authority_key AS authorityKey, workflow_name AS workflowName, revision
      FROM finding_authorities ORDER BY authority_key
    `).all()).toEqual([
      {
        authorityKey: 'root',
        workflowName: 'root-workflow',
        revision: 1,
      },
      {
        authorityKey: 'root/steps/review#1',
        workflowName: 'child-workflow',
        revision: 1,
      },
    ]);
    database.close();
  });

  it('serializes updates from separate connections without losing either update', async () => {
    const root = tempRoot();
    const firstResolver = createResolver({ root });
    const secondResolver = createResolver({ root });
    const first = resolveRoot(firstResolver, root);
    const second = resolveRoot(secondResolver, root);

    await first.updateLedger((current) => ({
      ledger: updateTimestamp(current, '2026-08-01T00:00:01.000Z'),
      result: 'first',
    }));
    await second.updateLedger((current) => ({
      ledger: updateTimestamp(current, '2026-08-01T00:00:02.000Z'),
      result: 'second',
    }));

    expect(first.loadLedger().updatedAt).toBe('2026-08-01T00:00:02.000Z');
    const database = new DatabaseSync(firstResolver.databasePath, { readOnly: true });
    expect(database.prepare(`
      SELECT revision FROM finding_authorities WHERE authority_key = 'root'
    `).get()).toEqual({ revision: 3 });
    database.close();
    firstResolver.close();
    secondResolver.close();
  });

  it('runs revalidation inside the transaction and persists its selected mutation', async () => {
    const root = tempRoot();
    const resolver = createResolver({ root });
    const store = resolveRoot(resolver, root);
    const seen: string[] = [];

    const mutation = await store.updateLedger((current) => ({
      ledger: updateTimestamp(current, '2026-08-01T00:00:01.000Z'),
      result: 'initial',
    }), (current, candidate) => {
      seen.push(current.updatedAt, candidate.ledger.updatedAt);
      return {
        publish: false,
        mutation: {
          ledger: updateTimestamp(candidate.ledger, '2026-08-01T00:00:02.000Z'),
          result: 'revalidated',
        },
      };
    });

    expect(seen).toEqual([
      '2026-08-01T00:00:00.000Z',
      '2026-08-01T00:00:01.000Z',
    ]);
    expect(mutation.result).toBe('revalidated');
    expect(store.loadLedger().updatedAt).toBe('2026-08-01T00:00:02.000Z');
    resolver.close();
  });

  it('rolls back mutator and revalidator failures without advancing revision', async () => {
    const root = tempRoot();
    const resolver = createResolver({ root });
    const store = resolveRoot(resolver, root);

    await expect(store.updateLedger(() => {
      throw new Error('mutator failed');
    })).rejects.toThrow('mutator failed');
    await expect(store.updateLedger((current) => ({
      ledger: updateTimestamp(current, '2026-08-01T00:00:01.000Z'),
      result: undefined,
    }), () => {
      throw new Error('revalidator failed');
    })).rejects.toThrow('revalidator failed');

    const database = new DatabaseSync(resolver.databasePath, { readOnly: true });
    expect(database.prepare(`
      SELECT revision, ledger_json AS ledgerJson
      FROM finding_authorities WHERE authority_key = 'root'
    `).get()).toMatchObject({
      revision: 1,
      ledgerJson: expect.stringContaining('2026-08-01T00:00:00.000Z'),
    });
    database.close();
    expect(store.loadLedger().updatedAt).toBe('2026-08-01T00:00:00.000Z');
    resolver.close();
  });

  it('rolls back on real SQLite lock contention and recovers after the lock is released', async () => {
    const root = tempRoot();
    const firstResolver = createResolver({ root });
    const secondResolver = createResolver({ root, timeoutMs: 20 });
    resolveRoot(firstResolver, root);
    const second = resolveRoot(secondResolver, root);
    const blocker = new DatabaseSync(firstResolver.databasePath);
    blocker.exec('BEGIN IMMEDIATE');

    await expect(second.updateLedger((current) => ({
      ledger: updateTimestamp(current, '2026-08-01T00:00:01.000Z'),
      result: undefined,
    }))).rejects.toThrow(/locked/i);
    blocker.exec('ROLLBACK');

    expect(second.loadLedger().updatedAt).toBe('2026-08-01T00:00:00.000Z');
    await second.updateLedger((current) => ({
      ledger: updateTimestamp(current, '2026-08-01T00:00:02.000Z'),
      result: undefined,
    }));
    const database = new DatabaseSync(firstResolver.databasePath, { readOnly: true });
    expect(database.prepare(`
      SELECT revision FROM finding_authorities WHERE authority_key = 'root'
    `).get()).toEqual({ revision: 2 });
    database.close();
    blocker.close();
    firstResolver.close();
    secondResolver.close();
  });

  it('seeds only the matching authority and rewrites only resume-bound identity fields', async () => {
    const sourceRoot = tempRoot();
    const sourceResolver = createResolver({ root: sourceRoot, runId: 'source-run' });
    const source = resolveRoot(sourceResolver, sourceRoot, 'source-workflow');
    const managerReport = report('source-run');
    await source.commitManagerLedger((current) => ({
      ledger: {
        ...current,
        updatedAt: '2026-08-01T00:00:01.000Z',
        stopBudget: {
          roundMarkers: ['round-1'],
          firstRoundAt: '2026-08-01T00:00:01.000Z',
          exhausted: false,
        },
      },
      result: undefined,
      publication: { roundMarker: 'round-1', report: managerReport },
    }));
    const sourcePending = source.loadLedger().pendingManagerCommit;
    sourceResolver.close();

    const targetRoot = tempRoot();
    const warnings: string[] = [];
    const targetResolver = createResolver({
      root: targetRoot,
      runId: 'target-run',
      source: {
        databasePath: join(sourceRoot, 'finding-contract.sqlite'),
        runId: 'source-run',
      },
      warnings,
    });
    const target = resolveRoot(targetResolver, targetRoot, 'target-workflow');
    const imported = target.loadLedger();

    expect(imported.workflowName).toBe('target-workflow');
    expect(imported.pendingManagerCommit?.publication).toEqual({
      ...sourcePending?.publication,
      destinationRunId: 'target-run',
    });
    const missing = targetResolver.resolveAuthority({
      authorityKey: 'child-call-site',
      workflowName: 'child-workflow',
      reportDir: join(targetRoot, 'child-reports'),
    });
    expect(missing.loadLedger()).toMatchObject({
      workflowName: 'child-workflow',
      findings: [],
      nextId: 1,
    });
    expect(warnings).toEqual([
      'Finding authority "child-call-site" could not be seeded; starting empty',
    ]);

    const targetDatabase = new DatabaseSync(targetResolver.databasePath, { readOnly: true });
    expect(targetDatabase.prepare(`
      SELECT revision FROM finding_authorities WHERE authority_key = 'root'
    `).get()).toEqual({ revision: 1 });
    targetDatabase.close();
    const importedPublication = imported.pendingManagerCommit?.publication;
    expect(importedPublication).toBeDefined();
    const receipt = target.publishManagerValidationPublication(importedPublication!);
    const finalized = await target.finalizeManagerValidationPublication(
      importedPublication!,
      receipt,
    );
    expect(finalized).toMatchObject({
      completedRoundMarker: 'round-1',
      ledger: {
        workflowName: 'target-workflow',
        stopBudget: { roundMarkers: ['round-1'] },
      },
    });
    expect(finalized.ledger.pendingManagerCommit).toBeUndefined();
    expect(existsSync(join(
      targetRoot,
      'reports',
      importedPublication!.fileName,
    ))).toBe(true);
    const sourceDatabase = new DatabaseSync(
      join(sourceRoot, 'finding-contract.sqlite'),
      { readOnly: true },
    );
    const sourceLedgerRow = sourceDatabase.prepare(`
      SELECT ledger_json AS ledgerJson FROM finding_authorities WHERE authority_key = 'root'
    `).get() as { ledgerJson: string };
    expect(JSON.parse(sourceLedgerRow.ledgerJson)).toMatchObject({
      workflowName: 'source-workflow',
      pendingManagerCommit: {
        publication: { destinationRunId: 'source-run' },
      },
    });
    sourceDatabase.close();
    targetResolver.close();
  });

  it.each([
    'missing source',
    'corrupt source',
    'old source schema',
    'source run mismatch',
  ])('warns and starts at Finding 0 for %s', (kind) => {
    const sourceRoot = tempRoot();
    const sourcePath = join(sourceRoot, 'finding-contract.sqlite');
    if (kind === 'corrupt source') {
      writeFileSync(sourcePath, 'not sqlite');
    } else if (kind === 'old source schema') {
      const database = new DatabaseSync(sourcePath);
      database.exec('CREATE TABLE legacy_run_storage (id TEXT PRIMARY KEY) STRICT');
      database.close();
    } else if (kind === 'source run mismatch') {
      const sourceResolver = createResolver({ root: sourceRoot, runId: 'another-run' });
      resolveRoot(sourceResolver, sourceRoot);
      sourceResolver.close();
    }

    const targetRoot = tempRoot();
    const warnings: string[] = [];
    const resolver = createResolver({
      root: targetRoot,
      source: { databasePath: sourcePath, runId: 'source-run' },
      warnings,
    });
    const store = resolveRoot(resolver, targetRoot);

    expect(store.loadLedger()).toMatchObject({ nextId: 1, findings: [] });
    expect(warnings).toHaveLength(1);
    const database = new DatabaseSync(resolver.databasePath, { readOnly: true });
    expect(database.prepare(`
      SELECT revision FROM finding_authorities WHERE authority_key = 'root'
    `).get()).toEqual({ revision: 1 });
    database.close();
    resolver.close();
  });

  it.each<{
    name: string;
    corrupt: (database: DatabaseSync) => void;
  }>([
    {
      name: 'malformed JSON',
      corrupt: (database) => {
        database.exec('PRAGMA ignore_check_constraints = ON');
        database.prepare(`
          UPDATE finding_authorities SET ledger_json = 'not-json'
          WHERE authority_key = 'root'
        `).run();
      },
    },
    {
      name: 'invalid ledger shape',
      corrupt: (database) => database.prepare(`
        UPDATE finding_authorities SET ledger_json = '{}'
        WHERE authority_key = 'root'
      `).run(),
    },
    {
      name: 'workflow mismatch',
      corrupt: (database) => database.prepare(`
        UPDATE finding_authorities SET workflow_name = 'wrong-workflow'
        WHERE authority_key = 'root'
      `).run(),
    },
    {
      name: 'invalid revision',
      corrupt: (database) => {
        database.exec('PRAGMA ignore_check_constraints = ON');
        database.prepare(`
          UPDATE finding_authorities SET revision = 0
          WHERE authority_key = 'root'
        `).run();
      },
    },
  ])('resets only an accessed authority with $name corruption', ({ corrupt }) => {
    const root = tempRoot();
    const setupResolver = createResolver({ root });
    resolveRoot(setupResolver, root);
    setupResolver.resolveAuthority({
      authorityKey: 'unaccessed-child',
      workflowName: 'child-workflow',
      reportDir: join(root, 'child-reports'),
    });
    setupResolver.close();
    const databasePath = join(root, 'finding-contract.sqlite');
    const injector = new DatabaseSync(databasePath);
    injector.prepare(`
      UPDATE finding_authorities SET ledger_json = '{}'
      WHERE authority_key = 'unaccessed-child'
    `).run();
    corrupt(injector);
    injector.close();

    const warnings: string[] = [];
    const recoveryResolver = createResolver({ root, warnings });
    const recovered = resolveRoot(recoveryResolver, root);

    expect(recovered.loadLedger()).toMatchObject({
      workflowName: 'root-workflow',
      nextId: 1,
      findings: [],
    });
    expect(warnings).toEqual([
      'Finding authority "root" was invalid and has been reset',
    ]);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(`
      SELECT revision, ledger_json AS ledgerJson
      FROM finding_authorities WHERE authority_key = 'root'
    `).get()).toMatchObject({
      revision: 1,
      ledgerJson: expect.stringContaining('"workflowName":"root-workflow"'),
    });
    expect(database.prepare(`
      SELECT ledger_json AS ledgerJson
      FROM finding_authorities WHERE authority_key = 'unaccessed-child'
    `).get()).toEqual({ ledgerJson: '{}' });
    database.close();
    recoveryResolver.close();
  });

  it('enforces non-empty authority metadata and valid ledger JSON in SQLite', () => {
    const root = tempRoot();
    const resolver = createResolver({ root });
    resolveRoot(resolver, root);
    const database = new DatabaseSync(resolver.databasePath);

    expect(() => database.prepare(`
      INSERT INTO finding_authorities (
        authority_key, workflow_name, revision, ledger_json, updated_at
      ) VALUES ('', 'workflow', 1, '{}', 'now')
    `).run()).toThrow();
    expect(() => database.prepare(`
      INSERT INTO finding_authorities (
        authority_key, workflow_name, revision, ledger_json, updated_at
      ) VALUES ('key', '', 1, '{}', 'now')
    `).run()).toThrow();
    expect(() => database.prepare(`
      INSERT INTO finding_authorities (
        authority_key, workflow_name, revision, ledger_json, updated_at
      ) VALUES ('key', 'workflow', 1, 'not-json', 'now')
    `).run()).toThrow();
    database.close();
    resolver.close();
  });

  it('leaves an unusable target untouched and falls back to isolated memory', () => {
    const root = tempRoot();
    const databasePath = join(root, 'finding-contract.sqlite');
    const legacy = new DatabaseSync(databasePath);
    legacy.exec('CREATE TABLE runs (run_id TEXT PRIMARY KEY) STRICT');
    legacy.close();
    const before = databaseFileSnapshot(databasePath);
    const warnings: string[] = [];
    const resolver = createResolver({ root, warnings });

    const store = resolveRoot(resolver, root);

    expect(store.loadLedger().findings).toEqual([]);
    expect(warnings).toEqual([
      'Finding storage target is unusable; using an isolated in-memory database',
    ]);
    expect(databaseFileSnapshot(databasePath)).toEqual(before);
    const unchanged = new DatabaseSync(databasePath, { readOnly: true });
    expect(unchanged.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'table'
    `).all()).toEqual([{ name: 'runs' }]);
    unchanged.close();
    resolver.close();
  });

  it('leaves a corrupt target byte-for-byte untouched', () => {
    const root = tempRoot();
    const databasePath = join(root, 'finding-contract.sqlite');
    writeFileSync(databasePath, 'not-a-sqlite-database');
    const before = databaseFileSnapshot(databasePath);
    const warnings: string[] = [];
    const resolver = createResolver({ root, warnings });

    const store = resolveRoot(resolver, root);

    expect(store.loadLedger()).toMatchObject({ nextId: 1, findings: [] });
    expect(warnings).toEqual([
      'Finding storage target is unusable; using an isolated in-memory database',
    ]);
    expect(databaseFileSnapshot(databasePath)).toEqual(before);
    resolver.close();
  });

  it('leaves a different-run target and its sidecars untouched', async () => {
    const root = tempRoot();
    const originalResolver = createResolver({ root, runId: 'original-run' });
    const original = resolveRoot(originalResolver, root);
    await original.updateLedger((current) => ({
      ledger: updateTimestamp(current, '2026-08-01T00:00:09.000Z'),
      result: undefined,
    }));
    originalResolver.close();
    const databasePath = join(root, 'finding-contract.sqlite');
    const before = databaseFileSnapshot(databasePath);
    const warnings: string[] = [];
    const otherResolver = createResolver({ root, runId: 'other-run', warnings });

    const isolated = resolveRoot(otherResolver, root);
    await isolated.updateLedger((current) => ({
      ledger: updateTimestamp(current, '2026-08-01T00:00:10.000Z'),
      result: undefined,
    }));

    expect(warnings).toEqual([
      'Finding storage target is unusable; using an isolated in-memory database',
    ]);
    expect(databaseFileSnapshot(databasePath)).toEqual(before);
    const unchanged = new DatabaseSync(databasePath, { readOnly: true });
    const row = unchanged.prepare(`
      SELECT run_id AS runId FROM database_identity
    `).get();
    expect(row).toEqual({ runId: 'original-run' });
    const ledgerRow = unchanged.prepare(`
      SELECT ledger_json AS ledgerJson FROM finding_authorities
      WHERE authority_key = 'root'
    `).get() as { ledgerJson: string };
    expect(JSON.parse(ledgerRow.ledgerJson)).toMatchObject({
      updatedAt: '2026-08-01T00:00:09.000Z',
    });
    unchanged.close();
    otherResolver.close();
  });

  it('does not seed or modify a source when source and target paths are identical', async () => {
    const root = tempRoot();
    const sourceResolver = createResolver({ root, runId: 'source-run' });
    const source = resolveRoot(sourceResolver, root, 'source-workflow');
    await source.updateLedger((current) => ({
      ledger: updateTimestamp(current, '2026-08-01T00:00:09.000Z'),
      result: undefined,
    }));
    sourceResolver.close();
    const databasePath = join(root, 'finding-contract.sqlite');
    const before = databaseFileSnapshot(databasePath);
    const warnings: string[] = [];
    const targetResolver = createResolver({
      root,
      runId: 'target-run',
      source: { databasePath, runId: 'source-run' },
      warnings,
    });

    const target = resolveRoot(targetResolver, root, 'target-workflow');

    expect(target.loadLedger()).toMatchObject({
      workflowName: 'target-workflow',
      updatedAt: '2026-08-01T00:00:00.000Z',
      findings: [],
    });
    expect(warnings).toEqual([
      'Finding storage target is using an isolated in-memory database',
    ]);
    expect(databaseFileSnapshot(databasePath)).toEqual(before);
    targetResolver.close();
  });

  it('rejects forged bind data and stale finalization data before ledger CAS', async () => {
    const root = tempRoot();
    const resolver = createResolver({ root });
    const store = resolveRoot(resolver, root);
    const managerReport = report('target-run');
    const planned = store.planManagerValidationPublication('round-1', managerReport);

    expect(store.bindManagerValidationPublication('round-1', planned)).toEqual(planned);
    expect(() => store.bindManagerValidationPublication('round-1', {
      ...planned,
      domainId: 'forged-domain',
    })).toThrow(/not authorized/);
    await store.commitManagerLedger((current) => ({
      ledger: {
        ...current,
        stopBudget: {
          roundMarkers: ['round-1'],
          firstRoundAt: '2026-08-01T00:00:01.000Z',
          exhausted: false,
        },
      },
      result: undefined,
      publication: { roundMarker: 'round-1', report: managerReport },
    }));
    const publication = store.loadLedger().pendingManagerCommit!.publication;
    const receipt = store.publishManagerValidationPublication(publication);

    await expect(store.finalizeManagerValidationPublication(publication, {
      ...receipt,
      revision: 'stale-revision',
    })).rejects.toThrow(/receipt does not match/);
    await expect(store.finalizeManagerValidationPublication({
      ...publication,
      destinationRunId: 'forged-run',
    }, receipt)).rejects.toThrow(/not pending/);
    const beforeFinalization = new DatabaseSync(resolver.databasePath, { readOnly: true });
    expect(beforeFinalization.prepare(`
      SELECT revision FROM finding_authorities WHERE authority_key = 'root'
    `).get()).toEqual({ revision: 2 });
    beforeFinalization.close();

    await expect(store.finalizeManagerValidationPublication(publication, receipt))
      .resolves.toMatchObject({ completedRoundMarker: 'round-1' });
    resolver.close();
  });

  it('rejects resolver and store access after close', () => {
    const root = tempRoot();
    const resolver = createResolver({ root });
    const store = resolveRoot(resolver, root);

    resolver.close();
    resolver.close();

    expect(() => resolveRoot(resolver, root)).toThrow(/closed/);
    expect(() => store.loadLedger()).toThrow(/closed/);
  });

  it('keeps report bodies on the filesystem and never creates report tables', () => {
    const root = tempRoot();
    const resolver = createResolver({ root });
    const store = resolveRoot(resolver, root);

    store.saveLedgerSnapshot();
    store.saveRawFindings('target-run', 'review step', []);

    expect(existsSync(join(root, 'reports', 'findings-ledger.json'))).toBe(true);
    expect(existsSync(join(root, 'reports', 'raw-findings.review-step.json'))).toBe(true);
    const database = new DatabaseSync(resolver.databasePath, { readOnly: true });
    expect(database.prepare(`
      SELECT count(*) AS count FROM sqlite_schema
      WHERE type = 'table' AND name LIKE '%report%'
    `).get()).toEqual({ count: 0 });
    database.close();
    resolver.close();
  });
});
