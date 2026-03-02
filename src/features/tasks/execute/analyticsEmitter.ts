/**
 * AnalyticsEmitter — analytics イベント発行専用モジュール
 *
 * PieceEngine のイベントを受け取り、analytics イベントへ変換して書き出す責務を担う。
 * NDJSON ログや UI 出力は担当しない。
 */

import { readFileSync } from 'node:fs';
import {
  writeAnalyticsEvent,
  parseFindingsFromReport,
  extractDecisionFromReport,
  inferSeverity,
  emitFixActionEvents,
  emitRebuttalEvents,
} from '../../analytics/index.js';
import type { MovementResultEvent, ReviewFindingEvent } from '../../analytics/index.js';
import type { PieceMovement, AgentResponse } from '../../../core/models/index.js';

export class AnalyticsEmitter {
  private readonly runSlug: string;
  private currentIteration = 0;
  private currentProvider: string;
  private currentModel: string;

  constructor(runSlug: string, initialProvider: string, initialModel: string) {
    this.runSlug = runSlug;
    this.currentProvider = initialProvider;
    this.currentModel = initialModel;
  }

  /** movement:start 時にプロバイダ/モデル情報を更新する */
  updateProviderInfo(iteration: number, provider: string, model: string): void {
    this.currentIteration = iteration;
    this.currentProvider = provider;
    this.currentModel = model;
  }

  /** movement:complete 時に MovementResultEvent と FixAction/Rebuttal を発行する */
  onMovementComplete(step: PieceMovement, response: AgentResponse): void {
    const decisionTag = (response.matchedRuleIndex != null && step.rules)
      ? (step.rules[response.matchedRuleIndex]?.condition ?? response.status)
      : response.status;

    const movementResultEvent: MovementResultEvent = {
      type: 'movement_result',
      movement: step.name,
      provider: this.currentProvider,
      model: this.currentModel,
      decisionTag,
      iteration: this.currentIteration,
      runId: this.runSlug,
      timestamp: response.timestamp.toISOString(),
    };
    writeAnalyticsEvent(movementResultEvent);

    if (step.edit === true && step.name.includes('fix')) {
      emitFixActionEvents(response.content, this.currentIteration, this.runSlug, response.timestamp);
    }

    if (step.name.includes('no_fix')) {
      emitRebuttalEvents(response.content, this.currentIteration, this.runSlug, response.timestamp);
    }
  }

  /** movement:report 時に ReviewFindingEvent を発行する */
  onMovementReport(step: PieceMovement, filePath: string): void {
    if (step.edit !== false) return;

    const content = readFileSync(filePath, 'utf-8');
    const decision = extractDecisionFromReport(content);
    if (!decision) return;

    const findings = parseFindingsFromReport(content);
    for (const finding of findings) {
      const event: ReviewFindingEvent = {
        type: 'review_finding',
        findingId: finding.findingId,
        status: finding.status,
        ruleId: finding.ruleId,
        severity: inferSeverity(finding.findingId),
        decision,
        file: finding.file,
        line: finding.line,
        iteration: this.currentIteration,
        runId: this.runSlug,
        timestamp: new Date().toISOString(),
      };
      writeAnalyticsEvent(event);
    }
  }
}
