import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';

const REGISTRY_VERSION = 2;
const LOCATION_ID_PATTERN = /^[a-f0-9]{64}$/u;
const STATE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface DirectoryFingerprint {
  readonly dev: number;
  readonly ino: number;
}

interface StoredProjectRegistration {
  readonly version: typeof REGISTRY_VERSION;
  readonly locationId: string;
  readonly stateId: string;
  readonly canonicalDirectory: string;
  readonly fingerprint: DirectoryFingerprint;
  readonly displayName: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly lastCommand: string;
}

/** Public Web UI view. `id` and `projectDirectory` are compatibility aliases. */
export interface RegisteredProject extends StoredProjectRegistration {
  readonly available: boolean;
  readonly id: string;
  readonly projectDirectory: string;
}

export interface ProjectRegistrySnapshot {
  readonly projects: readonly RegisteredProject[];
  readonly warnings: readonly string[];
}

function registryDirectory(globalConfigDirectory: string): string {
  return join(globalConfigDirectory, 'projects');
}

/** Lookup identity: only the canonical native path participates in the hash. */
export function projectIdForCanonicalDirectory(canonicalDirectory: string): string {
  return createHash('sha256').update(canonicalDirectory).digest('hex');
}

export const locationIdForCanonicalDirectory = projectIdForCanonicalDirectory;

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${label} is invalid`);
  return result;
}

function parseFingerprint(value: unknown): DirectoryFingerprint {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('fingerprint is invalid');
  }
  const raw = value as Readonly<Record<string, unknown>>;
  if (!Number.isSafeInteger(raw.dev) || !Number.isSafeInteger(raw.ino)) {
    throw new Error('fingerprint is invalid');
  }
  return { dev: raw.dev as number, ino: raw.ino as number };
}

function parseRegistration(value: unknown, expectedLocationId: string): StoredProjectRegistration {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('registration must be an object');
  }
  const raw = value as Readonly<Record<string, unknown>>;
  if (raw.version !== REGISTRY_VERSION) throw new Error('registration version is unsupported');
  const locationId = requireString(raw.locationId, 'locationId');
  const canonicalDirectory = requireString(raw.canonicalDirectory, 'canonicalDirectory');
  const stateId = requireString(raw.stateId, 'stateId');
  if (
    locationId !== expectedLocationId
    || !LOCATION_ID_PATTERN.test(locationId)
    || projectIdForCanonicalDirectory(canonicalDirectory) !== locationId
    || !STATE_ID_PATTERN.test(stateId)
  ) {
    throw new Error('registration identity does not match its path');
  }
  return {
    version: REGISTRY_VERSION,
    locationId,
    stateId,
    canonicalDirectory,
    fingerprint: parseFingerprint(raw.fingerprint),
    displayName: requireString(raw.displayName, 'displayName'),
    createdAt: requireTimestamp(raw.createdAt, 'createdAt'),
    lastSeenAt: requireTimestamp(raw.lastSeenAt, 'lastSeenAt'),
    lastCommand: requireString(raw.lastCommand, 'lastCommand'),
  };
}

/** All identity fields present in a legacy record must agree with its slot. */
function hasExpectedRegistrationIdentity(
  raw: Readonly<Record<string, unknown>>,
  expectedLocationId: string,
): boolean {
  for (const value of [raw.locationId, raw.id]) {
    if (value !== undefined && (typeof value !== 'string' || value !== expectedLocationId)) {
      return false;
    }
  }
  for (const value of [raw.canonicalDirectory, raw.projectDirectory]) {
    if (
      value !== undefined
      && (typeof value !== 'string' || projectIdForCanonicalDirectory(value) !== expectedLocationId)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Explicit registration repairs only unreadable JSON or an older schema whose
 * identity still matches this location. A current-schema record that fails
 * validation remains untouched so fingerprint and state protections cannot be
 * bypassed by re-registering the directory.
 */
function canReplaceInvalidRegistration(value: unknown, expectedLocationId: string): boolean {
  // JSON.parse failure is represented by undefined and is repairable because
  // the requested canonical path determines this location-keyed target.
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Readonly<Record<string, unknown>>;
  if (raw.version === REGISTRY_VERSION) return false;
  return hasExpectedRegistrationIdentity(raw, expectedLocationId);
}

function toPublicProject(stored: StoredProjectRegistration, available: boolean): RegisteredProject {
  return {
    ...stored,
    available,
    id: stored.locationId,
    projectDirectory: stored.canonicalDirectory,
  };
}

async function readDirectoryFingerprint(directory: string): Promise<DirectoryFingerprint> {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Project directory must be a regular directory');
  }
  return { dev: stats.dev, ino: stats.ino };
}

async function isAvailableDirectory(stored: StoredProjectRegistration): Promise<boolean> {
  try {
    const canonical = await realpath(stored.canonicalDirectory);
    if (canonical !== stored.canonicalDirectory) return false;
    await access(canonical, constants.R_OK | constants.X_OK);
    const fingerprint = await readDirectoryFingerprint(canonical);
    return fingerprint.dev === stored.fingerprint.dev && fingerprint.ino === stored.fingerprint.ino;
  } catch {
    return false;
  }
}

async function atomicWriteRegistration(path: string, value: StoredProjectRegistration): Promise<void> {
  const directory = join(path, '..');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({
      ...value,
      // Read-only compatibility aliases for older UI clients. The canonical
      // registry fields remain locationId/canonicalDirectory/stateId.
      id: value.locationId,
      projectDirectory: value.canonicalDirectory,
    }, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function registerProject(options: {
  readonly globalConfigDirectory: string;
  readonly projectDirectory: string;
  readonly command: string;
}): Promise<RegisteredProject> {
  const canonicalDirectory = await realpath(options.projectDirectory);
  const fingerprint = await readDirectoryFingerprint(canonicalDirectory);
  const locationId = projectIdForCanonicalDirectory(canonicalDirectory);
  const directory = registryDirectory(options.globalConfigDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${locationId}.json`);
  let existing: StoredProjectRegistration | undefined;
  try {
    const targetStats = await lstat(target);
    if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
      throw new Error('Project registration must be a regular file');
    }
    const serialized = await readFile(target, 'utf8');
    let raw: unknown;
    try {
      raw = JSON.parse(serialized) as unknown;
    } catch {
      // The explicit registration can repair a corrupt record. The target
      // filename is already derived from this request's canonical location.
      raw = undefined;
    }
    try {
      existing = parseRegistration(raw, locationId);
    } catch (error) {
      if (!canReplaceInvalidRegistration(raw, locationId)) throw error;
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (existing !== undefined && (
    existing.canonicalDirectory !== canonicalDirectory
    || existing.fingerprint.dev !== fingerprint.dev
    || existing.fingerprint.ino !== fingerprint.ino
  )) {
    // The path name is a lookup key, not permission to attach to a replacement
    // directory. Keep the old state for an explicit relink in a later release.
    throw new Error('Registered project fingerprint does not match; explicit relink is required');
  }
  const now = new Date().toISOString();
  const stored: StoredProjectRegistration = existing === undefined
    ? {
        version: REGISTRY_VERSION,
        locationId,
        stateId: randomUUID(),
        canonicalDirectory,
        fingerprint,
        displayName: basename(canonicalDirectory),
        createdAt: now,
        lastSeenAt: now,
        lastCommand: options.command,
      }
    : {
        ...existing,
        lastSeenAt: now,
        lastCommand: options.command,
      };
  await atomicWriteRegistration(target, stored);
  return toPublicProject(stored, true);
}

function isMissing(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ENOENT';
}

export async function readProjectRegistry(globalConfigDirectory: string): Promise<ProjectRegistrySnapshot> {
  const directory = registryDirectory(globalConfigDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { projects: [], warnings: [] };
    throw error;
  }

  const results = await Promise.all(entries
    .filter((entry) => entry.name.endsWith('.json'))
    .map(async (entry) => {
      const expectedLocationId = entry.name.slice(0, -'.json'.length);
      if (!entry.isFile() || entry.isSymbolicLink() || !LOCATION_ID_PATTERN.test(expectedLocationId)) {
        return { warning: `${entry.name}: invalid project registration filename` };
      }
      try {
        const stored = parseRegistration(
          JSON.parse(await readFile(join(directory, entry.name), 'utf8')) as unknown,
          expectedLocationId,
        );
        return { project: toPublicProject(stored, await isAvailableDirectory(stored)) };
      } catch (error) {
        return { warning: `${entry.name}: ${error instanceof Error ? error.message : String(error)}` };
      }
    }));

  return {
    projects: results
      .flatMap((result) => result.project === undefined ? [] : [result.project])
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt)),
    warnings: results.flatMap((result) => result.warning === undefined ? [] : [result.warning]),
  };
}

export async function resolveRegisteredProject(
  globalConfigDirectory: string,
  locationId: string,
): Promise<RegisteredProject> {
  if (!LOCATION_ID_PATTERN.test(locationId)) throw new Error('Project id is invalid');
  const snapshot = await readProjectRegistry(globalConfigDirectory);
  const project = snapshot.projects.find((candidate) => candidate.locationId === locationId);
  if (project === undefined) throw new Error('Project is not registered');
  if (!project.available) throw new Error('Project directory is unavailable or has changed identity');
  return project;
}
