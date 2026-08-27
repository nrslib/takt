import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { StatePaths } from '../../core/execution/locations.js';
import {
  readRunLogArtifacts,
  readRunOccurrencePrompts,
  getRunOccurrenceLifecycle,
  type RunLogArtifacts,
  type RunLogEvent,
  type RunPromptArtifact,
} from './run-log-cache.js';
import type { WorkflowResumePoint, WorkflowResumePointEntry } from '../../core/models/index.js';
import { parseWorkflowResumePoint } from '../../core/workflow/resume-point-codec.js';
import { parseWorkflowCallNamespaceSegment } from '../../core/workflow/workflow-call-namespace.js';
import { buildWorkflowCallInvocationIdentity } from '../../core/workflow/workflow-call-invocation-index.js';
import { buildWorkflowStepParticipationIdentity } from '../../core/workflow/workflow-step-participation-index.js';
import { buildWorkflowCallSiteRunPathSegment } from '../../core/workflow/workflow-call-site-identity.js';
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

export class RunOccurrenceNotFoundError extends Error {
  constructor() {
    super('Occurrence was not found in this run');
  }
}

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
  const hasCamelResumePoint = Object.prototype.hasOwnProperty.call(raw, 'resumePoint');
  const hasSnakeResumePoint = Object.prototype.hasOwnProperty.call(raw, 'resume_point');
  let resumePoint: WorkflowResumePoint | undefined;
  if (hasCamelResumePoint && hasSnakeResumePoint) {
    const camelResumePoint = parseWorkflowResumePoint(raw.resumePoint);
    const snakeResumePoint = parseWorkflowResumePoint(raw.resume_point);
    if (!isDeepStrictEqual(camelResumePoint, snakeResumePoint)) {
      throw new Error('resumePoint and resume_point must contain the same value');
    }
    resumePoint = camelResumePoint;
  } else if (hasCamelResumePoint) {
    resumePoint = parseWorkflowResumePoint(raw.resumePoint);
  } else if (hasSnakeResumePoint) {
    resumePoint = parseWorkflowResumePoint(raw.resume_point);
  }
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

async function collectReportPaths(
  root: string,
  directory = root,
  include: (path: string) => boolean = () => true,
  limit = MAX_REPORTS,
): Promise<string[]> {
  if (directory === root) await resolveRegularPath(directory, 'Report directory');
  else await resolveContainedDirectory(root, directory, 'Report directory');
  const entries = (await readDirectory(directory)).sort((left, right) => left.name.localeCompare(right.name));
  const paths: string[] = [];
  for (const entry of entries) {
    if (paths.length >= limit) break;
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await resolveContainedDirectory(root, path, 'Report directory');
      paths.push(...await collectReportPaths(root, path, include, limit - paths.length));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md') && include(path)) paths.push(path);
  }
  return paths;
}

type WorkflowStackFrame = NonNullable<RunLogEvent['stack']>[number];

function stackFramesMatch(
  left: readonly WorkflowStackFrame[],
  right: readonly WorkflowStackFrame[],
): boolean {
  return left.length <= right.length && left.every((frame, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && frame.workflow === candidate.workflow
      && frame.workflow_ref === candidate.workflow_ref
      && frame.step === candidate.step
      && frame.kind === candidate.kind
      && frame.occurrence === candidate.occurrence;
  });
}

function canonicalReportNamespaceSegments(
  stack: readonly WorkflowStackFrame[] | undefined,
  occurrences: readonly RunLogEvent[] = [],
  childWorkflow: string | undefined = undefined,
): readonly string[] | undefined {
  if (stack === undefined) return undefined;
  const segments: string[] = [];
  for (let index = 0; index < stack.length; index += 1) {
    const frame = stack[index]!;
    if (frame.kind !== 'workflow_call') continue;
    const directChild = stack[index + 1];
    const candidateChildren = directChild === undefined
      ? occurrences
        .map((occurrence) => {
          const candidateStack = occurrence.stack;
          return candidateStack !== undefined
            && stackFramesMatch(stack.slice(0, index + 1), candidateStack)
            ? candidateStack[index + 1]
            : undefined;
        })
        .filter((candidate): candidate is WorkflowStackFrame => candidate !== undefined)
        .filter((candidate) => childWorkflow === undefined
          || candidate.workflow === childWorkflow
          || candidate.workflow_ref === childWorkflow)
      : [directChild];
    const childIdentities = [...new Map(
      candidateChildren.map((candidate) => [
        JSON.stringify([candidate.workflow, candidate.workflow_ref]),
        candidate,
      ]),
    ).values()];
    const child = childIdentities.length === 1 ? childIdentities[0] : undefined;
    if (child === undefined || child.workflow.length === 0 || child.workflow_ref.length === 0) {
      return undefined;
    }
    segments.push(buildWorkflowCallSiteRunPathSegment({
      stack: stack.slice(0, index + 1),
      childWorkflowName: child.workflow,
      childWorkflowRef: child.workflow_ref,
    }));
  }
  return segments;
}

function portableRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function reportNamespaceSegments(filename: string): readonly string[] | undefined {
  const parts = filename.split('/');
  const segments: string[] = [];
  let index = 0;
  while (parts[index] === 'subworkflows') {
    const segment = parts[index + 1];
    if (segment === undefined || parseWorkflowCallNamespaceSegment(segment) === undefined) {
      return undefined;
    }
    segments.push(segment);
    index += 2;
  }
  if (segments.length === 0 || index >= parts.length || parts.slice(index).some((part) => part === '')) {
    return undefined;
  }
  return segments;
}

function namespaceSegmentsMatch(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const actualNamespace = parseWorkflowCallNamespaceSegment(actual);
  const expectedNamespace = parseWorkflowCallNamespaceSegment(expected);
  return actualNamespace !== undefined
    && expectedNamespace !== undefined
    && actualNamespace.siteDigest === undefined
    && expectedNamespace.siteDigest !== undefined
    && actualNamespace.iteration === expectedNamespace.iteration
    && actualNamespace.stepName === expectedNamespace.stepName
    && actualNamespace.workflowName === expectedNamespace.workflowName;
}

function namespacePathsMatch(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((segment, index) => namespaceSegmentsMatch(segment, expected[index]!));
}

function reportOwnerStack(
  occurrence: RunLogEvent,
): readonly WorkflowStackFrame[] | undefined {
  const stack = occurrence.stack;
  if (stack === undefined || stack.length === 0) return undefined;
  const current = stack.at(-1);
  return current?.kind === 'workflow_call' || current?.kind === 'parallel'
    ? stack.slice(0, -1)
    : stack;
}

function participationStack(
  stack: readonly WorkflowStackFrame[],
  resumePoint: WorkflowResumePoint | undefined,
): readonly WorkflowResumePointEntry[] {
  const enriched: WorkflowResumePointEntry[] = [];
  for (const frame of stack) {
    const invocationIdentity = frame.kind === 'workflow_call'
      ? (() => {
          try {
            return buildWorkflowCallInvocationIdentity(
              frame.workflow_ref,
              frame.step,
              enriched,
            );
          } catch {
            return undefined;
          }
        })()
      : undefined;
    const callInstance = frame.kind !== 'workflow_call'
      ? undefined
      : resumePoint?.workflow_call_invocations[invocationIdentity ?? '']?.call_instance;
    enriched.push({
      ...frame,
      ...(frame.kind === 'workflow_call'
        ? { call_instance: callInstance === frame.occurrence ? callInstance : frame.occurrence }
        : {}),
    });
  }
  return enriched;
}

function selectedParticipationReportPaths(
  meta: RunMeta,
  selectedOccurrence: RunLogEvent,
  occurrences: readonly RunLogEvent[],
): ReadonlySet<string> | undefined {
  const stack = selectedOccurrence.stack;
  const current = stack?.at(-1);
  const step = selectedOccurrence.step ?? current?.step;
  if (stack === undefined || current === undefined || step === undefined) return undefined;
  const enrichedStack = participationStack(stack, meta.resumePoint);
  const directParent = current.kind === 'parallel' ? undefined : stack.at(-2);
  const parallelParent = directParent?.kind === 'parallel'
    && directParent.workflow_ref === current.workflow_ref
    ? directParent
    : undefined;
  // Parallel child reports are indexed with the active workflow-call prefix
  // plus a separate parallel_parent field.  The parallel frame in a child
  // event stack is therefore excluded from calls when reconstructing that
  // producer identity.
  const workflowCallPath = parallelParent === undefined
    ? enrichedStack.slice(0, -1)
    : enrichedStack.slice(0, -2);
  const parallelParentStepName = parallelParent?.step;
  let identity: string;
  try {
    identity = buildWorkflowStepParticipationIdentity(
      current.workflow_ref,
      step,
      workflowCallPath,
      parallelParentStepName,
    );
  } catch {
    return undefined;
  }
  const record = meta.resumePoint?.workflow_step_participations[identity];
  if (record === undefined) return undefined;
  const ownerStack = reportOwnerStack(selectedOccurrence);
  if (ownerStack === undefined) return new Set();
  const namespace = canonicalReportNamespaceSegments(
    ownerStack,
    occurrences,
    selectedOccurrence.childWorkflow,
  );
  if (namespace === undefined) return new Set();
  const prefix = namespace.length === 0
    ? ''
    : `${namespace.map((segment) => `subworkflows/${segment}`).join('/')}/`;
  const paths = record.report_names.flatMap((reportName) => (
    reportName.length === 0 || reportName.includes('\\') || reportName.startsWith('/')
      ? []
      : [`${prefix}${reportName}`]
  ));
  return new Set(paths);
}

function reportBelongsToOccurrence(
  filename: string,
  meta: RunMeta,
  selectedOccurrence: RunLogEvent,
  occurrences: readonly RunLogEvent[],
  graphTruncated: boolean,
): boolean {
  const exactPaths = selectedParticipationReportPaths(meta, selectedOccurrence, occurrences);
  if (exactPaths !== undefined) return exactPaths.has(filename);
  if (meta.resumePoint !== undefined) return false;
  const actual = reportNamespaceSegments(filename);
  const selected = canonicalReportNamespaceSegments(
    reportOwnerStack(selectedOccurrence),
    occurrences,
    selectedOccurrence.childWorkflow,
  );
  if (actual === undefined || selected === undefined || selected.length === 0) return false;
  if (actual.length !== selected.length) return false;
  const candidatePaths = [...new Map(
    occurrences
      .map((occurrence) => canonicalReportNamespaceSegments(
        reportOwnerStack(occurrence),
        occurrences,
        occurrence.childWorkflow,
      ))
      .filter((candidate): candidate is readonly string[] => candidate !== undefined && candidate.length > 0)
      .map((candidate) => [JSON.stringify(candidate), candidate]),
  ).values()];
  const matchingPaths = candidatePaths.filter((candidate) => namespacePathsMatch(actual, candidate));
  if (!matchingPaths.some((candidate) => namespacePathsMatch(candidate, selected))) return false;
  const usesLegacyNamespace = actual.some((segment) => (
    parseWorkflowCallNamespaceSegment(segment)?.siteDigest === undefined
  ));
  return !usesLegacyNamespace || (!graphTruncated && matchingPaths.length === 1);
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
  const filename = portableRelativePath(root, path);
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
  include: (filename: string) => boolean = () => true,
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
  const paths = (await collectReportPaths(
    root,
    root,
    (path) => include(portableRelativePath(root, path)),
  )).sort((left, right) => portableRelativePath(root, left).localeCompare(portableRelativePath(root, right)));
  await verifyRunsRootSnapshot(location, snapshot);
  const reports = await Promise.all(paths.map((path) => readReport(location, snapshot, root, path)));
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

export async function readRunOccurrenceArtifacts(
  location: RunStoreLocation,
  slug: string,
  occurrenceId: string,
): Promise<{
  readonly reports: readonly Awaited<ReturnType<typeof readReport>>[];
  readonly prompts: readonly RunPromptArtifact[];
}> {
  assertRunSlug(slug);
  if (occurrenceId.length === 0) throw new Error('Occurrence id is required');
  const snapshot = await captureRunsRoot(location);
  const meta = await loadRunMeta(location, snapshot, slug);
  const logArtifacts = await loadLogArtifacts(location, snapshot, meta);
  const selectedOccurrence = logArtifacts.graphSummary.occurrences.find(
    (occurrence) => occurrence.occurrenceId === occurrenceId,
  );
  if (selectedOccurrence === undefined) {
    throw new RunOccurrenceNotFoundError();
  }
  const cacheKey = resolve(snapshot.directory, meta.runSlug);
  const lifecycle = getRunOccurrenceLifecycle(cacheKey, occurrenceId);
  if (lifecycle === undefined) {
    throw new RunOccurrenceNotFoundError();
  }
  const paths = await resolveSessionLogPaths(location, snapshot, meta);
  const prompts = await readRunOccurrencePrompts(
    paths,
    selectedOccurrence,
    () => verifyRunsRootSnapshot(location, snapshot),
    lifecycle,
  );
  const reports = await loadReports(
    location,
    snapshot,
    meta,
    (filename) => reportBelongsToOccurrence(
      filename,
      meta,
      selectedOccurrence,
      logArtifacts.graphSummary.occurrences,
      logArtifacts.graphSummary.truncated,
    ),
  );
  await verifyRunsRootSnapshot(location, snapshot);
  return { reports, prompts };
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
