import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const artifactIdentity = vi.hoisted(() => ({
  current: undefined as
    | { readonly buildId: string; readonly version: string; readonly digest: string }
    | undefined,
}));

vi.mock('../infra/run-storage/engine-artifact.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../infra/run-storage/engine-artifact.js')
  >();
  return {
    ...actual,
    currentEngineArtifactIdentity() {
      if (artifactIdentity.current === undefined) {
        throw new Error('Test artifact identity is not initialized');
      }
      return artifactIdentity.current;
    },
  };
});

import { deriveEngineArtifactIdentity } from '../infra/run-storage/engine-artifact.js';
import {
  createRunStorage,
  openRunStorage,
  openRunStorageResumeSource,
  openRunStorageTerminalRecovery,
  resumeRunStorage,
} from '../infra/run-storage/root.js';
import {
  validateRecordedEngineProvenance,
} from '../infra/run-storage/schema-contract.js';
import { createTestBootstrapSeed } from './helpers/run-storage.js';

let directory: string | undefined;

afterEach(() => {
  artifactIdentity.current = undefined;
  if (directory !== undefined) {
    rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe('run storage artifact provenance', () => {
  it('rejects an existing database after one builtin artifact byte changes', () => {
    directory = mkdtempSync(join(tmpdir(), 'takt-artifact-provenance-'));
    const moduleDirectory = join(directory, 'src', 'infra', 'run-storage');
    mkdirSync(moduleDirectory, { recursive: true });
    const modulePath = join(moduleDirectory, 'engine-artifact.js');
    writeFileSync(modulePath, 'export {};\n');
    mkdirSync(join(directory, 'builtins'), { recursive: true });
    const builtinPath = join(directory, 'builtins', 'workflow.yaml');
    writeFileSync(builtinPath, 'name: original\n');
    mkdirSync(join(directory, 'bin'), { recursive: true });
    writeFileSync(join(directory, 'bin', 'takt'), '#!/usr/bin/env node\n');
    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      name: 'takt',
      version: '1.2.3',
    }));

    artifactIdentity.current = deriveEngineArtifactIdentity(modulePath);
    const databasePath = join(directory, 'run.sqlite');
    const definition = '{"name":"artifact-provenance"}';
    createRunStorage({
      databasePath,
      bootstrapSeed: createTestBootstrapSeed({
        workflowName: 'artifact-provenance',
        sessionId: 'artifact-provenance-session',
      }),
      run: {
        runId: 'run-artifact-provenance',
        findingContractEnabled: false,
      },
      workflowDefinition: {
        name: 'artifact-provenance',
        codecName: 'json-v1',
        definition,
      },
    }).close();

    writeFileSync(builtinPath, 'name: changed\n');
    artifactIdentity.current = deriveEngineArtifactIdentity(modulePath);

    expect(() => openRunStorage({ databasePath })).toThrow(/provenance/i);
  });

  it('resumes a compatible source created by another engine build', () => {
    directory = mkdtempSync(join(tmpdir(), 'takt-artifact-resume-'));
    const sourcePath = join(directory, 'source.sqlite');
    const targetPath = join(directory, 'target.sqlite');
    const sourceDigest = 'a'.repeat(64);
    artifactIdentity.current = {
      buildId: `takt@1.2.3+${sourceDigest.slice(0, 16)}`,
      version: '1.2.3',
      digest: sourceDigest,
    };
    createRunStorage({
      databasePath: sourcePath,
      bootstrapSeed: createTestBootstrapSeed({
        workflowName: 'artifact-resume',
        sessionId: 'artifact-resume-source',
      }),
      run: {
        runId: 'artifact-resume-source',
        findingContractEnabled: false,
      },
      workflowDefinition: {
        name: 'artifact-resume',
        codecName: 'json-v1',
        definition: '{"name":"artifact-resume"}',
      },
    }).close();

    const targetDigest = 'b'.repeat(64);
    artifactIdentity.current = {
      buildId: `takt@1.2.3+${targetDigest.slice(0, 16)}`,
      version: '1.2.3',
      digest: targetDigest,
    };

    expect(() => openRunStorage({ databasePath: sourcePath }))
      .toThrow(/provenance/i);
    const recovery = openRunStorageTerminalRecovery({
      databasePath: sourcePath,
    });
    expect(Object.keys(recovery).sort()).toEqual([
      'acknowledgeTerminalPublicationStage',
      'claimTerminalPublicationStage',
      'close',
      'expireTerminalPublicationStageClaim',
      'forceFailRun',
      'readBootstrapSeed',
      'readResumeSnapshot',
      'readTerminalPublication',
    ]);
    expect(recovery).not.toHaveProperty('claimLease');
    expect(recovery).not.toHaveProperty('runtime');
    recovery.close();

    const source = openRunStorageResumeSource({ databasePath: sourcePath });
    expect(Object.keys(source).sort()).toEqual([
      'close',
      'readResumeSnapshot',
    ]);
    expect(source).not.toHaveProperty('forceFailRun');
    expect(source).not.toHaveProperty('runtime');
    const target = resumeRunStorage({
      databasePath: targetPath,
      bootstrapSeed: createTestBootstrapSeed({
        workflowName: 'artifact-resume',
        sessionId: 'artifact-resume-target',
      }),
      run: {
        runId: 'artifact-resume-target',
        findingContractEnabled: false,
      },
      workflowDefinition: {
        name: 'artifact-resume',
        codecName: 'json-v1',
        definition: '{"name":"artifact-resume"}',
      },
      source,
    });
    target.close();
    source.close();

    const reopened = openRunStorage({ databasePath: targetPath });
    expect(reopened.readResumeSnapshot().run.runId)
      .toBe('artifact-resume-target');
    reopened.close();
  });

  it('rejects malformed recorded engine provenance with FK-consistent rows', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE engine_builds (
        build_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        digest TEXT NOT NULL
      ) STRICT;
      CREATE TABLE runs (
        engine_build_id TEXT NOT NULL REFERENCES engine_builds(build_id)
      ) STRICT;
      INSERT INTO engine_builds (build_id, version, digest)
      VALUES ('malformed-build-id', '1.2.3', '${'c'.repeat(64)}');
      INSERT INTO runs (engine_build_id) VALUES ('malformed-build-id');
    `);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => validateRecordedEngineProvenance(database))
      .toThrow(/recorded engine build provenance/i);
    database.close();
  });
});
