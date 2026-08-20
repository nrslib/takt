import type { RunAgentOptions } from '../../../agents/types.js';
import type { StreamEvent } from '../../../shared/types/provider.js';
import { createLogger } from '../../../shared/utils/index.js';
import { safeExternalErrorMessage } from '../../../shared/utils/safeExternalErrorMessage.js';
import { truncateUtf8 } from '../../../shared/utils/utf8.js';
import type { ProviderRoutingEntry } from '../../models/config-types.js';
import type {
  AgentResponse,
  CompanionFinding,
  NormalAgentWorkflowStep,
  ResolvedCompanionDefinition,
  TeamLeaderWorkflowStep,
  WorkflowState,
} from '../../models/index.js';
import { createSelectorContract, validateSelectorResponse } from '../selector-contract.js';
import type { CompanionReviewPhase, SelectorProviderInfo } from '../types.js';
import { createAbortError } from './abort.js';
import {
  CompanionChangeDetector,
  type CompanionChangeSkipReason,
} from './change-detector.js';
import { CompanionCompletionCoordinator } from './completion-coordinator.js';
import type { CompanionDiff, CompanionDiffReader } from './diff-reader.js';
import {
  CompanionEventPublisher,
  type CompanionEventEmitter,
} from './event-publisher.js';
import type { CompanionFollowUpContext } from './fix-loop.js';
import { buildCompanionMailboxPath } from './mailbox.js';
import { CompanionReviewQueue, type CompanionReviewRequest } from './review-queue.js';
import type { CompanionCallAudit } from './review-runner.js';
import {
  executeCompanionReviewRound,
  type CompanionReviewRoundAudit,
} from './review-round.js';
import {
  sanitizeCompanionSelectorRationale,
  selectActiveCompanions,
} from './selection.js';
import {
  CompanionStructuredCaller,
  type CompanionProviderCallCallbacksBuilder,
} from './structured-call.js';
import { CompanionTriggerScheduler } from './trigger-scheduler.js';

const MINIMUM_CHANGED_LINES = 10;
const ROUND_CONTEXT_MAX_BYTES = 4 * 1024;
const log = createLogger('companion-step-runtime');

interface CompanionStepRuntimeDeps {
  readonly cwd: string;
  readonly projectCwd: string;
  readonly failureDir: string;
  readonly runSlug: string;
  readonly runPathNamespace: readonly string[];
  readonly language: 'en' | 'ja';
  readonly task: string;
  readonly step: NormalAgentWorkflowStep | TeamLeaderWorkflowStep;
  readonly definitions: Readonly<Record<string, ResolvedCompanionDefinition>>;
  readonly providers: Readonly<Record<string, ProviderRoutingEntry>>;
  readonly selectorProvider?: SelectorProviderInfo;
  readonly diffReader: CompanionDiffReader;
  readonly abortSignal?: AbortSignal;
  readonly buildProviderCallCallbacks: CompanionProviderCallCallbacksBuilder;
  readonly emitEvent: CompanionEventEmitter;
  readonly recordUsage: (
    name: string,
    provider: ProviderRoutingEntry,
    success: boolean,
    usage: AgentResponse['providerUsage'],
  ) => void;
}

export class CompanionStepRuntime {
  private readonly detectors = new Map<string, CompanionChangeDetector>();
  private readonly active = new Map<string, ResolvedCompanionDefinition>();
  private readonly queue: CompanionReviewQueue;
  private readonly events: CompanionEventPublisher;
  private readonly structuredCaller: CompanionStructuredCaller;
  private readonly undeliveredFindings: CompanionFinding[] = [];
  private scheduler: CompanionTriggerScheduler | undefined;
  private completionCoordinator: CompanionCompletionCoordinator | undefined;
  private baselineSha = '';
  private currentFollowUpRound = 0;
  private stopped = false;
  private latestImplementerExplanation: string | undefined;
  private readonly emittedReviewSkipGenerations = new Map<string, number>();
  private companionAuditWriteFailureReported = false;

  private constructor(private readonly deps: CompanionStepRuntimeDeps) {
    this.events = new CompanionEventPublisher(
      deps.step.name,
      deps.emitEvent,
      deps.runPathNamespace,
    );
    this.structuredCaller = new CompanionStructuredCaller({
      cwd: deps.cwd,
      projectCwd: deps.projectCwd,
      failureDir: deps.failureDir,
      language: deps.language,
      abortSignal: deps.abortSignal,
      buildProviderCallCallbacks: deps.buildProviderCallCallbacks,
      recordUsage: deps.recordUsage,
      recordCall: (call: CompanionCallAudit) => {
        this.events.call({
          agent: call.agentName,
          purpose: call.purpose,
          attempt: call.attempt,
          status: call.status,
          provider: call.provider,
          ...(call.model === undefined ? {} : { model: call.model }),
          ...(call.promptResolved ? {
            promptResolved: true,
            systemPrompt: call.systemPrompt,
            prompt: call.prompt,
          } : { promptResolved: false }),
          ...(call.response === undefined ? {} : { response: call.response }),
          ...(call.error === undefined ? {} : { error: call.error }),
        });
      },
      onCallAuditPersistenceFailure: ({ purpose, agentName, attempt, error }) => {
        this.reportCompanionAuditWriteFailure('companion_call', error, {
          purpose,
          agent: agentName,
          attempt,
        });
      },
    });
    this.queue = new CompanionReviewQueue({
      runReview: async (request) => this.runReview(request),
      refreshRetryRequest: async (request, signal) => {
        const detector = this.requireDetector(request.companionName);
        return {
          ...request,
          snapshot: await this.readSnapshot(signal),
          observedGeneration: detector.getObservedGeneration(),
        };
      },
      onCoalesced: (event) => this.events.queueCoalesced({
        companion: event.companionName,
        replaced: event.replaced,
        replacement: event.replacement,
      }),
    });
  }

  static async create(deps: CompanionStepRuntimeDeps): Promise<CompanionStepRuntime> {
    const runtime = new CompanionStepRuntime(deps);
    try {
      await runtime.initialize();
      deps.abortSignal?.throwIfAborted();
      deps.abortSignal?.addEventListener('abort', runtime.stop, { once: true });
      return runtime;
    } catch (error) {
      runtime.stop();
      throw error;
    }
  }

  observe(event: StreamEvent): void {
    this.scheduler?.observe(event);
  }

  composeOptions(options: RunAgentOptions): RunAgentOptions {
    const existing = options.onStream;
    return {
      ...options,
      onStream: (event) => {
        existing?.(event);
        this.observe(event);
      },
    };
  }

  async complete(
    state: WorkflowState,
    implementerResponse: string,
    context: CompanionFollowUpContext,
  ): Promise<{ readonly findings: readonly CompanionFinding[] }> {
    const explanation = truncateUtf8(implementerResponse, ROUND_CONTEXT_MAX_BYTES).value.trim();
    this.latestImplementerExplanation = explanation.length === 0 ? undefined : explanation;
    this.scheduler?.beginCompletion();

    const completion = this.completionCoordinator === undefined
      ? { completionSettled: true, completionFailure: false }
      : await this.completionCoordinator.complete();
    const findings = this.takeUndeliveredFindings();
    const completionSettled = completion.completionSettled && findings.length === 0;
    state.companion = {
      completionSettled,
      followUpRounds: context.followUpRound,
      ...(completion.completionFailure ? { completionFailure: true } : {}),
      ...(completion.reason === undefined ? {} : { reason: completion.reason }),
    };
    if (findings.length === 0) {
      this.events.complete({
        completionSettled,
        completionFailure: completion.completionFailure,
        followUpRounds: context.followUpRound,
        ...(completion.reason === undefined ? {} : { reason: completion.reason }),
      });
    }
    return { findings };
  }

  completeFollowUpFailure(
    state: WorkflowState,
    followUpRounds: number,
    reason: string,
  ): void {
    const sanitizedReason = safeExternalErrorMessage(reason);
    const completion = {
      completionSettled: false,
      completionFailure: true,
      followUpRounds,
      reason: sanitizedReason,
    } as const;
    state.companion = completion;
    try {
      this.events.complete(completion);
    } catch (error) {
      this.reportCompanionAuditWriteFailure('companion_complete', error);
    }
  }

  beginReviewAttempt(): void {
    this.currentFollowUpRound = 0;
    this.latestImplementerExplanation = undefined;
    this.events.beginAttempt();
    this.scheduler?.start();
  }

  beginFollowUpRound(sequence: number, findingCount: number): void {
    this.currentFollowUpRound = sequence - 1;
    this.events.fixRound(sequence, findingCount);
    this.scheduler?.start();
  }

  stop = (): void => {
    if (this.stopped) return;
    this.stopped = true;
    this.scheduler?.stop();
    this.queue.stop(this.deps.abortSignal?.reason);
    this.deps.abortSignal?.removeEventListener('abort', this.stop);
  };

  [Symbol.dispose](): void {
    this.stop();
  }

  private async initialize(): Promise<void> {
    const definitions = new Map(Object.entries(this.deps.definitions));
    const moderatorName = this.deps.step.companion?.moderator;
    if (moderatorName !== undefined) {
      if (!definitions.has(moderatorName)) throw new Error(`Undefined companion "${moderatorName}"`);
      this.requireProvider(moderatorName);
    }
    const selected = await selectActiveCompanions({
      selection: this.deps.step.companion!,
      definitions,
      task: this.deps.task,
      stepContext: {
        name: this.deps.step.name,
        instruction: this.deps.step.instruction ?? '',
      },
      runSelector: async (request) => this.runSelector(request),
    });
    if (selected.length === 0) {
      this.emitReviewSkipped({ phase: 'initial', reason: 'selector_empty' });
      return;
    }

    const resolved = selected.map((item) => {
      const definition = definitions.get(item.name);
      if (definition === undefined) throw new Error(`Undefined companion "${item.name}"`);
      this.requireProvider(item.name);
      return { name: item.name, definition };
    });
    this.baselineSha = await this.deps.diffReader.readBaselineSha(
      this.deps.cwd,
      this.deps.abortSignal,
    );
    const initialSnapshot = await this.readSnapshot(this.deps.abortSignal);
    for (const { name, definition } of resolved) {
      this.active.set(name, definition);
      this.detectors.set(name, new CompanionChangeDetector({
        intervalMs: definition.intervalMs,
        minimumChangedLines: MINIMUM_CHANGED_LINES,
        now: Date.now,
        readDiff: async () => this.readSnapshot(this.deps.abortSignal),
      }));
      this.events.start(name);
    }
    this.scheduler = new CompanionTriggerScheduler({
      detectors: this.detectors,
      intervals: [...this.active.values()].map(({ intervalMs }) => intervalMs),
      allowGitCommit: this.deps.step.allowGitCommit === true,
      queue: this.queue,
      initialSnapshot,
      readSnapshot: () => this.readSnapshot(this.deps.abortSignal),
      isAborted: () => this.deps.abortSignal?.aborted === true,
      onError: () => log.warn('Companion live review failed; the change remains unreviewed', {
        step: this.deps.step.name,
      }),
      onSkipped: ({ companionName, reason, candidate }) => this.emitReviewSkipped({
        companion: companionName,
        phase: this.currentFollowUpRound === 0 ? 'live' : 'fix',
        reason,
        ...(this.currentFollowUpRound === 0 ? {} : { fixRound: this.currentFollowUpRound }),
        observedGeneration: candidate.observedGeneration,
      }),
    });
    this.completionCoordinator = new CompanionCompletionCoordinator({
      activeNames: () => [...this.active.keys()],
      detectors: this.detectors,
      queue: this.queue,
      readSnapshot: () => this.readSnapshot(this.deps.abortSignal),
      synchronizeSnapshot: (snapshot) => this.scheduler?.synchronizeSnapshot(snapshot),
      abortSignal: this.deps.abortSignal,
      onError: (error) => log.warn('Companion completion review failed', {
        step: this.deps.step.name,
        error: safeExternalErrorMessage(error),
      }),
      onSkipped: ({ companionName, reason, candidate }) => this.emitReviewSkipped({
        companion: companionName,
        phase: 'completion',
        reason,
        ...(this.currentFollowUpRound === 0 ? {} : { fixRound: this.currentFollowUpRound }),
        observedGeneration: candidate.observedGeneration,
      }),
    });
    this.scheduler.start();
  }

  private async runSelector(request: {
    task: string;
    step: { name: string; instruction: string };
    candidates: Array<{ name: string; description: string }>;
    maxSelected: number;
  }): Promise<{ selectedIds: string[]; rationale: string }> {
    if (request.candidates.length === 0) return { selectedIds: [], rationale: 'No candidates' };
    const provider = this.deps.selectorProvider;
    if (provider === undefined) throw new Error('Companion pool selector has no resolved provider');
    const selectorContract = createSelectorContract(request.candidates, request.maxSelected);
    const redact = (text: string): string => sanitizeCompanionSelectorRationale(text, request);
    const validateSelection = (response: AgentResponse) => validateSelectorResponse(
      response,
      selectorContract.validationSchema,
      this.deps.step.name,
      redact,
      { label: 'Companion' },
    );
    const response = await this.structuredCaller.call({
      purpose: 'selector',
      agentName: 'companion-selector',
      provider,
      systemPrompt: 'Select companion reviewer IDs relevant to this task. Do not select more than maxSelected.',
      prompt: JSON.stringify(request),
      outputSchema: selectorContract.providerSchema,
      validateResponse: validateSelection,
    });
    const selected = validateSelection(response);
    const rationale = sanitizeCompanionSelectorRationale(selected.rationale, request);
    this.events.poolSelected(selected.selectedIds, rationale);
    return { selectedIds: [...selected.selectedIds], rationale };
  }

  private async runReview(
    request: CompanionReviewRequest & { signal: AbortSignal },
  ): Promise<void> {
    const { companionName, snapshot: diff, observedGeneration, signal } = request;
    if (!this.active.has(companionName)) throw new Error(`Inactive companion "${companionName}"`);
    const detector = this.requireDetector(companionName);
    const result = await executeCompanionReviewRound({
      companionName,
      diff,
      baselineSha: this.baselineSha,
      trigger: request.reason,
      observedGeneration,
      implementerExplanation: this.latestImplementerExplanation,
      signal,
      task: this.deps.task,
      stepName: this.deps.step.name,
      moderatorName: this.deps.step.companion?.moderator,
      mailboxPath: this.mailboxPath(companionName),
      systemPrompt: (name) => this.definitionSystemPrompt(name),
      callStructured: async (
        purpose,
        agentName,
        systemPrompt,
        prompt,
        schema,
        reviewSignal,
        validateResponse,
      ) => this.structuredCaller.call({
        purpose,
        agentName,
        provider: this.requireProvider(agentName),
        systemPrompt,
        prompt,
        outputSchema: schema,
        abortSignal: reviewSignal,
        validateResponse,
      }),
      emitFinding: (finding) => this.emitFinding(finding),
      markReviewed: (snapshot, generation) => detector.markReviewed(snapshot, generation),
      onRoundCompleted: (round) => this.emitReviewRound(companionName, round),
    });
    this.undeliveredFindings.push(...result.acceptedRows);
  }

  private emitFinding(finding: CompanionFinding): void {
    try {
      this.events.finding(finding);
    } catch (error) {
      this.reportCompanionAuditWriteFailure('companion_finding', error, {
        companion: finding.companion,
      });
    }
  }

  private emitReviewRound(
    companionName: string,
    round: CompanionReviewRoundAudit,
  ): void {
    try {
      this.events.reviewRound({
        companion: companionName,
        trigger: round.trigger,
        digest: round.snapshot.digest,
        changedLines: round.snapshot.changedLines,
        findingCount: round.acceptedRows.length,
        reviewerFindings: round.reviewerResult.findings,
        moderator: {
          name: round.moderator.name,
          invoked: round.moderator.invoked,
          ...(round.moderator.reason === undefined ? {} : { reason: round.moderator.reason }),
          decisions: round.moderator.result?.findings ?? [],
        },
        acceptedFindings: round.accepted.findings,
        ...(round.reviewerResult.findings.length === 0
          ? { zeroReason: 'reviewer_returned_no_findings' as const }
          : round.accepted.findings.length === 0
            ? { zeroReason: 'moderator_rejected_all_findings' as const }
            : {}),
      });
    } catch (error) {
      this.reportCompanionAuditWriteFailure('companion_review_round', error, {
        companion: companionName,
      });
    }
  }

  private takeUndeliveredFindings(): CompanionFinding[] {
    return this.undeliveredFindings.splice(0);
  }

  private definitionSystemPrompt(name: string): string {
    const definition = this.deps.definitions[name];
    if (definition === undefined) throw new Error(`Undefined companion "${name}"`);
    return [
      definition.personaContent,
      ...(definition.policyContents ?? []),
      ...(definition.knowledgeContents ?? []),
      definition.instruction,
    ].filter((content): content is string => content !== undefined).join('\n\n');
  }

  private async readSnapshot(signal: AbortSignal | undefined): Promise<CompanionDiff> {
    const result = await this.deps.diffReader.readDiff(this.deps.cwd, this.baselineSha, signal);
    if (result.status === 'ok') return result.snapshot;
    if (result.failure.code === 'aborted') throw createAbortError();
    throw new Error(
      `Companion diff unavailable (${result.failure.code}): ${safeExternalErrorMessage(result.failure.message)}`,
    );
  }

  private requireProvider(name: string): ProviderRoutingEntry {
    const provider = this.deps.providers[name];
    if (provider === undefined) throw new Error(`Companion "${name}" has no resolved provider`);
    return provider;
  }

  private requireDetector(name: string): CompanionChangeDetector {
    const detector = this.detectors.get(name);
    if (detector === undefined) throw new Error(`Missing detector for companion "${name}"`);
    return detector;
  }

  private mailboxPath(name: string): string {
    return buildCompanionMailboxPath({
      cwd: this.deps.cwd,
      runSlug: this.deps.runSlug,
      runPathNamespace: this.deps.runPathNamespace,
      stepName: this.deps.step.name,
      companionName: name,
    });
  }

  private emitReviewSkipped(input: {
    readonly companion?: string;
    readonly phase: CompanionReviewPhase;
    readonly reason: CompanionChangeSkipReason | 'selector_empty';
    readonly fixRound?: number;
    readonly observedGeneration?: number;
  }): void {
    if (this.stopped) return;
    if (input.companion !== undefined && input.observedGeneration !== undefined) {
      if (this.emittedReviewSkipGenerations.get(input.companion) === input.observedGeneration) return;
      this.emittedReviewSkipGenerations.set(input.companion, input.observedGeneration);
    }
    try {
      this.events.reviewSkipped({
        ...(input.companion === undefined ? {} : { companion: input.companion }),
        phase: input.phase,
        reason: input.reason,
        ...(input.fixRound === undefined ? {} : { fixRound: input.fixRound }),
        ...(input.observedGeneration === undefined
          ? {}
          : { observedGeneration: input.observedGeneration }),
      });
    } catch (error) {
      this.reportCompanionAuditWriteFailure('companion_review_skipped', error);
    }
  }

  private reportCompanionAuditWriteFailure(
    recordType:
      | 'companion_call'
      | 'companion_complete'
      | 'companion_finding'
      | 'companion_review_round'
      | 'companion_review_skipped',
    error: unknown,
    context: Record<string, unknown> = {},
  ): void {
    if (this.companionAuditWriteFailureReported) return;
    this.companionAuditWriteFailureReported = true;
    log.warn('Companion audit record could not be persisted; continuing workflow', {
      step: this.deps.step.name,
      recordType,
      ...context,
      error: safeExternalErrorMessage(error),
    });
  }
}
