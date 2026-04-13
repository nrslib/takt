/**
 * Session logger — NDJSON ログ書き出し専用モジュール
 *
 * WorkflowEngine のイベントを受け取り、NDJSON セッションログへ追記する責務を担う。
 */

import {
  appendNdjsonLine,
} from '../../../infra/fs/index.js';
import type { InteractiveMetadata } from './types.js';
import { isDebugEnabled, writePromptLog } from '../../../shared/utils/index.js';
import type { PromptLogRecord, NdjsonRecord } from '../../../shared/utils/index.js';
import type { WorkflowResumePointEntry, WorkflowStep, AgentResponse, WorkflowState } from '../../../core/models/index.js';
import type { JudgeStageEntry, PhasePromptParts } from '../../../core/workflow/types.js';
import { sanitizeTextForStorage } from './traceReportRedaction.js';
import { buildWorkflowStepScopeKey } from './workflowStepScope.js';
import { SessionLoggerPhaseTracker } from './sessionLoggerPhaseTracker.js';
import {
  buildInteractiveRecords,
  buildPhaseCompleteRecord,
  buildPhaseJudgeStageRecord,
  buildPhaseStartRecord,
  buildPromptLogRecord,
  buildStepCompleteRecord,
  buildStepStartRecord,
  buildWorkflowAbortRecord,
  buildWorkflowCompleteRecord,
} from './sessionLoggerRecordFactory.js';

export class SessionLogger {
  private readonly ndjsonLogPath: string;
  private readonly allowSensitiveData: boolean;
  private readonly phaseTracker = new SessionLoggerPhaseTracker();
  private readonly activeStepIterations = new Map<string, number>();
  private readonly ndjsonRecords: NdjsonRecord[] = [];
  private readonly promptRecords: PromptLogRecord[] = [];
  private currentIteration = 0;

  constructor(ndjsonLogPath: string, allowSensitiveData: boolean) {
    this.ndjsonLogPath = ndjsonLogPath;
    this.allowSensitiveData = allowSensitiveData;
  }

  writeInteractiveMetadata(meta: InteractiveMetadata): void {
    const [startRecord, endRecord] = buildInteractiveRecords(meta, this.sanitizeText.bind(this));
    this.appendRecord(startRecord);
    this.appendRecord(endRecord);
  }

  setIteration(iteration: number): void {
    this.currentIteration = iteration;
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
      const promptRecord = buildPromptLogRecord(
        step,
        phase,
        iteration ?? this.currentIteration,
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
  ): void {
    this.currentIteration = iteration;
    this.activeStepIterations.set(buildWorkflowStepScopeKey(step.name, workflowStack), iteration);
    const record = buildStepStartRecord(
      step,
      iteration,
      instruction,
      workflowStack,
      this.sanitizeText.bind(this),
    );
    this.appendRecord(record);
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
    this.appendRecord(buildWorkflowCompleteRecord(state));
  }

  onWorkflowAbort(state: WorkflowState, reason: string): void {
    this.appendRecord(buildWorkflowAbortRecord(state, reason, this.sanitizeText.bind(this)));
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

  private sanitizeText(text: string): string {
    return sanitizeTextForStorage(text, this.allowSensitiveData);
  }
}
