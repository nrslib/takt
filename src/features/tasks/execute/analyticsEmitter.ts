/**
 * AnalyticsEmitter — analytics イベント発行専用モジュール
 *
 * WorkflowEngine のイベントを受け取り、analytics イベントへ変換して書き出す責務を担う。
 * NDJSON ログや UI 出力は担当しない。
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  createLogger,
  getErrorMessage,
} from '../../../shared/utils/index.js';
import {
  writeAnalyticsEvent,
  parseFindingsFromReport,
  buildReviewFindingEventsFromLedger,
  extractDecisionFromReport,
  inferSeverity,
  emitFixActionEvents,
  emitRebuttalEvents,
} from '../../analytics/index.js';
import type { StepResultEvent, ReviewFindingEvent, RoutingDecisionEvent } from '../../analytics/index.js';
import type { WorkflowStep, AgentResponse, FindingLedger } from '../../../core/models/index.js';
import { formatWorkflowRuleCondition } from '../../../core/models/workflow-rule-condition.js';
import type { StepProviderInfo } from '../../../core/workflow/types.js';
import type { ProviderResolutionSource } from '../../../core/workflow/provider-options-trace.js';
import { validateRoutingReasonCodes } from '../../../core/workflow/auto-routing/contracts.js';
import { normalizeRoutingDecisionMetadata } from '../../../core/workflow/auto-routing/normalizer.js';
import { needsStatusJudgmentPhase } from '../../../core/workflow/phase-runner.js';
import { packageVersion } from '../../../shared/package-info.js';

const log = createLogger('analytics-emitter');

export class AnalyticsEmitter {
  private readonly runSlug: string;
  private readonly routingRunId: string;
  private readonly findingContractFindingIds = new Set<string>();

  constructor(
    runSlug: string,
    private readonly interactive: boolean,
    routingRunId?: string,
  ) {
    this.runSlug = runSlug;
    this.routingRunId = routingRunId ?? randomUUID();
  }

  seedFindingContractFindingIds(findingIds: readonly string[]): void {
    this.findingContractFindingIds.clear();
    for (const findingId of findingIds) {
      this.findingContractFindingIds.add(findingId);
    }
  }

  /** step:complete 時に StepResultEvent と FixAction/Rebuttal を発行する */
  onStepComplete(
    step: WorkflowStep,
    response: AgentResponse,
    attribution: {
      iteration: number;
      provider: string;
      model: string;
    },
  ): void {
    const matchedRule = response.matchedRuleIndex != null && step.rules
      ? step.rules[response.matchedRuleIndex]
      : undefined;
    const decisionTag = matchedRule === undefined
      ? response.status
      : formatWorkflowRuleCondition(matchedRule.condition);

    const stepResultEvent: StepResultEvent = {
      type: 'step_result',
      step: step.name,
      provider: attribution.provider,
      model: attribution.model,
      decisionTag,
      iteration: attribution.iteration,
      runId: this.runSlug,
      timestamp: response.timestamp.toISOString(),
    };
    writeAnalyticsEvent(stepResultEvent);

    if (step.edit === true && step.name.includes('fix')) {
      emitFixActionEvents(
        response.content,
        attribution.iteration,
        this.runSlug,
        response.timestamp,
        this.findingContractFindingIds,
      );
    }

    if (step.name.includes('no_fix')) {
      emitRebuttalEvents(
        response.content,
        attribution.iteration,
        this.runSlug,
        response.timestamp,
        this.findingContractFindingIds,
      );
    }
  }

  onRoutingDecision(
    step: WorkflowStep,
    response: AgentResponse,
    instruction: string,
    providerInfo: StepProviderInfo,
    stepType: 'normal' | 'parallel' | 'agent',
    durationMs: number,
    iteration: number,
    workflowName: string,
  ): void {
    this.emitRoutingDecisionEvent({
      step,
      response,
      instructionTokenCount: countTextTokens(instruction),
      providerInfo,
      stepType,
      durationMs,
      iteration,
      workflowName,
    });
  }

  private emitRoutingDecisionEvent(input: {
    step: WorkflowStep;
    response: AgentResponse;
    instructionTokenCount: number;
    providerInfo: StepProviderInfo | undefined;
    stepType: 'normal' | 'parallel' | 'agent';
    durationMs: number;
    iteration: number;
    workflowName: string;
  }): void {
    const decision = input.providerInfo?.autoRoutingDecision;
    if (!decision || !input.providerInfo?.provider || !input.providerInfo.model) {
      return;
    }
    if (!isConsistentAutoRoutingDecision(input.providerInfo)) {
      return;
    }
    if (!hasValidRoutingReasonCodes(decision.reasonCodes)) {
      return;
    }
    const eventMetadata = normalizeRoutingDecisionMetadata({
      stepName: input.step.name,
      stepTags: input.step.tags ?? [],
      personaKey: input.step.providerRoutingPersonaKey ?? input.step.persona ?? input.step.name,
      workflowName: input.workflowName,
      provider: input.providerInfo.provider,
      model: input.providerInfo.model,
      candidateName: decision.candidateName,
    });

    const event: RoutingDecisionEvent = {
      type: 'routing_decision',
      stepName: eventMetadata.stepName,
      stepTags: [...eventMetadata.stepTags],
      personaKey: eventMetadata.personaKey,
      workflowName: eventMetadata.workflowName,
      stepType: input.stepType,
      instructionTokenCount: input.instructionTokenCount,
      phaseCount: countExpectedPhases(input.step, this.interactive),
      provider: eventMetadata.provider,
      model: eventMetadata.model,
      selectedCategory: eventMetadata.candidateName,
      selectedRoutingTier: decision.routingTier,
      requiredRoutingTier: decision.requiredTier ?? decision.routingTier,
      ...(decision.reasonCodes !== undefined ? { reasonCodes: decision.reasonCodes } : {}),
      ...(decision.fallbackReason !== undefined ? { fallbackReason: decision.fallbackReason } : {}),
      ...(decision.fingerprintChanged !== undefined ? { fingerprintChanged: decision.fingerprintChanged } : {}),
      ...(decision.retryReason !== undefined ? { retryReason: decision.retryReason } : {}),
      ...(decision.estimatorDurationMs !== undefined ? { estimatorDurationMs: decision.estimatorDurationMs } : {}),
      ...(decision.inputTokenBucket !== undefined ? { inputTokenBucket: decision.inputTokenBucket } : {}),
      candidateCount: decision.candidateCount,
      strategy: decision.strategy,
      resolutionSource: input.providerInfo.providerSource,
      stepSuccess: input.response.status === 'done',
      durationMs: input.durationMs,
      ...(input.response.providerUsage?.inputTokens !== undefined ? { inputTokens: input.response.providerUsage.inputTokens } : {}),
      ...(input.response.providerUsage?.outputTokens !== undefined ? { outputTokens: input.response.providerUsage.outputTokens } : {}),
      taktVersion: packageVersion,
      iteration: input.iteration,
      runId: this.routingRunId,
      timestamp: input.response.timestamp.toISOString(),
    };
    writeAnalyticsEvent(event);
  }

  /** step:report 時に ReviewFindingEvent を発行する */
  onStepReport(step: WorkflowStep, filePath: string, iteration: number): void {
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
        iteration,
        runId: this.runSlug,
        timestamp: new Date().toISOString(),
      };
      writeAnalyticsEvent(event);
    }
  }

  onFindingLedgerUpdated(ledger: FindingLedger, iteration: number): void {
    try {
      this.findingContractFindingIds.clear();
      for (const finding of ledger.findings) {
        this.findingContractFindingIds.add(finding.id);
      }
      const events = buildReviewFindingEventsFromLedger(
        ledger,
        iteration,
        this.runSlug,
        new Date(ledger.updatedAt),
      );
      for (const event of events) {
        writeAnalyticsEvent(event);
      }
    } catch (error) {
      log.warn('Failed to emit finding ledger analytics events', {
        error: getErrorMessage(error),
        workflowName: ledger.workflowName,
      });
    }
  }
}

function countExpectedPhases(step: WorkflowStep, interactive: boolean): number {
  let phaseCount = 1;
  if (step.outputContracts !== undefined && step.outputContracts.length > 0) {
    phaseCount += 1;
  }
  if (needsStatusJudgmentPhase(step, interactive)) {
    phaseCount += 1;
  }
  return phaseCount;
}

type AutoRoutingProviderInfo = StepProviderInfo & {
  providerSource: Extract<ProviderResolutionSource, `auto.${string}`>;
};

function isConsistentAutoRoutingDecision(providerInfo: StepProviderInfo): providerInfo is AutoRoutingProviderInfo {
  return providerInfo.providerSource?.startsWith('auto.') === true;
}

function hasValidRoutingReasonCodes(reasonCodes: string[] | undefined): boolean {
  if (reasonCodes === undefined) {
    return true;
  }
  try {
    validateRoutingReasonCodes(reasonCodes);
    return true;
  } catch {
    return false;
  }
}

function countTextTokens(text: string | undefined): number {
  if (text === undefined || text.trim().length === 0) {
    return 0;
  }
  return text.trim().split(/\s+/).length;
}
