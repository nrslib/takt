import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { deriveEngineArtifactIdentity } from '../infra/run-storage/engine-artifact.js';
import {
  captureArtifactTree,
  verifyArtifactTree,
} from '../infra/run-storage/artifact-tree.js';

const fixtures: string[] = [];

function createArtifactFixture(): {
  readonly root: string;
  readonly modulePath: string;
  readonly artifactFile: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'takt-engine-artifact-'));
  fixtures.push(root);
  const moduleDirectory = join(root, 'src', 'infra', 'run-storage');
  mkdirSync(moduleDirectory, { recursive: true });
  const modulePath = join(moduleDirectory, 'engine-artifact.js');
  const artifactFile = join(root, 'src', 'engine.js');
  writeFileSync(modulePath, 'export {};\n');
  writeFileSync(artifactFile, 'export const value = 1;\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'takt',
    version: '1.2.3',
  }));
  mkdirSync(join(root, 'builtins'), { recursive: true });
  writeFileSync(join(root, 'builtins', 'workflow.yaml'), 'name: fixture\n');
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'takt'), '#!/usr/bin/env node\n');
  return { root, modulePath, artifactFile };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

describe('run storage engine artifact identity', () => {
  it('recomputes the artifact digest after an artifact file changes', () => {
    const fixture = createArtifactFixture();
    const first = deriveEngineArtifactIdentity(fixture.modulePath);
    writeFileSync(fixture.artifactFile, 'export const value = 2;\n');

    expect(deriveEngineArtifactIdentity(fixture.modulePath).digest).not.toBe(first.digest);
  });

  it('includes builtins in the engine artifact digest', () => {
    const fixture = createArtifactFixture();
    const first = deriveEngineArtifactIdentity(fixture.modulePath);
    writeFileSync(
      join(fixture.root, 'builtins', 'workflow.yaml'),
      'name: fixture-changed\n',
    );

    expect(deriveEngineArtifactIdentity(fixture.modulePath).digest).not.toBe(first.digest);
  });

  it('fails fast for a malformed existing manifest instead of using a parent', () => {
    const fixture = createArtifactFixture();
    writeFileSync(join(fixture.root, 'src', 'package.json'), '{invalid-json');

    expect(() => deriveEngineArtifactIdentity(fixture.modulePath)).toThrow(
      /manifest.*parse|invalid.*manifest/i,
    );
  });

  it('rejects symlinks in the claimed TAKT artifact file set', () => {
    const fixture = createArtifactFixture();
    symlinkSync(fixture.artifactFile, join(fixture.root, 'src', 'linked-engine.js'));

    expect(() => deriveEngineArtifactIdentity(fixture.modulePath)).toThrow(/symbolic link/i);
  });

  it('rejects a symlink package manifest', () => {
    const fixture = createArtifactFixture();
    const manifestPath = join(fixture.root, 'package.json');
    const targetPath = join(fixture.root, 'real-package.json');
    writeFileSync(targetPath, JSON.stringify({ name: 'takt', version: '1.2.3' }));
    rmSync(manifestPath);
    symlinkSync(targetPath, manifestPath);

    expect(() => deriveEngineArtifactIdentity(fixture.modulePath)).toThrow(/symbolic link/i);
  });

  it('rejects a special package manifest', () => {
    const fixture = createArtifactFixture();
    const manifestPath = join(fixture.root, 'package.json');
    rmSync(manifestPath);
    mkdirSync(manifestPath);

    expect(() => deriveEngineArtifactIdentity(fixture.modulePath)).toThrow(/regular file/i);
  });

  it('rejects special files in the claimed TAKT artifact file set', () => {
    const fixture = createArtifactFixture();
    const fifoPath = join(fixture.root, 'src', 'artifact.fifo');
    const created = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);

    expect(() => deriveEngineArtifactIdentity(fixture.modulePath)).toThrow(/special file/i);
  });

  it('rejects an ordinary artifact change between capture and verification', () => {
    const fixture = createArtifactFixture();
    const snapshot = captureArtifactTree(
      [
        join(fixture.root, 'src'),
        join(fixture.root, 'builtins'),
        join(fixture.root, 'bin'),
      ],
      (path) => relative(fixture.root, path).split(sep).join('/'),
      'src',
    );
    writeFileSync(fixture.artifactFile, 'export const value = 2;\n');

    expect(() => verifyArtifactTree(snapshot)).toThrow(
      /artifact.*changed|directory.*changed/i,
    );
  });

  it('rejects a module path reached through a parent directory symlink', () => {
    const fixture = createArtifactFixture();
    const aliasRoot = mkdtempSync(join(tmpdir(), 'takt-engine-artifact-alias-'));
    fixtures.push(aliasRoot);
    const aliasPath = join(aliasRoot, 'package-link');
    symlinkSync(fixture.root, aliasPath, 'dir');
    const linkedModulePath = join(
      aliasPath,
      'src',
      'infra',
      'run-storage',
      'engine-artifact.js',
    );
    expect(realpathSync.native(linkedModulePath)).toBe(fixture.modulePath);

    expect(() => deriveEngineArtifactIdentity(linkedModulePath)).toThrow(
      /canonical|symbolic link/i,
    );
  });
});
