import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isPathInside, isValidReportDirName } from '../../../shared/utils/index.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import type { WorkflowResumePoint } from '../../models/types.js';
import { parseWorkflowResumePoint } from '../resume-point-codec.js';
import type { WorkflowTraceDiscovery } from '../observability/traceDiscovery.js';
import { buildRunPaths } from './run-paths.js';
import {
  decodePullRequestContext,
  type PullRequestContext,
} from '../pr-context.js';

export interface RunMetaObservability {
  traceDiscovery: WorkflowTraceDiscovery;
}

export const RUN_RESUME_MODES = ['requeue', 'retry', 'instruct'] as const;
export type RunResumeMode = (typeof RUN_RESUME_MODES)[number];

export interface RunResumeSource {
  readonly sourceRunSlug?: string;
  readonly resumeMode: RunResumeMode;
}

export interface RunFailure {
  readonly step: string;
  readonly error: string;
}

export interface RunMeta {
  task: string;
  workflow: string;
  runSlug: string;
  runRoot: string;
  reportDirectory: string;
  contextDirectory: string;
  logsDirectory: string;
  status: 'running' | 'completed' | 'aborted' | 'failed';
  reason?: string;
  failure?: RunFailure;
  startTime: string;
  endTime?: string;
  iterations?: number;
  currentStep?: string;
  currentIteration?: number;
  phase?: 1 | 2 | 3;
  updatedAt?: string;
  observability?: RunMetaObservability;
  resumePoint?: WorkflowResumePoint;
  sourceRunSlug?: string;
  resumeMode?: RunResumeSource['resumeMode'];
  /** resume-artifacts.json（継承 manifest）への相対パス。SSOT は manifest 側。 */
  resumeArtifacts?: string;
  operationJournalRunSlug?: string;
  operationClaimToken?: string;
  prContext?: PullRequestContext;
}

export const RESUMABLE_RUN_STATUSES = Object.freeze([
  'aborted',
  'failed',
] as const satisfies readonly RunMeta['status'][]);

export function isResumableRunStatus(
  status: RunMeta['status'],
): status is (typeof RESUMABLE_RUN_STATUSES)[number] {
  return (RESUMABLE_RUN_STATUSES as readonly RunMeta['status'][]).includes(status);
}

interface RawRunMeta extends Omit<
  RunMeta,
  | 'resumePoint'
  | 'sourceRunSlug'
  | 'resumeMode'
  | 'resumeArtifacts'
  | 'operationJournalRunSlug'
  | 'operationClaimToken'
  | 'prContext'
> {
  resumePoint?: unknown;
  resume_point?: unknown;
  source_run_slug?: string;
  resume_mode?: RunResumeMode;
  resume_artifacts?: string;
  operation_journal_run_slug?: string;
  operation_claim_token?: string;
  pr_context?: unknown;
}

export type RunMetaWarningHandler = (warning: string) => void;

function normalizeRunMeta(value: unknown): RunMeta {
  const raw = parseRawRunMeta(value);
  const {
    resumePoint: camelResumePoint,
    resume_point: persistedResumePoint,
    source_run_slug: persistedSourceRunSlug,
    resume_mode: persistedResumeMode,
    resume_artifacts: persistedResumeArtifacts,
    operation_journal_run_slug: persistedOperationJournalRunSlug,
    operation_claim_token: persistedOperationClaimToken,
    pr_context: persistedPrContext,
    ...baseMeta
  } = raw;
  const rawResumePoint = camelResumePoint ?? persistedResumePoint;
  const resumePoint = rawResumePoint === undefined
    ? undefined
    : parseWorkflowResumePoint(rawResumePoint);
  return {
    ...baseMeta,
    ...(resumePoint === undefined ? {} : { resumePoint }),
    ...(persistedSourceRunSlug === undefined
      ? {}
      : { sourceRunSlug: persistedSourceRunSlug }),
    ...(persistedResumeMode === undefined ? {} : { resumeMode: persistedResumeMode }),
    ...(persistedResumeArtifacts === undefined
      ? {}
      : { resumeArtifacts: persistedResumeArtifacts }),
    ...(persistedOperationJournalRunSlug === undefined
      ? {}
      : { operationJournalRunSlug: persistedOperationJournalRunSlug }),
    ...(persistedOperationClaimToken === undefined
      ? {}
      : { operationClaimToken: persistedOperationClaimToken }),
    ...(persistedPrContext === undefined
      ? {}
      : { prContext: decodePullRequestContext(persistedPrContext) }),
  };
}

export function parseRunMeta(value: unknown): RunMeta {
  return normalizeRunMeta(value);
}

function emitRunMetaWarning(
  metaPath: string,
  error: unknown,
  onWarning?: RunMetaWarningHandler,
): null {
  onWarning?.(`Failed to parse run metadata at ${metaPath}: ${getErrorMessage(error)}`);
  return null;
}

export function readRunMeta(metaPath: string, onWarning?: RunMetaWarningHandler): RunMeta | null {
  if (!existsSync(metaPath)) {
    return null;
  }

  const raw = readFileSync(metaPath, 'utf-8').trim();
  if (!raw) {
    return null;
  }

  try {
    return normalizeRunMeta(JSON.parse(raw) as unknown);
  } catch (error) {
    return emitRunMetaWarning(metaPath, error, onWarning);
  }
}

function parseRawRunMeta(value: unknown): RawRunMeta {
  const raw = requireRecord(value, 'Run metadata');
  const status = raw.status;
  if (
    status !== 'running'
    && status !== 'completed'
    && status !== 'aborted'
    && status !== 'failed'
  ) {
    throw new Error('Run metadata status is invalid');
  }
  const result: RawRunMeta = {
    task: requiredString(raw.task, 'task'),
    workflow: requiredString(raw.workflow, 'workflow'),
    runSlug: requiredString(raw.runSlug, 'runSlug'),
    runRoot: requiredString(raw.runRoot, 'runRoot'),
    reportDirectory: requiredString(raw.reportDirectory, 'reportDirectory'),
    contextDirectory: requiredString(raw.contextDirectory, 'contextDirectory'),
    logsDirectory: requiredString(raw.logsDirectory, 'logsDirectory'),
    status,
    startTime: requiredString(raw.startTime, 'startTime'),
    ...(optionalString(raw.reason, 'reason')),
    ...(raw.failure === undefined
      ? {}
      : { failure: parseRunFailure(raw.failure) }),
    ...(optionalString(raw.endTime, 'endTime')),
    ...(optionalInteger(raw.iterations, 'iterations')),
    ...(optionalString(raw.currentStep, 'currentStep')),
    ...(optionalInteger(raw.currentIteration, 'currentIteration')),
    ...(raw.phase === undefined ? {} : { phase: requiredPhase(raw.phase) }),
    ...(optionalString(raw.updatedAt, 'updatedAt')),
    ...(raw.observability === undefined
      ? {}
      : { observability: parseRunMetaObservability(raw.observability) }),
    ...(raw.resumePoint === undefined
      ? {}
      : { resumePoint: parseWorkflowResumePoint(raw.resumePoint) }),
    ...(raw.resume_point === undefined
      ? {}
      : { resume_point: parseWorkflowResumePoint(raw.resume_point) }),
    ...(optionalString(raw.source_run_slug, 'source_run_slug')),
    ...(raw.resume_mode === undefined
      ? {}
      : { resume_mode: requiredResumeMode(raw.resume_mode) }),
    ...(optionalString(raw.resume_artifacts, 'resume_artifacts')),
    ...(optionalString(
      raw.operation_journal_run_slug,
      'operation_journal_run_slug',
    )),
    ...(optionalString(raw.operation_claim_token, 'operation_claim_token')),
    ...(raw.pr_context === undefined ? {} : { pr_context: raw.pr_context }),
  };
  return result;
}

function requireRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Run metadata ${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  value: unknown,
  label: string,
): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  return { [label]: requiredString(value, label) };
}

function optionalInteger(
  value: unknown,
  label: string,
): Record<string, number> {
  if (value === undefined) {
    return {};
  }
  return { [label]: requiredNonNegativeInteger(value, label) };
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Run metadata ${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function requiredPhase(value: unknown): 1 | 2 | 3 {
  if (value !== 1 && value !== 2 && value !== 3) {
    throw new Error('Run metadata phase is invalid');
  }
  return value;
}

function requiredResumeMode(value: unknown): RunResumeMode {
  if (
    value !== 'requeue'
    && value !== 'retry'
    && value !== 'instruct'
  ) {
    throw new Error('Run metadata resume_mode is invalid');
  }
  return value;
}

function parseRunFailure(value: unknown): RunFailure {
  const failure = requireRecord(value, 'failure');
  const unsupportedKey = Object.keys(failure).find(
    (key) => key !== 'step' && key !== 'error',
  );
  if (unsupportedKey !== undefined) {
    throw new Error(`Run metadata failure.${unsupportedKey} is not supported`);
  }
  return {
    step: requiredString(failure.step, 'failure.step'),
    error: requiredString(failure.error, 'failure.error'),
  };
}

function parseRunMetaObservability(value: unknown): RunMetaObservability {
  const observability = requireRecord(value, 'observability');
  const discovery = requireRecord(
    observability.traceDiscovery,
    'observability.traceDiscovery',
  );
  if (discovery.serviceName !== 'takt') {
    throw new Error('Run metadata trace discovery serviceName is invalid');
  }
  const queries = discovery.queries;
  if (
    !Array.isArray(queries)
    || queries.some((query) => typeof query !== 'string')
  ) {
    throw new Error('Run metadata trace discovery queries are invalid');
  }
  return {
    traceDiscovery: {
      serviceName: 'takt',
      runId: requiredString(discovery.runId, 'traceDiscovery.runId'),
      workflowName: requiredString(
        discovery.workflowName,
        'traceDiscovery.workflowName',
      ),
      queries: [...queries],
      ...(discovery.task === undefined
        ? {}
        : { task: parseTraceDiscoveryTask(discovery.task) }),
      ...(discovery.git === undefined
        ? {}
        : { git: parseTraceDiscoveryGit(discovery.git) }),
    },
  };
}

function parseTraceDiscoveryTask(
  value: unknown,
): NonNullable<WorkflowTraceDiscovery['task']> {
  const task = requireRecord(value, 'traceDiscovery.task');
  const source = task.source;
  if (
    source !== undefined
    && source !== 'issue'
    && source !== 'pr_review'
    && source !== 'manual'
  ) {
    throw new Error('Run metadata trace discovery task source is invalid');
  }
  return {
    ...(optionalStringValue(task.name, 'traceDiscovery.task.name')),
    ...(optionalStringValue(task.slug, 'traceDiscovery.task.slug')),
    ...(source === undefined ? {} : { source }),
    ...(optionalPositiveInteger(
      task.issueNumber,
      'traceDiscovery.task.issueNumber',
    )),
    ...(optionalPositiveInteger(
      task.prNumber,
      'traceDiscovery.task.prNumber',
    )),
    ...(optionalStringValue(task.summary, 'traceDiscovery.task.summary')),
  };
}

function parseTraceDiscoveryGit(
  value: unknown,
): NonNullable<WorkflowTraceDiscovery['git']> {
  const git = requireRecord(value, 'traceDiscovery.git');
  return {
    ...(optionalStringValue(git.branch, 'traceDiscovery.git.branch')),
    ...(optionalStringValue(git.baseBranch, 'traceDiscovery.git.baseBranch')),
  };
}

function optionalStringValue(
  value: unknown,
  field: string,
): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  const key = field.slice(field.lastIndexOf('.') + 1);
  return { [key]: requiredString(value, field) };
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
): Record<string, number> {
  if (value === undefined) {
    return {};
  }
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Run metadata ${field} must be a positive safe integer`);
  }
  const key = field.slice(field.lastIndexOf('.') + 1);
  return { [key]: value as number };
}

export function readRunMetaBySlug(cwd: string, slug: string, onWarning?: RunMetaWarningHandler): RunMeta | null {
  if (!isValidReportDirName(slug)) {
    return null;
  }

  const runsDir = resolve(cwd, '.takt', 'runs');
  const metaPath = resolve(runsDir, slug, 'meta.json');
  if (!isPathInside(runsDir, metaPath)) {
    return null;
  }

  const meta = readRunMeta(metaPath, onWarning);
  if (!meta) {
    return null;
  }
  if (meta.runSlug !== slug) {
    throw new Error(
      `Run metadata slug "${meta.runSlug}" does not match directory slug "${slug}"`,
    );
  }

  const runPaths = buildRunPaths(cwd, slug);
  return {
    ...meta,
    runSlug: slug,
    runRoot: runPaths.runRootRel,
    reportDirectory: runPaths.reportsRel,
    contextDirectory: runPaths.contextRel,
    logsDirectory: runPaths.logsRel,
  };
}

function resolveRunningStep(meta: RunMeta | null): string | undefined {
  if (!meta) {
    return undefined;
  }

  if (meta.status !== 'running') {
    return undefined;
  }

  if (meta.currentStep) {
    return meta.currentStep;
  }
  return undefined;
}

export function findRunningStepByRunSlug(
  cwd: string,
  runSlug: string,
  onWarning?: RunMetaWarningHandler,
): string | undefined {
  return resolveRunningStep(readRunMetaBySlug(cwd, runSlug, onWarning));
}
