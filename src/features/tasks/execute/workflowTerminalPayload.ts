import { basename } from 'node:path';
import type { WorkflowTraceDiscovery } from '../../../core/workflow/observability/traceDiscovery.js';
import type { SessionState } from '../../../infra/config/index.js';
import type { SessionLog } from '../../../infra/fs/index.js';
import type { NdjsonRecord } from '../../../shared/utils/types.js';
import {
  parseCanonicalWorkflowResumeFrame,
} from '../../../shared/types/workflow-resume.js';
import type { TraceReportMode } from './traceReport.js';
import {
  buildWorkflowAbortSessionFinalization,
  buildWorkflowSuccessSessionFinalization,
} from './workflowExecutionReporting.js';
import { sanitizeTextForStorage } from './traceReportRedaction.js';

type TerminalSessionRecord = Extract<
  NdjsonRecord,
  { type: 'workflow_complete' | 'workflow_abort' }
>;

export interface WorkflowTerminalPublicationContext {
  readonly runSlug: string;
  readonly projectCwd: string;
  readonly task: string;
  readonly workflowName: string;
  readonly sessionLog: SessionLog;
  readonly sessionId: string;
  readonly ndjsonLogPath: string;
  readonly traceReportMode: TraceReportMode;
  readonly promptLogPath?: string;
  readonly traceDiscovery?: WorkflowTraceDiscovery;
}

export interface WorkflowTerminalPublicationPayload {
  readonly runSlug: string;
  readonly projectCwd: string;
  readonly task: string;
  readonly workflowName: string;
  readonly status: 'completed' | 'aborted' | 'failed';
  readonly iterations: number;
  readonly reason?: string;
  readonly endTime: string;
  readonly sessionLog: SessionLog;
  readonly sessionState: SessionState;
  readonly sessionRecord: TerminalSessionRecord;
  readonly ndjsonLogFile: string;
  readonly traceReportMode: TraceReportMode;
  readonly promptLogPath?: string;
  readonly traceDiscovery?: WorkflowTraceDiscovery;
}

export interface WorkflowTerminalPayloadFactory {
  create(input: {
    readonly status: 'completed' | 'aborted' | 'failed';
    readonly iterations: number;
    readonly reason?: string;
    readonly lastStepContent: string | undefined;
    readonly lastStepName: string | undefined;
    readonly sessionLog?: SessionLog;
    readonly endTime: string;
  }): WorkflowTerminalPublicationPayload;
  assertIdentity(payload: WorkflowTerminalPublicationPayload): void;
}

export function createWorkflowTerminalPayloadFactory(
  context: WorkflowTerminalPublicationContext,
): WorkflowTerminalPayloadFactory {
  if (basename(context.ndjsonLogPath) !== `${context.sessionId}.jsonl`) {
    throw new Error(
      `Workflow terminal NDJSON identity does not match session "${context.sessionId}"`,
    );
  }
  const create = (
    input: Parameters<WorkflowTerminalPayloadFactory['create']>[0],
  ): WorkflowTerminalPublicationPayload =>
    canonicalizeWorkflowTerminalPublicationPayload(
      assembleWorkflowTerminalPublicationPayload({
        ...context,
        ...input,
      }),
    );
  return {
    create,
    assertIdentity(payload): void {
      if (
        payload.runSlug !== context.runSlug
        || payload.projectCwd !== context.projectCwd
        || payload.workflowName !== context.workflowName
      ) {
        throw new Error(
          `Workflow terminal payload identity does not match run "${context.runSlug}"`,
        );
      }
    },
  };
}

function assembleWorkflowTerminalPublicationPayload(
  input: WorkflowTerminalPublicationContext & {
    readonly status: 'completed' | 'aborted' | 'failed';
    readonly iterations: number;
    readonly reason?: string;
    readonly lastStepContent: string | undefined;
    readonly lastStepName: string | undefined;
    readonly endTime: string;
  },
): WorkflowTerminalPublicationPayload {
  const finalization = input.status === 'completed'
    ? buildWorkflowSuccessSessionFinalization({
        sessionLog: input.sessionLog,
        task: input.task,
        workflowName: input.workflowName,
        lastStepContent: input.lastStepContent,
        lastStepName: input.lastStepName,
        endTime: input.endTime,
      })
    : buildWorkflowAbortSessionFinalization({
        sessionLog: input.sessionLog,
        reason: requireTerminalReason(input.reason),
        task: input.task,
        workflowName: input.workflowName,
        lastStepName: input.lastStepName,
        endTime: input.endTime,
      });
  const sessionRecord: TerminalSessionRecord = input.status === 'completed'
    ? {
        type: 'workflow_complete',
        iterations: input.iterations,
        endTime: input.endTime,
      }
    : {
        type: 'workflow_abort',
        iterations: input.iterations,
        reason: sanitizeTextForStorage(
          requireTerminalReason(input.reason),
          input.traceReportMode === 'full',
        ),
        endTime: input.endTime,
      };
  return {
    runSlug: input.runSlug,
    projectCwd: input.projectCwd,
    task: input.task,
    workflowName: input.workflowName,
    status: input.status,
    iterations: input.iterations,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    endTime: input.endTime,
    sessionLog: finalization.sessionLog,
    sessionState: finalization.sessionState,
    sessionRecord,
    ndjsonLogFile: basename(input.ndjsonLogPath),
    traceReportMode: input.traceReportMode,
    ...(input.promptLogPath === undefined
      ? {}
      : { promptLogPath: input.promptLogPath }),
    ...(input.traceDiscovery === undefined
      ? {}
      : { traceDiscovery: input.traceDiscovery }),
  };
}

function canonicalizeWorkflowTerminalPublicationPayload(
  payload: unknown,
): WorkflowTerminalPublicationPayload {
  const snapshot = snapshotJsonDomainValue(
    payload,
    '$',
    new WeakSet<object>(),
  );
  assertWorkflowTerminalPublicationPayload(snapshot);
  return snapshot;
}

function assertWorkflowTerminalPublicationPayload(
  value: unknown,
): asserts value is WorkflowTerminalPublicationPayload {
  const payload = requireRecord(value, '$');
  assertAllowedKeys(payload, [
    'runSlug',
    'projectCwd',
    'task',
    'workflowName',
    'status',
    'iterations',
    'reason',
    'endTime',
    'sessionLog',
    'sessionState',
    'sessionRecord',
    'ndjsonLogFile',
    'traceReportMode',
    'promptLogPath',
    'traceDiscovery',
  ], '$');
  requireNonEmptyString(payload.runSlug, '$.runSlug');
  requireNonEmptyString(payload.projectCwd, '$.projectCwd');
  requireString(payload.task, '$.task');
  requireNonEmptyString(payload.workflowName, '$.workflowName');
  if (
    payload.status !== 'completed'
    && payload.status !== 'aborted'
    && payload.status !== 'failed'
  ) {
    throw new TypeError('Workflow terminal payload status is invalid');
  }
  requireNonNegativeInteger(payload.iterations, '$.iterations');
  if (payload.status !== 'completed') {
    requireTerminalReason(
      typeof payload.reason === 'string' ? payload.reason : undefined,
    );
  } else if (payload.reason !== undefined) {
    requireString(payload.reason, '$.reason');
  }
  requireIsoTimestamp(payload.endTime, '$.endTime');
  assertTerminalSessionLog(payload.sessionLog, payload);
  assertTerminalSessionState(payload.sessionState, payload);
  assertTerminalSessionRecord(payload.sessionRecord, payload);
  requireNonEmptyString(payload.ndjsonLogFile, '$.ndjsonLogFile');
  if (basename(payload.ndjsonLogFile) !== payload.ndjsonLogFile) {
    throw new TypeError('Workflow terminal payload ndjsonLogFile must be a basename');
  }
  if (
    payload.traceReportMode !== 'full'
    && payload.traceReportMode !== 'redacted'
  ) {
    throw new TypeError('Workflow terminal payload traceReportMode is invalid');
  }
  if (payload.promptLogPath !== undefined) {
    requireNonEmptyString(payload.promptLogPath, '$.promptLogPath');
  }
  if (payload.traceDiscovery !== undefined) {
    requireRecord(payload.traceDiscovery, '$.traceDiscovery');
  }
}

function assertTerminalSessionLog(
  value: unknown,
  payload: Readonly<Record<string, unknown>>,
): void {
  const sessionLog = requireRecord(value, '$.sessionLog');
  if (
    sessionLog.task !== payload.task
    || sessionLog.workflowName !== payload.workflowName
    || sessionLog.endTime !== payload.endTime
    || sessionLog.status !== (
      payload.status === 'completed' ? 'completed' : 'aborted'
    )
  ) {
    throw new TypeError(
      'Workflow terminal payload sessionLog identity or status is invalid',
    );
  }
  if (!Array.isArray(sessionLog.history)) {
    throw new TypeError(
      'Workflow terminal payload requires an array at $.sessionLog.history',
    );
  }
  sessionLog.history.forEach((entry, historyIndex) => {
    const history = requireRecord(
      entry,
      `$.sessionLog.history[${historyIndex}]`,
    );
    if (history.stack === undefined) {
      return;
    }
    if (!Array.isArray(history.stack) || history.stack.length === 0) {
      throw new TypeError(
        `Workflow terminal payload requires a non-empty array at $.sessionLog.history[${historyIndex}].stack`,
      );
    }
    history.stack.forEach((frame, frameIndex) => {
      parseCanonicalWorkflowResumeFrame(
        frame,
        `$.sessionLog.history[${historyIndex}].stack[${frameIndex}]`,
      );
    });
  });
}

function assertTerminalSessionState(
  value: unknown,
  payload: Readonly<Record<string, unknown>>,
): void {
  const state = requireRecord(value, '$.sessionState');
  const validStatus = payload.status === 'completed'
    ? state.status === 'success'
    : state.status === 'error' || state.status === 'user_stopped';
  if (
    !validStatus
    || state.timestamp !== payload.endTime
    || state.workflowName !== payload.workflowName
  ) {
    throw new TypeError(
      'Workflow terminal payload sessionState identity or status is invalid',
    );
  }
}

function assertTerminalSessionRecord(
  value: unknown,
  payload: Readonly<Record<string, unknown>>,
): void {
  const record = requireRecord(value, '$.sessionRecord');
  const expectedType = payload.status === 'completed'
    ? 'workflow_complete'
    : 'workflow_abort';
  if (
    record.type !== expectedType
    || record.iterations !== payload.iterations
    || record.endTime !== payload.endTime
  ) {
    throw new TypeError(
      'Workflow terminal payload sessionRecord identity or status is invalid',
    );
  }
}

function requireRecord(
  value: unknown,
  path: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Workflow terminal payload requires an object at ${path}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`Workflow terminal payload requires a string at ${path}`);
  }
}

function requireNonEmptyString(
  value: unknown,
  path: string,
): asserts value is string {
  requireString(value, path);
  if (value.length === 0) {
    throw new TypeError(`Workflow terminal payload requires a non-empty string at ${path}`);
  }
}

function requireIsoTimestamp(
  value: unknown,
  path: string,
): asserts value is string {
  requireNonEmptyString(value, path);
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(
      `Workflow terminal payload requires an ISO timestamp at ${path}`,
    );
  }
}

function assertAllowedKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw new TypeError(
        `Workflow terminal payload contains unknown field "${key}" at ${path}`,
      );
    }
  }
}

function requireNonNegativeInteger(
  value: unknown,
  path: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Workflow terminal payload requires a non-negative integer at ${path}`);
  }
}

function snapshotJsonDomainValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `Workflow terminal payload contains a non-finite number at ${path}`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    assertNotCircular(value, path, ancestors);
    const snapshot = value.map((entry, index) => {
      if (entry === undefined) {
        throw new TypeError(
          `Workflow terminal payload contains undefined at ${path}[${index}]`,
        );
      }
      return snapshotJsonDomainValue(
        entry,
        `${path}[${index}]`,
        ancestors,
      );
    });
    ancestors.delete(value);
    return Object.freeze(snapshot);
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        `Workflow terminal payload contains a non-JSON object at ${path}`,
      );
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new TypeError(
        `Workflow terminal payload contains a symbol key at ${path}`,
      );
    }
    assertNotCircular(value, path, ancestors);
    const snapshot: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) {
        continue;
      }
      snapshot[key] = snapshotJsonDomainValue(
        entry,
        `${path}.${key}`,
        ancestors,
      );
    }
    ancestors.delete(value);
    return Object.freeze(snapshot);
  }
  throw new TypeError(
    `Workflow terminal payload contains unsupported ${typeof value} at ${path}`,
  );
}

function assertNotCircular(
  value: object,
  path: string,
  ancestors: WeakSet<object>,
): void {
  if (ancestors.has(value)) {
    throw new TypeError(
      `Workflow terminal payload contains a cycle at ${path}`,
    );
  }
  ancestors.add(value);
}

export function requireTerminalReason(
  reason: string | undefined,
): string {
  if (reason === undefined || reason.length === 0) {
    throw new Error('Failed terminal publication requires a reason');
  }
  return reason;
}
