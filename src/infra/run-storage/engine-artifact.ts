import {
  lstatSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import {
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from './canonical-json.js';
import {
  assertFileSnapshot,
  captureArtifactTree,
  readStableRegularFile,
  verifyArtifactTree,
  type ArtifactFileSnapshot,
} from './artifact-tree.js';

export interface EngineArtifactIdentity {
  readonly buildId: string;
  readonly version: string;
  readonly digest: string;
}

interface PackageManifest {
  readonly name: 'takt';
  readonly version: string;
}

interface LocatedManifest {
  readonly packageRoot: string;
  readonly bytes: Buffer;
  readonly snapshot: ArtifactFileSnapshot;
  readonly manifest: PackageManifest;
}

function errorCode(error: unknown): unknown {
  return error instanceof Error ? Reflect.get(error, 'code') : undefined;
}

function parseManifest(path: string, bytes: Buffer): PackageManifest {
  let parsed: { readonly name?: unknown; readonly version?: unknown };
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as {
      readonly name?: unknown;
      readonly version?: unknown;
    };
  } catch (error) {
    throw new Error(`TAKT engine artifact manifest parse failed: ${path}`, {
      cause: error,
    });
  }
  if (parsed.name !== 'takt' || typeof parsed.version !== 'string') {
    throw new Error(`TAKT engine artifact manifest identity is invalid: ${path}`);
  }
  return { name: parsed.name, version: parsed.version };
}

function locatePackageManifest(start: string): LocatedManifest {
  let directory = start;
  const filesystemRoot = parse(directory).root;
  while (true) {
    const candidate = join(directory, 'package.json');
    let metadata: BigIntStats;
    try {
      metadata = lstatSync(candidate, { bigint: true });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw error;
      }
      if (directory === filesystemRoot) {
        throw new Error('TAKT engine artifact manifest could not be located');
      }
      directory = dirname(directory);
      continue;
    }
    const read = readStableRegularFile(candidate, metadata);
    return {
      packageRoot: directory,
      bytes: read.bytes,
      snapshot: read.snapshot,
      manifest: parseManifest(candidate, read.bytes),
    };
  }
}

function canonicalRelativePath(packageRoot: string, path: string): string {
  return relative(packageRoot, path).split(sep).join('/');
}

function runtimeDirectoryName(
  packageRoot: string,
  modulePath: string,
): 'src' | 'dist' {
  const moduleRelativePath = canonicalRelativePath(packageRoot, modulePath);
  if (moduleRelativePath.startsWith('src/')) {
    return 'src';
  }
  if (moduleRelativePath.startsWith('dist/')) {
    return 'dist';
  }
  throw new Error('TAKT engine artifact module is outside src and dist');
}

function assertCanonicalModulePath(absoluteModulePath: string): string {
  const canonicalModulePath = realpathSync.native(absoluteModulePath);
  if (canonicalModulePath !== absoluteModulePath) {
    throw new Error(
      'TAKT engine artifact module path must not traverse symbolic links',
    );
  }
  return canonicalModulePath;
}

export function deriveEngineArtifactIdentity(
  modulePath: string,
): EngineArtifactIdentity {
  const absoluteModulePath = resolve(modulePath);
  const canonicalModulePath = assertCanonicalModulePath(absoluteModulePath);
  const located = locatePackageManifest(dirname(canonicalModulePath));
  const runtimeName = runtimeDirectoryName(
    located.packageRoot,
    canonicalModulePath,
  );
  const artifactDirectories = [
    join(located.packageRoot, runtimeName),
    join(located.packageRoot, 'builtins'),
    join(located.packageRoot, 'bin'),
  ];
  const artifact = captureArtifactTree(
    artifactDirectories,
    (path) => canonicalRelativePath(located.packageRoot, path),
    runtimeName,
  );
  if (artifact.digests.length === 0) {
    throw new Error('TAKT engine artifact file set is invalid');
  }
  verifyArtifactTree(artifact);
  assertFileSnapshot(located.snapshot);
  const digest = sha256(canonicalJson({
    manifestDigest: sha256(located.bytes),
    files: artifact.digests,
  }));
  assertCanonicalModulePath(absoluteModulePath);
  return Object.freeze({
    buildId: `${located.manifest.name}@${located.manifest.version}+${digest.slice(0, 16)}`,
    version: located.manifest.version,
    digest,
  });
}

export function currentEngineArtifactIdentity(): EngineArtifactIdentity {
  return deriveEngineArtifactIdentity(fileURLToPath(import.meta.url));
}
