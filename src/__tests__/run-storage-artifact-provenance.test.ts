import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { createRunStorage, openRunStorage } from '../infra/run-storage/root.js';

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
      run: {
        slug: 'run-artifact-provenance',
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
});
