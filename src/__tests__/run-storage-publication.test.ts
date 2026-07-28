import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRunStorage,
  openRunStorage,
  resumeRunStorage,
} from '../infra/run-storage/root.js';
import { createTestBootstrapSeed } from './helpers/run-storage.js';

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
    bootstrapSeed: createTestBootstrapSeed({
      workflowName: 'publication',
      sessionId: 'publication-session',
    }),
    run: {
      runId: 'publication-run',
      findingContractEnabled: false,
    },
    workflowDefinition: workflowDefinition(),
  });
}

describe('run storage publication', () => {
  it('atomically publishes a private database at the final path and rejects retry', () => {
    const path = databasePath();
    const root = createAt(path);

    expect(existsSync(path)).toBe(true);
    expect(root.readResumeSnapshot().run.runId).toBe('publication-run');
    expect(root.readBootstrapSeed()).toMatchObject({
      version: 1,
      workflowName: 'publication',
      backend: 'sqlite',
      sessionId: 'publication-session',
    });
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
      bootstrapSeed: createTestBootstrapSeed({
        workflowName: 'publication',
        sessionId: 'resumed-session',
      }),
      run: {
        runId: 'resumed-run',
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

  it('removes the private temporary database when initialization fails', () => {
    const path = databasePath();

    expect(() => createRunStorage({
      databasePath: path,
      bootstrapSeed: createTestBootstrapSeed({
        workflowName: 'invalid-publication',
        sessionId: 'invalid-publication-session',
      }),
      run: {
        runId: 'invalid-publication',
        findingContractEnabled: false,
      },
      workflowDefinition: {
        name: 'invalid-publication',
        codecName: 'json-v1',
        definition: 'not-json',
      },
    })).toThrow(/publication failed/i);

    expect(existsSync(path)).toBe(false);
    expect(readdirSync(directory!)).toEqual([]);
    const root = createAt(path);
    expect(root.readResumeSnapshot().run.runId).toBe('publication-run');
    root.close();
  });
});
