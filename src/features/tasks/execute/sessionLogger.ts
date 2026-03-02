/**
 * Session logger — NDJSON ログ書き出し専用モジュール
 *
 * PieceEngine のイベントを受け取り、NDJSON セッションログへ追記する責務を担う。
 * analytics や UI 出力は担当しない。
 */

import {
  appendNdjsonLine,
  type NdjsonStepStart,
  type NdjsonStepComplete,
  type NdjsonPieceComplete,
  type NdjsonPieceAbort,
  type NdjsonPhaseStart,
  type NdjsonPhaseComplete,
  type NdjsonInteractiveStart,
  type NdjsonInteractiveEnd,
} from '../../../infra/fs/index.js';
import type { InteractiveMetadata } from './types.js';
import { isDebugEnabled, writePromptLog } from '../../../shared/utils/index.js';
import type { PromptLogRecord } from '../../../shared/utils/index.js';
import type { PieceMovement, AgentResponse, PieceState } from '../../../core/models/index.js';
import type { PhaseName } from '../../../core/piece/index.js';

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
  /** phase 開始時のプロンプトを一時保持（デバッグ用） */
  private readonly phasePrompts = new Map<string, string>();
  /** 現在のピース全体のイテレーション数 */
  private currentIteration = 0;

  constructor(ndjsonLogPath: string) {
    this.ndjsonLogPath = ndjsonLogPath;
  }

  /** インタラクティブモードのメタデータ（interactive_start / interactive_end）を NDJSON へ記録する */
  writeInteractiveMetadata(meta: InteractiveMetadata): void {
    const startRecord: NdjsonInteractiveStart = { type: 'interactive_start', timestamp: new Date().toISOString() };
    appendNdjsonLine(this.ndjsonLogPath, startRecord);
    const endRecord: NdjsonInteractiveEnd = {
      type: 'interactive_end',
      confirmed: meta.confirmed,
      ...(meta.task ? { task: meta.task } : {}),
      timestamp: new Date().toISOString(),
    };
    appendNdjsonLine(this.ndjsonLogPath, endRecord);
  }

  /** 現在のイテレーション番号を更新する（movement:start で呼ぶ） */
  setIteration(iteration: number): void {
    this.currentIteration = iteration;
  }

  onPhaseStart(
    step: PieceMovement,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    instruction: string,
  ): void {
    const record: NdjsonPhaseStart = {
      type: 'phase_start',
      step: step.name,
      phase,
      phaseName,
      timestamp: new Date().toISOString(),
      ...(instruction ? { instruction } : {}),
    };
    appendNdjsonLine(this.ndjsonLogPath, record);

    if (isDebugEnabled()) {
      this.phasePrompts.set(`${step.name}:${phase}`, instruction);
    }
  }

  onPhaseComplete(
    step: PieceMovement,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    content: string,
    phaseStatus: string,
    phaseError: string | undefined,
  ): void {
    const record: NdjsonPhaseComplete = {
      type: 'phase_complete',
      step: step.name,
      phase,
      phaseName,
      status: phaseStatus,
      content,
      timestamp: new Date().toISOString(),
      ...(phaseError ? { error: phaseError } : {}),
    };
    appendNdjsonLine(this.ndjsonLogPath, record);

    const promptKey = `${step.name}:${phase}`;
    const prompt = this.phasePrompts.get(promptKey);
    this.phasePrompts.delete(promptKey);

    if (isDebugEnabled() && prompt) {
      const promptRecord: PromptLogRecord = {
        movement: step.name,
        phase,
        iteration: this.currentIteration,
        prompt,
        response: content,
        timestamp: new Date().toISOString(),
      };
      writePromptLog(promptRecord);
    }
  }

  onMovementStart(
    step: PieceMovement,
    iteration: number,
    instruction: string | undefined,
  ): void {
    const record: NdjsonStepStart = {
      type: 'step_start',
      step: step.name,
      persona: step.personaDisplayName,
      iteration,
      timestamp: new Date().toISOString(),
      ...(instruction ? { instruction } : {}),
    };
    appendNdjsonLine(this.ndjsonLogPath, record);
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
      content: response.content,
      instruction,
      ...(response.matchedRuleIndex != null ? { matchedRuleIndex: response.matchedRuleIndex } : {}),
      ...(response.matchedRuleMethod ? { matchedRuleMethod: response.matchedRuleMethod } : {}),
      ...(matchMethod ? { matchMethod } : {}),
      ...(response.error ? { error: response.error } : {}),
      timestamp: response.timestamp.toISOString(),
    };
    appendNdjsonLine(this.ndjsonLogPath, record);
  }

  onPieceComplete(state: PieceState): void {
    const record: NdjsonPieceComplete = {
      type: 'piece_complete',
      iterations: state.iteration,
      endTime: new Date().toISOString(),
    };
    appendNdjsonLine(this.ndjsonLogPath, record);
  }

  onPieceAbort(state: PieceState, reason: string): void {
    const record: NdjsonPieceAbort = {
      type: 'piece_abort',
      iterations: state.iteration,
      reason,
      endTime: new Date().toISOString(),
    };
    appendNdjsonLine(this.ndjsonLogPath, record);
  }
}
