import type { WorkflowTraceTaskMetadata } from '../types.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';

const TRACE_DISCOVERY_SERVICE_NAME = 'takt';
const TRACE_TASK_SUMMARY_MAX_LENGTH = 80;

interface WorkflowTraceDiscoveryTask {
  name?: string;
  slug?: string;
  source?: NonNullable<WorkflowTraceTaskMetadata['taskSource']>;
  issueNumber?: number;
  prNumber?: number;
  summary?: string;
}

interface WorkflowTraceDiscoveryGit {
  branch?: string;
  baseBranch?: string;
}

export interface WorkflowTraceDiscovery {
  serviceName: typeof TRACE_DISCOVERY_SERVICE_NAME;
  runId: string;
  workflowName: string;
  task?: WorkflowTraceDiscoveryTask;
  git?: WorkflowTraceDiscoveryGit;
  queries: string[];
}

interface BuildTraceDiscoveryOptions {
  runId: string;
  workflowName: string;
  traceTaskMetadata?: WorkflowTraceTaskMetadata;
  sanitizeText: (text: string) => string;
}

export function buildTraceDiscovery(options: BuildTraceDiscoveryOptions): WorkflowTraceDiscovery {
  const runId = requireNonEmptyText('runId', options.runId);
  const workflowName = requireNonEmptyText('workflowName', options.workflowName);
  const task = buildTraceDiscoveryTask(options.traceTaskMetadata, options.sanitizeText);
  const git = buildTraceDiscoveryGit(options.traceTaskMetadata, options.sanitizeText);

  return {
    serviceName: TRACE_DISCOVERY_SERVICE_NAME,
    runId,
    workflowName,
    ...(task ? { task } : {}),
    ...(git ? { git } : {}),
    queries: buildTraceDiscoveryQueries({ runId, task, git }),
  };
}

export function sanitizeTraceTaskSummary(
  sanitizeText: (text: string) => string,
  text: string | undefined,
): string | undefined {
  const sanitized = sanitizeTraceTaskMetadataText(sanitizeText, text);
  const summary = sanitized?.trim().split('\n')[0]?.slice(0, TRACE_TASK_SUMMARY_MAX_LENGTH);
  return summary === '' ? undefined : summary;
}

export function sanitizeTraceTaskMetadataText(
  sanitizeText: (text: string) => string,
  text: string | undefined,
): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const sanitized = sanitizeSensitiveText(sanitizeText(text));
  return sanitized.trim() === '' ? undefined : sanitized;
}

function buildTraceDiscoveryTask(
  metadata: WorkflowTraceTaskMetadata | undefined,
  sanitizeText: (text: string) => string,
): WorkflowTraceDiscoveryTask | undefined {
  if (!metadata) {
    return undefined;
  }

  const task = compactTraceDiscoveryObject<WorkflowTraceDiscoveryTask>({
    name: sanitizeTraceTaskMetadataText(sanitizeText, metadata.taskName),
    slug: sanitizeTraceTaskMetadataText(sanitizeText, metadata.taskSlug),
    summary: sanitizeTraceTaskSummary(sanitizeText, metadata.taskSummary),
    source: validateTraceDiscoveryTaskSource(metadata.taskSource),
    issueNumber: validateTraceDiscoveryNumber('issueNumber', metadata.issueNumber),
    prNumber: validateTraceDiscoveryNumber('prNumber', metadata.prNumber),
  });
  return Object.keys(task).length === 0 ? undefined : task;
}

function buildTraceDiscoveryGit(
  metadata: WorkflowTraceTaskMetadata | undefined,
  sanitizeText: (text: string) => string,
): WorkflowTraceDiscoveryGit | undefined {
  if (!metadata) {
    return undefined;
  }

  const git = compactTraceDiscoveryObject<WorkflowTraceDiscoveryGit>({
    branch: sanitizeTraceTaskMetadataText(sanitizeText, metadata.gitBranch),
    baseBranch: sanitizeTraceTaskMetadataText(sanitizeText, metadata.gitBaseBranch),
  });
  return Object.keys(git).length === 0 ? undefined : git;
}

function buildTraceDiscoveryQueries(params: {
  runId: string;
  task: WorkflowTraceDiscoveryTask | undefined;
  git: WorkflowTraceDiscoveryGit | undefined;
}): string[] {
  return [
    traceQlStringFilter('takt.run.id', params.runId),
    ...(params.task?.prNumber !== undefined
      ? [traceQlNumberFilter('takt.task.pr_number', params.task.prNumber)]
      : []),
    ...(params.task?.issueNumber !== undefined
      ? [traceQlNumberFilter('takt.task.issue_number', params.task.issueNumber)]
      : []),
    ...(params.git?.branch !== undefined
      ? [traceQlStringFilter('takt.git.branch', params.git.branch)]
      : []),
  ];
}

function traceQlStringFilter(spanAttribute: string, value: string): string {
  return `{ resource.service.name = "${TRACE_DISCOVERY_SERVICE_NAME}" && span."${spanAttribute}" = "${escapeTraceQlString(value)}" }`;
}

function traceQlNumberFilter(spanAttribute: string, value: number): string {
  return `{ resource.service.name = "${TRACE_DISCOVERY_SERVICE_NAME}" && span."${spanAttribute}" = ${value} }`;
}

function escapeTraceQlString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function requireNonEmptyText(fieldName: string, value: string): string {
  if (value.trim() === '') {
    throw new Error(`Trace discovery ${fieldName} is required.`);
  }
  return value;
}

function validateTraceDiscoveryNumber(fieldName: string, value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Trace discovery ${fieldName} must be a positive integer.`);
  }
  return value;
}

function validateTraceDiscoveryTaskSource(
  value: WorkflowTraceTaskMetadata['taskSource'],
): WorkflowTraceDiscoveryTask['source'] {
  if (
    value === undefined
    || value === 'issue'
    || value === 'pr_review'
    || value === 'manual'
  ) {
    return value;
  }
  throw new Error(`Trace discovery taskSource is invalid: ${String(value)}`);
}

function compactTraceDiscoveryObject<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}
