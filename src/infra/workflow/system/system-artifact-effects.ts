import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { WorkflowEffect } from '../../../core/models/types.js';
import type { SystemStepServicesOptions } from '../../../core/workflow/system/system-step-services.js';
import { commitExactPaths } from '../../task/git.js';

interface GitStatusEntry {
  readonly status: string;
  readonly path: string;
  readonly sourcePath?: string;
}

interface ArtifactIdentity {
  readonly path: string;
  readonly sha256: string;
}

interface ArtifactManifest {
  readonly schema_version: 1;
  readonly task_hash: string;
  readonly artifacts: readonly ArtifactIdentity[];
}

type CaptureArtifactsEffect = Extract<WorkflowEffect, { type: 'capture_artifacts' }>;

function parseGitStatus(output: string): readonly GitStatusEntry[] {
  const records = output.split('\0');
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error(`Invalid git status record: ${JSON.stringify(record)}`);
    }
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (status.includes('R') || status.includes('C')) {
      const sourcePath = records[index + 1];
      if (!sourcePath) {
        throw new Error(`Git status rename/copy is missing its source path: ${path}`);
      }
      index += 1;
      entries.push({ status, path, sourcePath });
      continue;
    }
    entries.push({ status, path });
  }
  return entries;
}

function readGitStatus(cwd: string): readonly GitStatusEntry[] {
  const output = execFileSync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd, encoding: 'utf8', stdio: 'pipe' },
  );
  return parseGitStatus(output);
}

function globPatternToRegExp(pattern: string): RegExp {
  if (isAbsolute(pattern) || pattern.includes('\\') || pattern.split('/').includes('..')) {
    throw new Error(`Artifact allow pattern must be a safe repository-relative path: ${pattern}`);
  }
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${escaped}$`);
}

function assertSafeRegularFile(cwd: string, repositoryPath: string): string {
  if (
    repositoryPath.length === 0
    || isAbsolute(repositoryPath)
    || repositoryPath.includes('\\')
    || repositoryPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    || repositoryPath === '.git'
    || repositoryPath.startsWith('.git/')
    || repositoryPath === '.takt'
    || repositoryPath.startsWith('.takt/')
  ) {
    throw new Error(`Unsafe artifact path: ${repositoryPath}`);
  }

  let current = cwd;
  for (const segment of repositoryPath.split('/')) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Artifact path must not contain symlinks: ${repositoryPath}`);
    }
  }
  if (!lstatSync(current).isFile()) {
    throw new Error(`Artifact path must be a regular file: ${repositoryPath}`);
  }
  const canonicalRoot = realpathSync(cwd);
  const canonicalPath = realpathSync(current);
  const fromRoot = relative(canonicalRoot, canonicalPath);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Artifact path escapes repository: ${repositoryPath}`);
  }
  return canonicalPath;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function resolveManifestPath(cwd: string, repositoryPath: string): string {
  if (
    !repositoryPath.startsWith('.takt/state/')
    || isAbsolute(repositoryPath)
    || repositoryPath.includes('\\')
    || repositoryPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Artifact manifest path must be under .takt/state/: ${repositoryPath}`);
  }
  let current = cwd;
  const segments = repositoryPath.split('/');
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Artifact manifest path must not contain symlinks: ${repositoryPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      mkdirSync(current, { mode: 0o700 });
    }
  }
  return join(cwd, repositoryPath);
}

function persistManifest(cwd: string, repositoryPath: string, manifest: ArtifactManifest): void {
  const path = resolveManifestPath(cwd, repositoryPath);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

function readPersistedManifest(cwd: string, repositoryPath: string): unknown {
  const path = resolveManifestPath(cwd, repositoryPath);
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`Artifact manifest must not be a symlink: ${repositoryPath}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function readPersistedManifestIfPresent(cwd: string, repositoryPath: string): ArtifactManifest | undefined {
  try {
    return mapArtifactManifest(readPersistedManifest(cwd, repositoryPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function createArtifactIdentity(cwd: string, repositoryPath: string): ArtifactIdentity {
  const canonicalPath = assertSafeRegularFile(cwd, repositoryPath);
  return { path: repositoryPath, sha256: sha256(canonicalPath) };
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`Artifact manifest requires non-empty string array field "${field}"`);
  }
  return value;
}

function mapArtifactManifest(value: unknown): ArtifactManifest {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('commit_artifacts requires object field "manifest"');
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.schema_version !== 1
    || typeof raw.task_hash !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.task_hash)
    || !Array.isArray(raw.artifacts)
    || raw.artifacts.length === 0
  ) {
    throw new Error('Invalid artifact manifest schema');
  }
  const artifacts = raw.artifacts.map((item, index): ArtifactIdentity => {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid artifact manifest item at index ${index}`);
    }
    const rawItem = item as Record<string, unknown>;
    if (typeof rawItem.path !== 'string' || typeof rawItem.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(rawItem.sha256)) {
      throw new Error(`Invalid artifact identity at index ${index}`);
    }
    return { path: rawItem.path, sha256: rawItem.sha256 };
  });
  return { schema_version: 1, task_hash: raw.task_hash, artifacts };
}

export function captureArtifactsEffect(
  options: SystemStepServicesOptions,
  effect: CaptureArtifactsEffect,
): Record<string, unknown> {
  const allowedPatterns = effect.allowedPatterns.map(globPatternToRegExp);
  const requiredBasenames = requireStringArray(effect.requiredBasenames, 'required_basenames');
  if (new Set(requiredBasenames).size !== requiredBasenames.length) {
    throw new Error('capture_artifacts required_basenames must be unique');
  }

  const candidates = readGitStatus(options.cwd)
    .filter((entry) => allowedPatterns.some((pattern) => pattern.test(entry.path)));
  const renamedCandidate = candidates.find((entry) => entry.status.includes('R') || entry.status.includes('C'));
  if (renamedCandidate) {
    throw new Error(`Artifact capture does not allow renamed or copied artifact paths: ${renamedCandidate.path}`);
  }
  if (candidates.length === 0) {
    throw new Error('capture_artifacts found no dirty allowed artifact paths');
  }
  const candidatePaths = candidates.map((entry) => entry.path);
  const parents = new Set(candidatePaths.map((path) => dirname(path)));
  const previousManifest = effect.manifestPath !== undefined
    ? readPersistedManifestIfPresent(options.cwd, effect.manifestPath)
    : undefined;
  if (previousManifest !== undefined && previousManifest.task_hash !== hashText(options.task)) {
    throw new Error('Persisted artifact manifest belongs to a different task');
  }
  const previousParents = new Set(previousManifest?.artifacts.map((artifact) => dirname(artifact.path)) ?? []);
  const previousParent = previousParents.size === 1 ? [...previousParents][0] : undefined;
  const completeParents = [...parents].filter((parent) => {
    const names = new Set(
      candidatePaths.filter((path) => dirname(path) === parent).map((path) => basename(path)),
    );
    return requiredBasenames.every((name) => names.has(name));
  });
  const eligibleParents = previousParent !== undefined && parents.has(previousParent)
    ? [previousParent]
    : completeParents.length > 0 ? completeParents : [...parents];
  if (effect.sameParent && eligibleParents.length !== 1) {
    throw new Error(
      `capture_artifacts could not identify one current artifact parent: `
      + `${parents.size} dirty parent(s), ${completeParents.length} complete parent(s)`,
    );
  }
  const parent = eligibleParents[0]!;
  const candidateBasenames = new Set(
    candidatePaths.filter((path) => dirname(path) === parent).map((path) => basename(path)),
  );
  for (const candidate of candidateBasenames) {
    if (!requiredBasenames.includes(candidate)) {
      throw new Error(`capture_artifacts found unexpected artifact basename: ${candidate}`);
    }
  }

  const artifacts = requiredBasenames.map((name) => {
    const path = `${parent}/${name}`;
    if (!allowedPatterns.some((pattern) => pattern.test(path))) {
      throw new Error(`Required artifact is outside the allow patterns: ${path}`);
    }
    return createArtifactIdentity(options.cwd, path);
  });
  const manifest: ArtifactManifest = {
    schema_version: 1,
    task_hash: hashText(options.task),
    artifacts,
  };
  if (effect.manifestPath !== undefined) {
    persistManifest(options.cwd, effect.manifestPath, manifest);
  }
  return { manifest };
}

export function commitArtifactsEffect(
  options: SystemStepServicesOptions,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const manifest = mapArtifactManifest(
    payload.manifestPath !== undefined
      ? readPersistedManifest(options.cwd, String(payload.manifestPath))
      : payload.manifest,
  );
  if (manifest.task_hash !== hashText(options.task)) {
    throw new Error('Artifact manifest belongs to a different task');
  }
  if (typeof payload.message !== 'string' || payload.message.trim().length === 0) {
    throw new Error('commit_artifacts requires non-empty string field "message"');
  }
  const paths = manifest.artifacts.map((artifact) => {
    const identity = createArtifactIdentity(options.cwd, artifact.path);
    if (identity.sha256 !== artifact.sha256) {
      throw new Error(`Artifact changed after capture: ${artifact.path}`);
    }
    return artifact.path;
  });
  if (new Set(paths).size !== paths.length) {
    throw new Error('Artifact manifest contains duplicate paths');
  }

  const commit = commitExactPaths(options.cwd, payload.message, paths, {
    allowGitHooks: false,
    allowGitFilters: false,
  });
  return commit === undefined
    ? { status: 'already_committed', paths }
    : { status: 'committed', commit, paths };
}
