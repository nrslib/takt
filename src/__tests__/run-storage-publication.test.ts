import {
  existsSync,
  mkdtempSync,
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

describe('run storage publication', () => {
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
