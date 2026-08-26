import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { StatePaths } from '../../core/execution/locations.js';
import {
  readRunLogArtifacts,
  type RunLogArtifacts,
} from './run-log-cache.js';
import type { WorkflowResumePoint } from '../../core/models/index.js';
import { parseWorkflowResumePoint } from '../../core/workflow/resume-point-codec.js';
const NOFOLLOW = (constants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW;

const RUN_STATUSES = new Set(['running', 'completed', 'aborted', 'failed']);
const SESSION_LOG_SIDECAR_SUFFIXES = [
  '-prompts.jsonl',
  '-provider-events.jsonl',
  '-usage-events.jsonl',
  '-usage-events.phase.jsonl',
  '-otel-session-shadow.jsonl',
];
const MAX_RUNS = 50;
const MAX_REPORTS = 50;
const MAX_REPORT_BYTES = 256 * 1024;

interface RunMeta {
  readonly runSlug: string;
  readonly task: string;
  readonly workflow: string;
  readonly status: string;
  readonly startTime: string;
  readonly reportDirectory: string;
  readonly logsDirectory: string;
  readonly currentStep?: string;
  readonly currentIteration?: number;
  readonly iterations?: number;
  readonly phase?: number;
  readonly updatedAt?: string;
  readonly endTime?: string;
  readonly reason?: string;
  readonly resumePoint?: WorkflowResumePoint;
  readonly failure?: { readonly step: string; readonly error: string };
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function parseRunMeta(value: unknown, expectedSlug: string): RunMeta {
  const raw = requireRecord(value, 'Run metadata');
  const runSlug = requireString(raw.runSlug, 'runSlug');
  if (runSlug !== expectedSlug) {
    throw new Error(`runSlug does not match its directory: ${expectedSlug}`);
  }
  if (typeof raw.status !== 'string' || !RUN_STATUSES.has(raw.status)) {
    throw new Error('status is invalid');
  }

  const rawFailure = raw.failure;
  const failure = rawFailure !== null
    && typeof rawFailure === 'object'
    && !Array.isArray(rawFailure)
    && typeof (rawFailure as Readonly<Record<string, unknown>>).step === 'string'
    && typeof (rawFailure as Readonly<Record<string, unknown>>).error === 'string'
    ? {
        step: (rawFailure as Readonly<Record<string, unknown>>).step as string,
        error: (rawFailure as Readonly<Record<string, unknown>>).error as string,
      }
    : undefined;
  const resumePoint = raw.resumePoint === undefined
    ? undefined
    : parseWorkflowResumePoint(raw.resumePoint);
  return {
    runSlug,
    task: requireString(raw.task, 'task'),
    workflow: requireString(raw.workflow, 'workflow'),
    status: raw.status,
    startTime: requireString(raw.startTime, 'startTime'),
    reportDirectory: requireString(raw.reportDirectory, 'reportDirectory'),
    logsDirectory: requireString(raw.logsDirectory, 'logsDirectory'),
    currentStep: optionalString(raw.currentStep, 'currentStep'),
    currentIteration: optionalInteger(raw.currentIteration, 'currentIteration'),
    iterations: optionalInteger(raw.iterations, 'iterations'),
    phase: optionalInteger(raw.phase, 'phase'),
    updatedAt: optionalString(raw.updatedAt, 'updatedAt'),
    endTime: optionalString(raw.endTime, 'endTime'),
    reason: optionalString(raw.reason, 'reason'),
    ...(resumePoint === undefined ? {} : { resumePoint }),
    ...(failure === undefined ? {} : { failure }),
  };
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

async function readDirectory(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function resolveRegularPath(path: string, label: string): Promise<string> {
  const expected = resolve(path);
  const stats = await lstat(expected);
  if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  const actual = await realpath(expected);
  if (actual !== expected) throw new Error(`${label} contains a symbolic link`);
  return actual;
}

async function resolveContainedDirectory(
  root: string,
  candidate: string,
  label: string,
): Promise<string> {
  const resolvedRoot = await resolveRegularPath(root, 'Run root');
  const resolvedCandidate = resolve(candidate);
  const fromRoot = relative(resolvedRoot, resolvedCandidate);
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`${label} is outside the run directory`);
  }
  const actualCandidate = await resolveRegularPath(resolvedCandidate, label);
  const actualFromRoot = relative(resolvedRoot, actualCandidate);
  if (actualFromRoot === '' || actualFromRoot.startsWith('..') || isAbsolute(actualFromRoot)) {
    throw new Error(`${label} is outside the run directory`);
  }
  return actualCandidate;
}

interface RunsRootSnapshot {
  readonly directory: string;
  readonly fingerprint: { readonly dev: number; readonly ino: number };
}

async function captureRunsRoot(location: RunStoreLocation): Promise<RunsRootSnapshot> {
  const { stateDirectory, runsDirectory } = resolveRunStoreLocation(location);
  const directory = await resolveContainedDirectory(stateDirectory, runsDirectory, 'Runs directory');
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Runs directory must be a regular directory');
  }
  const fingerprint = { dev: stats.dev, ino: stats.ino };
  const expected = location.runsRootFingerprint;
  if (expected !== undefined && (expected.dev !== fingerprint.dev || expected.ino !== fingerprint.ino)) {
    throw new Error('Runs directory fingerprint changed');
  }
  return { directory, fingerprint };
}

async function verifyRunsRootSnapshot(
  location: RunStoreLocation,
  snapshot: RunsRootSnapshot,
): Promise<void> {
  const current = await captureRunsRoot(location);
  if (
    current.directory !== snapshot.directory
    || current.fingerprint.dev !== snapshot.fingerprint.dev
    || current.fingerprint.ino !== snapshot.fingerprint.ino
  ) {
    throw new Error('Runs directory identity changed during read');
  }
}

async function readRegularFile(path: string, label: string): Promise<string> {
  if (NOFOLLOW === undefined) throw new Error(`${label} cannot be opened safely on this platform`);
  const expected = resolve(path);
  if (await realpath(expected) !== expected) throw new Error(`${label} contains a symbolic link`);
  const handle = await open(expected, constants.O_RDONLY | NOFOLLOW);
  try {
    if (await realpath(expected) !== expected) throw new Error(`${label} contains a symbolic link`);
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`${label} must be a regular file`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function loadRunMeta(
  location: RunStoreLocation,
  snapshot: RunsRootSnapshot,
  slug: string,
): Promise<RunMeta> {
  await verifyRunsRootSnapshot(location, snapshot);
  const runRoot = await resolveRegularPath(resolve(snapshot.directory, slug), 'Run root');
  const path = resolve(runRoot, 'meta.json');
  const raw = JSON.parse(await readRegularFile(path, 'Run metadata')) as unknown;
  await verifyRunsRootSnapshot(location, snapshot);
  return parseRunMeta(raw, slug);
}

type RunStoreLocation = StatePaths;

function resolveRunStoreLocation(input: RunStoreLocation): {
  readonly stateDirectory: string;
  readonly runsDirectory: string;
} {
  return { stateDirectory: input.stateDirectory, runsDirectory: input.runsDirectory };
}

function summarize(meta: RunMeta) {
  return {
    slug: meta.runSlug,
    task: meta.task.length > 180 ? `${meta.task.slice(0, 179)}…` : meta.task,
    workflow: meta.workflow,
    status: meta.status,
    startTime: meta.startTime,
    currentStep: meta.currentStep,
    currentIteration: meta.currentIteration,
    updatedAt: meta.updatedAt,
  };
}

export async function readRunCollection(location: RunStoreLocation) {
  let root: RunsRootSnapshot;
  try {
    root = await captureRunsRoot(location);
  } catch (error) {
    if (isMissing(error) && location.runsRootFingerprint === undefined) return { runs: [], warnings: [] };
    throw error;
  }
  const entries = await readDirectory(root.directory);
  await verifyRunsRootSnapshot(location, root);
  const warningsFromEntries = entries
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => `${entry.name}: run root must not be a symbolic link`);
  const results = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      try {
        return { run: summarize(await loadRunMeta(location, root, entry.name)) };
      } catch (error) {
        if (isMissing(error)) return {};
        return {
          warning: `${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }));

  const runs = results
    .flatMap((result) => result.run === undefined ? [] : [result.run])
    .sort((left, right) => right.startTime.localeCompare(left.startTime))
    .slice(0, MAX_RUNS);
  const warnings = results.flatMap(
    (result) => result.warning === undefined ? [] : [result.warning],
  );
  await verifyRunsRootSnapshot(location, root);
  return { runs, warnings: [...warningsFromEntries, ...warnings] };
}

function assertRunSlug(slug: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
    throw new Error('Run slug is invalid');
  }
}

async function resolveRunChildDirectory(
  stateDirectory: string,
  runsDirectory: string,
  slug: string,
  childDirectory: string,
  label: string,
): Promise<string> {
  if (isAbsolute(childDirectory)) {
    throw new Error(`${label} must be relative to the project`);
  }
  const runRoot = resolve(runsDirectory, slug);
  const resolvedChild = resolve(stateDirectory, childDirectory);
  const fromRun = relative(runRoot, resolvedChild);
  if (fromRun === '' || fromRun.startsWith('..') || isAbsolute(fromRun)) {
    throw new Error(`${label} is outside the run directory`);
  }
  try {
    return await resolveContainedDirectory(runRoot, resolvedChild, label);
  } catch (error) {
    // A completed run may legitimately have no reports/logs directory yet;
    // callers handle that as an empty artifact set. Existing paths are still
    // resolved and validated above.
    if (isMissing(error)) return resolvedChild;
    throw error;
  }
}

async function collectReportPaths(root: string, directory = root): Promise<string[]> {
  if (directory === root) await resolveRegularPath(directory, 'Report directory');
  else await resolveContainedDirectory(root, directory, 'Report directory');
  const entries = await readDirectory(directory);
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) {
      await resolveContainedDirectory(root, path, 'Report directory');
      return collectReportPaths(root, path);
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) return [];
    return [path];
  }));
  return nested.flat().slice(0, MAX_REPORTS);
}

async function readReport(
  location: RunStoreLocation,
  snapshot: RunsRootSnapshot,
  root: string,
  path: string,
) {
  await verifyRunsRootSnapshot(location, snapshot);
  const safePath = await resolveContainedDirectory(root, path, 'Report file');
  const stats = await lstat(safePath);
  const filename = relative(root, path);
  if (stats.size > MAX_REPORT_BYTES) {
    await verifyRunsRootSnapshot(location, snapshot);
    return { filename, content: '', omitted: true };
  }
  const content = await readRegularFile(safePath, 'Report file');
  await verifyRunsRootSnapshot(location, snapshot);
  return { filename, content, omitted: false };
}

async function loadReports(
  location: RunStoreLocation,
  snapshot: RunsRootSnapshot,
  meta: RunMeta,
) {
  const { stateDirectory, runsDirectory } = resolveRunStoreLocation(location);
  await verifyRunsRootSnapshot(location, snapshot);
  const root = await resolveRunChildDirectory(
    stateDirectory,
    runsDirectory,
    meta.runSlug,
    meta.reportDirectory,
    'Report directory',
  );
  const rootStats = await lstat(root).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (rootStats === null) return [];
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Report directory must be a regular directory');
  }
  const paths = await collectReportPaths(root);
  await verifyRunsRootSnapshot(location, snapshot);
  const reports = await Promise.all(paths.sort().map((path) => readReport(location, snapshot, root, path)));
  await verifyRunsRootSnapshot(location, snapshot);
  return reports;
}

function isSessionLog(filename: string): boolean {
  return filename.endsWith('.jsonl')
    && !SESSION_LOG_SIDECAR_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

async function resolveSessionLogPaths(
  location: RunStoreLocation,
  snapshot: RunsRootSnapshot,
  meta: RunMeta,
): Promise<string[]> {
  const { stateDirectory, runsDirectory } = resolveRunStoreLocation(location);
  await verifyRunsRootSnapshot(location, snapshot);
  const logsRoot = await resolveRunChildDirectory(
    stateDirectory,
    runsDirectory,
    meta.runSlug,
    meta.logsDirectory,
    'Logs directory',
  );
  const logsStats = await lstat(logsRoot).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (logsStats === null) return [];
  await resolveContainedDirectory(resolve(runsDirectory, meta.runSlug), logsRoot, 'Logs directory');
  const entries = await readDirectory(logsRoot);
  await verifyRunsRootSnapshot(location, snapshot);
  const paths = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && isSessionLog(entry.name))
    .map((entry) => resolve(logsRoot, entry.name))
    .sort();
  for (const path of paths) {
    await resolveContainedDirectory(resolve(runsDirectory, meta.runSlug), path, 'Session log');
  }
  return paths;
}

async function loadLogArtifacts(
  location: RunStoreLocation,
  snapshot: RunsRootSnapshot,
  meta: RunMeta,
): Promise<RunLogArtifacts> {
  const paths = await resolveSessionLogPaths(location, snapshot, meta);
  return readRunLogArtifacts(
    resolve(snapshot.directory, meta.runSlug),
    paths,
    () => verifyRunsRootSnapshot(location, snapshot),
  );
}

export async function readRunDetail(location: RunStoreLocation, slug: string) {
  assertRunSlug(slug);
  const snapshot = await captureRunsRoot(location);
  const meta = await loadRunMeta(location, snapshot, slug);
  const [reports, logArtifacts] = await Promise.all([
    loadReports(location, snapshot, meta),
    loadLogArtifacts(location, snapshot, meta),
  ]);
  await verifyRunsRootSnapshot(location, snapshot);
  return { meta, reports, ...logArtifacts };
}

export async function resolveRunWatchDirectories(
  location: RunStoreLocation,
  slug: string,
): Promise<readonly string[]> {
  assertRunSlug(slug);
  const snapshot = await captureRunsRoot(location);
  const meta = await loadRunMeta(location, snapshot, slug);
  const { stateDirectory, runsDirectory } = resolveRunStoreLocation(location);
  const runRoot = await resolveRegularPath(resolve(snapshot.directory, slug), 'Run root');
  const candidates = await Promise.all([
    resolveRunChildDirectory(
      stateDirectory,
      runsDirectory,
      slug,
      meta.logsDirectory,
      'Logs directory',
    ),
    resolveRunChildDirectory(
      stateDirectory,
      runsDirectory,
      slug,
      meta.reportDirectory,
      'Report directory',
    ),
  ]);
  const existingDirectories: string[] = [];
  for (const candidate of candidates) {
    const stats = await lstat(candidate).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (stats !== null && stats.isDirectory() && !stats.isSymbolicLink()) {
      existingDirectories.push(candidate);
    }
  }
  await verifyRunsRootSnapshot(location, snapshot);
  return [runRoot, ...existingDirectories];
}
