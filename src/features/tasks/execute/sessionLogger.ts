/**
 * Session logger — NDJSON ログ書き出し専用モジュール
 *
 * PieceEngine のイベントを受け取り、NDJSON セッションログへ追記する責務を担う。
 */

import {
  appendNdjsonLine,
  type NdjsonStepStart,
  type NdjsonStepComplete,
  type NdjsonPieceComplete,
  type NdjsonPieceAbort,
  type NdjsonPhaseStart,
  type NdjsonPhaseComplete,
  type NdjsonPhaseJudgeStage,
  type NdjsonInteractiveStart,
  type NdjsonInteractiveEnd,
} from '../../../infra/fs/index.js';
import type { InteractiveMetadata } from './types.js';
import { isDebugEnabled, writePromptLog } from '../../../shared/utils/index.js';
import type { PromptLogRecord, NdjsonRecord } from '../../../shared/utils/index.js';
import type { PieceMovement, AgentResponse, PieceState } from '../../../core/models/index.js';
import type { JudgeStageEntry, PhasePromptParts } from '../../../core/piece/types.js';
import { sanitizeTextForStorage } from './traceReportRedaction.js';

function toJudgmentMatchMethod(
  matchedRuleMethod: string | undefined,
): string | undefined {
  if (!matchedRuleMethod) return undefined;
  if (matchedRuleMethod === 'structured_output') return 'structured_output';
  if (matchedRuleMethod === 'ai_judge' || matchedRuleMethod === 'ai_judge_fallback') return 'ai_judge';
  if (matchedRuleMethod === 'phase3_tag' || matchedRuleMethod === 'phase1_tag') return 'tag_fallback';
  return undefined;
}

export class SessionLogger {
  private readonly ndjsonLogPath: string;
  private readonly allowSensitiveData: boolean;
  private readonly phasePromptsByExecutionId = new Map<string, PhasePromptParts>();
  private readonly phaseExecutionCounters = new Map<string, number>();
  private readonly ndjsonRecords: NdjsonRecord[] = [];
  private readonly promptRecords: PromptLogRecord[] = [];
  private currentIteration = 0;

  constructor(ndjsonLogPath: string, allowSensitiveData: boolean) {
    this.ndjsonLogPath = ndjsonLogPath;
    this.allowSensitiveData = allowSensitiveData;
  }

  writeInteractiveMetadata(meta: InteractiveMetadata): void {
    const startRecord: NdjsonInteractiveStart = { type: 'interactive_start', timestamp: new Date().toISOString() };
    this.appendRecord(startRecord);
    const endRecord: NdjsonInteractiveEnd = {
      type: 'interactive_end',
      confirmed: meta.confirmed,
      ...(meta.task ? { task: this.sanitizeText(meta.task) } : {}),
      timestamp: new Date().toISOString(),
    };
    this.appendRecord(endRecord);
  }

  setIteration(iteration: number): void {
    this.currentIteration = iteration;
  }

  onPhaseStart(
    step: PieceMovement,
    phase: 1 | 2 | 3,
    phaseName: 'execute' | 'report' | 'judge',
    instruction: string,
    promptParts: PhasePromptParts,
    phaseExecutionId?: string,
    iteration?: number,
  ): void {
    if (!instruction) {
      throw new Error(`Missing phase instruction for ${step.name}:${phase}`);
    }
    const resolvedPhaseExecutionId = this.resolvePhaseExecutionId(step.name, phase, phaseExecutionId, iteration);
    const record: NdjsonPhaseStart = {
      type: 'phase_start',
      step: step.name,
      phase,
      phaseName,
      phaseExecutionId: resolvedPhaseExecutionId,
      timestamp: new Date().toISOString(),
      instruction: this.sanitizeText(instruction),
      systemPrompt: this.sanitizeText(promptParts.systemPrompt),
      userInstruction: this.sanitizeText(promptParts.userInstruction),
      ...(iteration != null ? { iteration } : {}),
    };
    this.appendRecord(record);

    if (isDebugEnabled()) {
      this.phasePromptsByExecutionId.set(resolvedPhaseExecutionId, promptParts);
    }
  }

  onPhaseComplete(
    step: PieceMovement,
    phase: 1 | 2 | 3,
    phaseName: 'execute' | 'report' | 'judge',
    content: string,
    phaseStatus: string,
    phaseError: string | undefined,
    phaseExecutionId?: string,
    iteration?: number,
  ): void {
    if (!phaseStatus) {
      throw new Error(`Missing phase status for ${step.name}:${phase}`);
    }
    const resolvedPhaseExecutionId = this.resolveCompletionPhaseExecutionId(step.name, phase, phaseExecutionId, iteration);
    const completedAt = new Date().toISOString();
    const record: NdjsonPhaseComplete = {
      type: 'phase_complete',
      step: step.name,
      phase,
      phaseName,
      phaseExecutionId: resolvedPhaseExecutionId,
      status: phaseStatus,
      content: this.sanitizeText(content),
      timestamp: completedAt,
      ...(phaseError ? { error: this.sanitizeText(phaseError) } : {}),
      ...(iteration != null ? { iteration } : {}),
    };
    this.appendRecord(record);

    const prompt = this.phasePromptsByExecutionId.get(resolvedPhaseExecutionId);
    if (isDebugEnabled()) {
      if (!prompt) {
        throw new Error(`Missing debug prompt for ${step.name}:${phase}:${resolvedPhaseExecutionId}`);
      }
      const promptRecord: PromptLogRecord = {
        movement: step.name,
        phase,
        iteration: iteration ?? this.currentIteration,
        phaseExecutionId: resolvedPhaseExecutionId,
        prompt: this.sanitizeText(prompt.userInstruction),
        systemPrompt: this.sanitizeText(prompt.systemPrompt),
        userInstruction: this.sanitizeText(prompt.userInstruction),
        response: this.sanitizeText(content),
        timestamp: completedAt,
      };
      writePromptLog(promptRecord);
      this.promptRecords.push(promptRecord);
      this.phasePromptsByExecutionId.delete(resolvedPhaseExecutionId);
    }
  }

  onJudgeStage(
    step: PieceMovement,
    phase: 3,
    phaseName: 'judge',
    entry: JudgeStageEntry,
    phaseExecutionId?: string,
    iteration?: number,
  ): void {
    const resolvedPhaseExecutionId = this.resolveCompletionPhaseExecutionId(step.name, phase, phaseExecutionId, iteration);
    const record: NdjsonPhaseJudgeStage = {
      type: 'phase_judge_stage',
      step: step.name,
      phase,
      phaseName,
      phaseExecutionId: resolvedPhaseExecutionId,
      stage: entry.stage,
      method: entry.method,
      status: entry.status,
      instruction: this.sanitizeText(entry.instruction),
      response: this.sanitizeText(entry.response),
      timestamp: new Date().toISOString(),
      ...(iteration != null ? { iteration } : {}),
    };
    this.appendRecord(record);
  }

  onMovementStart(
    step: PieceMovement,
    iteration: number,
    instruction: string | undefined,
  ): void {
    this.currentIteration = iteration;
    const record: NdjsonStepStart = {
      type: 'step_start',
      step: step.name,
      persona: step.personaDisplayName,
      iteration,
      timestamp: new Date().toISOString(),
      ...(instruction ? { instruction: this.sanitizeText(instruction) } : {}),
    };
    this.appendRecord(record);
  }

  onMovementComplete(
    step: PieceMovement,
    response: AgentResponse,
    instruction: string,
  ): void {
    const matchMethod = toJudgmentMatchMethod(response.matchedRuleMethod);
    const record: NdjsonStepComplete = {
      type: 'step_complete',
      step: step.name,
      persona: response.persona,
      status: response.status,
      content: this.sanitizeText(response.content),
      instruction: this.sanitizeText(instruction),
      ...(response.matchedRuleIndex != null ? { matchedRuleIndex: response.matchedRuleIndex } : {}),
      ...(response.matchedRuleMethod ? { matchedRuleMethod: response.matchedRuleMethod } : {}),
      ...(matchMethod ? { matchMethod } : {}),
      ...(response.error ? { error: this.sanitizeText(response.error) } : {}),
      timestamp: response.timestamp.toISOString(),
    };
    this.appendRecord(record);
  }

  onPieceComplete(state: PieceState): void {
    const record: NdjsonPieceComplete = {
      type: 'piece_complete',
      iterations: state.iteration,
      endTime: new Date().toISOString(),
    };
    this.appendRecord(record);
  }

  onPieceAbort(state: PieceState, reason: string): void {
    const record: NdjsonPieceAbort = {
      type: 'piece_abort',
      iterations: state.iteration,
      reason: this.sanitizeText(reason),
      endTime: new Date().toISOString(),
    };
    this.appendRecord(record);
  }

  getNdjsonRecords(): NdjsonRecord[] {
    return [...this.ndjsonRecords];
  }

  getPromptRecords(): PromptLogRecord[] {
    return [...this.promptRecords];
  }

  private buildPhaseKey(stepName: string, phase: 1 | 2 | 3, iteration?: number): string {
    if (iteration == null) {
      return `${stepName}:${phase}`;
    }
    return `${stepName}:${iteration}:${phase}`;
  }

  private resolvePhaseExecutionId(
    stepName: string,
    phase: 1 | 2 | 3,
    phaseExecutionId: string | undefined,
    iteration?: number,
  ): string {
    if (phaseExecutionId) {
      return phaseExecutionId;
    }
    const key = this.buildPhaseKey(stepName, phase, iteration);
    const current = this.phaseExecutionCounters.get(key) ?? 0;
    const next = current + 1;
    this.phaseExecutionCounters.set(key, next);
    return `${key}:${next}`;
  }

  private resolveCompletionPhaseExecutionId(
    stepName: string,
    phase: 1 | 2 | 3,
    phaseExecutionId: string | undefined,
    iteration?: number,
  ): string {
    if (phaseExecutionId) {
      return phaseExecutionId;
    }
    const key = this.buildPhaseKey(stepName, phase, iteration);
    const current = this.phaseExecutionCounters.get(key);
    if (current == null) {
      throw new Error(`Missing phase execution id on completion for ${stepName}:${phase}`);
    }
    return `${key}:${current}`;
  }

  private appendRecord(record: NdjsonRecord): void {
    this.ndjsonRecords.push(record);
    appendNdjsonLine(this.ndjsonLogPath, record);
  }

  private sanitizeText(text: string): string {
    return sanitizeTextForStorage(text, this.allowSensitiveData);
  }
}
