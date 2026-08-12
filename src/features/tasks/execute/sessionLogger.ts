/**
 * Session logger — NDJSON ログ書き出し専用モジュール
 *
 * WorkflowEngine のイベントを受け取り、NDJSON セッションログへ追記する責務を担う。
 */

import {
  appendNdjsonLine,
  parseNdjsonRecord,
} from '../../../infra/fs/index.js';
import type { InteractiveMetadata } from './types.js';
import { createLogger, isDebugEnabled, writePromptLog } from '../../../shared/utils/index.js';
import type { PromptLogRecord, NdjsonRecord } from '../../../shared/utils/index.js';
import type { WorkflowResumePointEntry, WorkflowStep, AgentResponse, WorkflowState } from '../../../core/models/index.js';
import type {
  JudgeStageEntry,
  PhasePromptParts,
  StepProviderInfo,
  WorkflowCallCompleteLifecycle,
  WorkflowCallLifecycle,
  WorkflowEvents,
} from '../../../core/workflow/types.js';
import { parsePhaseExecutionId } from '../../../shared/utils/phaseExecutionId.js';
import { sanitizeTextForStorage } from './traceReportRedaction.js';
import { buildWorkflowStepScopeKey } from './workflowStepScope.js';
import { SessionLoggerPhaseTracker } from './sessionLoggerPhaseTracker.js';
import { safeExternalErrorMessage } from '../../../shared/utils/safeExternalErrorMessage.js';
import {
  buildInteractiveRecords,
  buildPhaseCompleteRecord,
  buildPhaseJudgeStageRecord,
  buildPhaseStartRecord,
  buildPromptLogRecord,
  buildStepCompleteRecord,
  buildStepStartRecord,
  buildWorkflowAbortRecord,
  buildWorkflowCallCompleteRecord,
  buildWorkflowCallStartRecord,
  buildWorkflowCompleteRecord,
  buildCompanionReviewRoundRecord,
  buildCompanionQueueCoalescedRecord,
  buildCompanionCallRecord,
  buildCompanionReviewSkippedRecord,
} from './sessionLoggerRecordFactory.js';
import type {
  NdjsonCompanionReviewSkipped,
  NdjsonCompanionQueueCoalesced,
  NdjsonCompanionReviewRound,
} from '../../../shared/utils/types.js';
import {
  PrivateArtifactPublicationConflictError,
  readPrivateFileState,
  writePrivateFileWithModeExpected,
} from '../../../shared/utils/private-file.js';

const SESSION_LOG_MODE = 0o600;
const log = createLogger('session-logger');

type TerminalSessionRecord = Extract<
  NdjsonRecord,
  { type: 'workflow_complete' | 'workflow_abort' }
> & {
  readonly publicationId: string;
};

export function projectTerminalSessionRecord(
  ndjsonLogPath: string,
  start: {
    readonly task: string;
    readonly workflowName: string;
    readonly startTime: string;
  },
  record: TerminalSessionRecord,
): void {
  while (true) {
    const snapshot = readPrivateFileState(ndjsonLogPath);
    const lines = snapshot.state.exists
      ? requireSessionLogContent(snapshot, ndjsonLogPath)
          .toString('utf-8')
          .split('\n')
          .filter((line) => line.length > 0)
      : [];
    const records = lines.map(parseNdjsonRecord);
    if (records.length === 0) {
      records.push({
        type: 'workflow_start',
        task: start.task,
        workflowName: start.workflowName,
        startTime: start.startTime,
      });
    } else {
      assertSessionStart(records[0], start);
    }
    const terminalIndex = records.findIndex(isTerminalSessionRecord);
    if (terminalIndex !== -1) {
      const existing = records[terminalIndex] as TerminalSessionRecord;
      if (terminalIndex !== records.length - 1) {
        throw new Error('NDJSON terminal record must be the final record');
      }
      if (
        existing.publicationId === record.publicationId
        && sameTerminalSessionRecord(existing, record)
      ) {
        return;
      }
      throw new Error(
        `NDJSON terminal publication conflicts with "${record.publicationId}"`,
      );
    }
    const content = `${records
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n${JSON.stringify(record)}\n`;
    try {
      writePrivateFileWithModeExpected(
        ndjsonLogPath,
        content,
        SESSION_LOG_MODE,
        snapshot.state,
      );
      return;
    } catch (error) {
      if (error instanceof PrivateArtifactPublicationConflictError) {
        continue;
      }
      throw error;
    }
  }
}

function requireSessionLogContent(
  snapshot: ReturnType<typeof readPrivateFileState>,
  path: string,
): Buffer {
  if (!('content' in snapshot)) {
    throw new Error(`NDJSON session log content is missing: ${path}`);
  }
  return snapshot.content;
}

function assertSessionStart(
  record: NdjsonRecord | undefined,
  expected: {
    readonly task: string;
    readonly workflowName: string;
    readonly startTime: string;
  },
): void {
  if (
    record?.type !== 'workflow_start'
    || record.task !== expected.task
    || record.workflowName !== expected.workflowName
    || record.startTime !== expected.startTime
  ) {
    throw new Error('NDJSON workflow_start identity is invalid');
  }
}

function isTerminalSessionRecord(
  record: NdjsonRecord,
): record is TerminalSessionRecord {
  return record.type === 'workflow_complete'
    || record.type === 'workflow_abort';
}

function sameTerminalSessionRecord(
  left: TerminalSessionRecord,
  right: TerminalSessionRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class SessionLogger {
  private readonly ndjsonLogPath: string;
  private readonly allowSensitiveData: boolean;
  private readonly phaseTracker = new SessionLoggerPhaseTracker();
  private readonly activeStepIterations = new Map<string, number>();
  private readonly ndjsonRecords: NdjsonRecord[] = [];
  private readonly promptRecords: PromptLogRecord[] = [];
  private workflowTerminalLogged = false;
  private companionAuditWriteFailureReported = false;

  constructor(ndjsonLogPath: string, allowSensitiveData: boolean) {
    this.ndjsonLogPath = ndjsonLogPath;
    this.allowSensitiveData = allowSensitiveData;
  }

  writeInteractiveMetadata(meta: InteractiveMetadata): void {
    const [startRecord, endRecord] = buildInteractiveRecords(meta, this.sanitizeText.bind(this));
    this.appendRecord(startRecord);
    this.appendRecord(endRecord);
  }

  onPhaseStart(
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: 'execute' | 'report' | 'judge',
    instruction: string,
    promptParts: PhasePromptParts,
    workflowStack: WorkflowResumePointEntry[] | undefined,
    phaseExecutionId?: string,
    iteration?: number,
  ): void {
    if (!instruction) {
      throw new Error(`Missing phase instruction for ${step.name}:${phase}`);
    }
    const debugEnabled = isDebugEnabled();
    const resolvedPhaseExecutionId = this.phaseTracker.trackStart({
      stepName: step.name,
      phase,
      phaseExecutionId,
      iteration,
      promptParts,
      capturePrompt: debugEnabled,
      scopeKey: buildWorkflowStepScopeKey(step.name, workflowStack),
    });
    const record = buildPhaseStartRecord(
      step,
      phase,
      phaseName,
      instruction,
      promptParts,
      workflowStack,
      resolvedPhaseExecutionId,
      iteration,
      this.sanitizeText.bind(this),
    );
    this.appendRecord(record);
  }

  onPhaseComplete(
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: 'execute' | 'report' | 'judge',
    content: string,
    phaseStatus: string,
    phaseError: string | undefined,
    workflowStack: WorkflowResumePointEntry[] | undefined,
    phaseExecutionId?: string,
    iteration?: number,
  ): void {
    if (!phaseStatus) {
      throw new Error(`Missing phase status for ${step.name}:${phase}`);
    }
    const debugEnabled = isDebugEnabled();
    const trackedPhase = this.phaseTracker.trackCompletion({
      stepName: step.name,
      phase,
      phaseExecutionId,
      iteration,
      requirePrompt: debugEnabled,
      scopeKey: buildWorkflowStepScopeKey(step.name, workflowStack),
    });
    const completedAt = new Date().toISOString();
    const record = buildPhaseCompleteRecord(
      step,
      phase,
      phaseName,
      content,
      phaseStatus,
      phaseError,
      workflowStack,
      trackedPhase.phaseExecutionId,
      iteration,
      completedAt,
      this.sanitizeText.bind(this),
    );
    this.appendRecord(record);

    if (debugEnabled && trackedPhase.promptParts) {
      const promptIteration = iteration
        ?? parsePhaseExecutionId(trackedPhase.phaseExecutionId)?.iteration;
      if (promptIteration === undefined) {
        throw new Error(
          `Missing iteration for debug prompt: ${step.name}:${phase}:${trackedPhase.phaseExecutionId}`,
        );
      }
      const promptRecord = buildPromptLogRecord(
        step,
        phase,
        promptIteration,
        buildWorkflowStepScopeKey(step.name, workflowStack),
        trackedPhase.phaseExecutionId,
        trackedPhase.promptParts,
        content,
        completedAt,
        this.sanitizeText.bind(this),
      );
      writePromptLog(promptRecord);
      this.promptRecords.push(promptRecord);
    }
  }

  onJudgeStage(
    step: WorkflowStep,
    phase: 3,
    phaseName: 'judge',
    entry: JudgeStageEntry,
    workflowStack: WorkflowResumePointEntry[] | undefined,
    phaseExecutionId?: string,
    iteration?: number,
  ): void {
    const resolvedPhaseExecutionId = this.phaseTracker.resolveExistingExecutionId({
      stepName: step.name,
      phase,
      phaseExecutionId,
      iteration,
      scopeKey: buildWorkflowStepScopeKey(step.name, workflowStack),
    });
    const record = buildPhaseJudgeStageRecord(
      step,
      phase,
      phaseName,
      entry,
      workflowStack,
      resolvedPhaseExecutionId,
      iteration,
      this.sanitizeText.bind(this),
    );
    this.appendRecord(record);
  }

  onStepStart(
    step: WorkflowStep,
    iteration: number,
    instruction: string | undefined,
    workflowStack: WorkflowResumePointEntry[] | undefined,
    providerInfo?: StepProviderInfo,
  ): void {
    this.activeStepIterations.set(buildWorkflowStepScopeKey(step.name, workflowStack), iteration);
    const record = buildStepStartRecord(
      step,
      iteration,
      instruction,
      workflowStack,
      this.sanitizeText.bind(this),
      providerInfo,
    );
    this.appendRecord(record);
  }

  onWorkflowCallStart(lifecycle: WorkflowCallLifecycle): void {
    this.appendRecord(buildWorkflowCallStartRecord(lifecycle));
  }

  onWorkflowCallComplete(lifecycle: WorkflowCallCompleteLifecycle): void {
    this.appendRecord(buildWorkflowCallCompleteRecord(
      lifecycle,
      this.sanitizeText.bind(this),
    ));
  }

  onStepComplete(
    step: WorkflowStep,
    response: AgentResponse,
    instruction: string,
    workflowStack: WorkflowResumePointEntry[] | undefined,
  ): void {
    const stepScopeKey = buildWorkflowStepScopeKey(step.name, workflowStack);
    const iteration = this.activeStepIterations.get(stepScopeKey);
    if (iteration == null) {
      throw new Error(`Missing step iteration for completion: ${step.name}`);
    }
    this.activeStepIterations.delete(stepScopeKey);
    const record = buildStepCompleteRecord(
      step,
      response,
      instruction,
      iteration,
      workflowStack,
      this.sanitizeText.bind(this),
    );
    this.appendRecord(record);
  }

  onWorkflowComplete(state: WorkflowState): void {
    if (this.workflowTerminalLogged) {
      return;
    }
    this.appendRecord(buildWorkflowCompleteRecord(state));
    this.workflowTerminalLogged = true;
  }

  onWorkflowAbort(
    state: WorkflowState,
    reason: string,
    failureCategory?: AgentResponse['failureCategory'],
  ): void {
    if (this.workflowTerminalLogged) {
      return;
    }
    this.appendRecord(buildWorkflowAbortRecord(
      state,
      reason,
      this.sanitizeText.bind(this),
      failureCategory,
    ));
    this.workflowTerminalLogged = true;
  }

  onCompanionReviewRound(
    input: Omit<NdjsonCompanionReviewRound, 'type' | 'timestamp'>,
  ): void {
    this.appendCompanionAuditRecord('companion_review_round', () => buildCompanionReviewRoundRecord(
      input,
      this.sanitizeText.bind(this),
    ));
  }

  onCompanionQueueCoalesced(
    input: Omit<NdjsonCompanionQueueCoalesced, 'type' | 'timestamp'>,
  ): void {
    this.appendRecord(buildCompanionQueueCoalescedRecord(input));
  }

  onCompanionCall(
    input: Parameters<WorkflowEvents['companion:call']>[0],
  ): void {
    this.appendCompanionAuditRecord('companion_call', () => buildCompanionCallRecord(
      input,
      this.sanitizeText.bind(this),
    ));
  }

  onCompanionReviewSkipped(
    input: Omit<NdjsonCompanionReviewSkipped, 'type' | 'timestamp'>,
  ): void {
    this.appendCompanionAuditRecord('companion_review_skipped', () => buildCompanionReviewSkippedRecord(input));
  }

  getNdjsonRecords(): NdjsonRecord[] {
    return [...this.ndjsonRecords];
  }

  getPromptRecords(): PromptLogRecord[] {
    return [...this.promptRecords];
  }

  private appendRecord(record: NdjsonRecord): void {
    this.ndjsonRecords.push(record);
    appendNdjsonLine(this.ndjsonLogPath, record);
  }

  private appendCompanionAuditRecord(
    recordType: Extract<NdjsonRecord, {
      type: 'companion_call' | 'companion_review_round' | 'companion_review_skipped';
    }>['type'],
    buildRecord: () => NdjsonRecord,
  ): void {
    try {
      const record = buildRecord();
      appendNdjsonLine(this.ndjsonLogPath, record);
      this.ndjsonRecords.push(record);
    } catch (error) {
      if (this.companionAuditWriteFailureReported) return;
      this.companionAuditWriteFailureReported = true;
      log.warn('Companion audit record could not be persisted; continuing workflow', {
        recordType,
        error: safeExternalErrorMessage(error),
      });
    }
  }

  private sanitizeText(text: string): string {
    return sanitizeTextForStorage(text, this.allowSensitiveData);
  }
}
