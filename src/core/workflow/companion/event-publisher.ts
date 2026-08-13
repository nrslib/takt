import type {
  CompanionQueueAuditEntry,
  CompanionCallPurpose,
  CompanionCallStatus,
  CompanionModeratorAudit,
  CompanionAcceptedFindingAudit,
  CompanionAcceptedUpdateAudit,
  CompanionReviewTrigger,
  CompanionReviewPhase,
  CompanionReviewSkipReason,
  CompanionReviewZeroReason,
  WorkflowEvents,
} from '../types.js';
import type { AgentResponse } from '../../models/index.js';
import type { ProviderType } from '../../../shared/types/provider.js';

type CompanionEventName = Extract<keyof WorkflowEvents, `companion:${string}`>;
type CompanionEventArguments<TEvent extends CompanionEventName> = Parameters<WorkflowEvents[TEvent]>;
export type CompanionEventEmitter = <TEvent extends CompanionEventName>(
  event: TEvent,
  ...args: CompanionEventArguments<TEvent>
) => void;

export class CompanionEventPublisher {
  private completed = false;

  constructor(
    private readonly step: string,
    private readonly emit: CompanionEventEmitter,
    private readonly runPathNamespace: readonly string[] = [],
  ) {}

  start(companion: string): void {
    this.emit('companion:start', { step: this.step, companion });
  }

  poolSelected(selected: readonly string[], rationale: string): void {
    this.emit('companion:pool_selected', {
      step: this.step,
      selected: [...selected],
      rationale,
    });
  }

  finding(companion: string, findingId: string, severity: 'must_fix' | 'should_fix' | 'nit'): void {
    this.emit('companion:finding', {
      step: this.step,
      companion,
      findingId,
      severity,
    });
  }

  fixRound(sequence: number, openMustFixCount: number): void {
    this.emit('companion:fix_round', { step: this.step, sequence, openMustFixCount });
  }

  complete(openMustFixCount: number, escalated: boolean): void {
    if (this.completed) throw new Error(`Companion completion already published for "${this.step}"`);
    this.completed = true;
    this.emit('companion:complete', { step: this.step, openMustFixCount, escalated });
  }

  beginAttempt(): void {
    this.completed = false;
  }

  reviewRound(input: {
    companion: string;
    trigger: CompanionReviewTrigger;
    digest: string;
    changedLines: number;
    findingCount: number;
    reviewerFindings: readonly CompanionAcceptedFindingAudit[];
    reviewerUpdates: readonly CompanionAcceptedUpdateAudit[];
    moderator?: CompanionModeratorAudit;
    acceptedFindings: readonly CompanionAcceptedFindingAudit[];
    acceptedUpdates: readonly CompanionAcceptedUpdateAudit[];
    zeroReason?: CompanionReviewZeroReason;
  }): void {
    this.emit('companion:review_round', {
      step: this.step,
      ...input,
      ...this.scopePayload(),
    });
  }

  queueCoalesced(input: {
    companion: string;
    replaced: CompanionQueueAuditEntry;
    replacement: CompanionQueueAuditEntry;
  }): void {
    this.emit('companion:queue_coalesced', {
      step: this.step,
      ...input,
      ...this.scopePayload(),
    });
  }

  call(input: {
    agent: string;
    purpose: CompanionCallPurpose;
    attempt: number;
    status: CompanionCallStatus;
    provider: ProviderType;
    model?: string;
    systemPrompt?: string;
    prompt?: string;
    promptResolved: boolean;
    response?: AgentResponse;
    error?: string;
  }): void {
    this.emit('companion:call', { step: this.step, ...input, ...this.scopePayload() });
  }

  reviewSkipped(input: {
    companion?: string;
    phase: CompanionReviewPhase;
    reason: CompanionReviewSkipReason;
    fixRound?: number;
    observedGeneration?: number;
  }): void {
    this.emit('companion:review_skipped', { step: this.step, ...input, ...this.scopePayload() });
  }

  private scopePayload(): { runPathNamespace?: string[] } {
    return this.runPathNamespace.length === 0
      ? {}
      : { runPathNamespace: [...this.runPathNamespace] };
  }
}
