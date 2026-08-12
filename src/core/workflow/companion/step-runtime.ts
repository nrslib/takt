import type { RunAgentOptions } from '../../../agents/types.js';
import type { ProviderRoutingEntry } from '../../models/config-types.js';
import type {
  AgentResponse,
  CompanionFindingEvidence,
  NormalAgentWorkflowStep,
  ResolvedCompanionDefinition,
  WorkflowState,
} from '../../models/index.js';
import { truncateUtf8 } from '../../../shared/utils/utf8.js';
import type { StreamEvent } from '../../../shared/types/provider.js';
import type { SelectorProviderInfo } from '../types.js';
import { createLogger } from '../../../shared/utils/index.js';
import { CompanionChangeDetector } from './change-detector.js';
import {
  LOOP_JUDGE_OUTPUT_JSON_SCHEMA,
  parseLoopJudgeOutput,
} from './contracts.js';
import { CompanionReviewQueue, type CompanionReviewRequest } from './review-queue.js';
import {
  sanitizeCompanionSelectorRationale,
  selectActiveCompanions,
} from './selection.js';
import type { CompanionDiff, CompanionDiffReader } from './diff-reader.js';
import { buildCompanionMailboxPath } from './mailbox.js';
import { CompanionReviewStateStore } from './review-state-store.js';
import {
  buildCompanionLoopJudgePrompt,
  evaluateCompanionLoop,
  type CompanionLoopRound,
} from './loop-guard.js';
import { createAbortError } from './abort.js';
import { isCompanionCapacityError } from './limits.js';
import { executeCompanionReviewRound } from './review-round.js';
import type { CompanionFixReviewContext } from './fix-loop.js';
import {
  CompanionEventPublisher,
  type CompanionEventEmitter,
} from './event-publisher.js';
import { CompanionStructuredCaller } from './structured-call.js';
import { CompanionTriggerScheduler } from './trigger-scheduler.js';
import { CompanionCompletionCoordinator } from './completion-coordinator.js';
import { CompanionTerminalDecisionTracker } from './terminal-decision.js';
import { createSelectorContract, validateSelectorResponse } from '../selector-contract.js';
import { toCompanionFindingEvidence } from './evidence.js';
import { safeExternalErrorMessage } from '../../../shared/utils/safeExternalErrorMessage.js';

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
  readonly step: NormalAgentWorkflowStep;
  readonly definitions: Readonly<Record<string, ResolvedCompanionDefinition>>;
  readonly providers: Readonly<Record<string, ProviderRoutingEntry>>;
  readonly selectorProvider?: SelectorProviderInfo;
  readonly diffReader: CompanionDiffReader;
  readonly abortSignal?: AbortSignal;
  readonly stateStore: CompanionReviewStateStore;
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
  private readonly terminalDecision = new CompanionTerminalDecisionTracker();
  private scheduler: CompanionTriggerScheduler | undefined;
  private completionCoordinator: CompanionCompletionCoordinator | undefined;
  private baselineSha = '';
  private currentFixRound: number | undefined;
  private stopped = false;
  private latestImplementerExplanation: string | undefined;

  private constructor(private readonly deps: CompanionStepRuntimeDeps) {
    this.events = new CompanionEventPublisher(deps.step.name, deps.emitEvent);
    this.structuredCaller = new CompanionStructuredCaller({
      cwd: deps.cwd,
      projectCwd: deps.projectCwd,
      failureDir: deps.failureDir,
      language: deps.language,
      abortSignal: deps.abortSignal,
      recordUsage: deps.recordUsage,
    });
    this.queue = new CompanionReviewQueue({
      runReview: async (request) => {
        await this.runReview(request);
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
    this.requireScheduler().observe(event);
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
    context: CompanionFixReviewContext,
  ): Promise<{
    openMustFix: CompanionFindingEvidence[];
    escalated: boolean;
    reason?: string;
  }> {
    const explanation = truncateUtf8(
      implementerResponse,
      ROUND_CONTEXT_MAX_BYTES,
    ).value.trim();
    this.latestImplementerExplanation = explanation.length === 0 ? undefined : explanation;
    this.requireScheduler().beginCompletion();
    return this.requireCompletionCoordinator().complete(state, {
      allowUnchangedDigest: (companionName) => (
        context.afterFix
        && context.fixRound === this.currentFixRound
        && this.latestImplementerExplanation !== undefined
        && this.hasOpenMustFix(companionName)
      ),
    });
  }

  beginFixRound(sequence: number, openMustFixCount: number): void {
    this.currentFixRound = sequence - 1;
    this.events.fixRound(sequence, openMustFixCount);
    this.requireScheduler().start();
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
    this.baselineSha = await this.deps.diffReader.readBaselineSha(
      this.deps.cwd,
      this.deps.abortSignal,
    );
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
    const resolved = selected.map((item) => {
      const definition = definitions.get(item.name);
      if (definition === undefined) throw new Error(`Undefined companion "${item.name}"`);
      this.requireProvider(item.name);
      return { name: item.name, definition };
    });
    const initialSnapshot = await this.readSnapshot();
    for (const { name, definition } of resolved) {
      this.active.set(name, definition);
      try {
        this.deps.stateStore.get(this.mailboxPath(name), name);
      } catch (error) {
        if (!isCompanionCapacityError(error)) throw error;
        this.recordCapacityExceeded(name);
      }
      this.detectors.set(name, new CompanionChangeDetector({
        intervalMs: definition.intervalMs,
        minimumChangedLines: MINIMUM_CHANGED_LINES,
        now: Date.now,
        readDiff: async () => this.readSnapshot(),
      }));
      this.events.start(name);
    }
    this.scheduler = new CompanionTriggerScheduler({
      detectors: this.detectors,
      intervals: [...this.active.values()].map(({ intervalMs }) => intervalMs),
      allowGitCommit: this.deps.step.allowGitCommit === true,
      queue: this.queue,
      initialSnapshot,
      readSnapshot: () => this.readSnapshot(),
      isAborted: () => this.deps.abortSignal?.aborted === true,
      onError: () => log.warn('Companion live review failed; the change remains unreviewed', {
        step: this.deps.step.name,
      }),
    });
    this.completionCoordinator = new CompanionCompletionCoordinator({
      activeNames: () => [...this.active.keys()],
      detectors: this.detectors,
      queue: this.queue,
      readSnapshot: () => this.readSnapshot(),
      synchronizeSnapshot: (snapshot) => this.requireScheduler().synchronizeSnapshot(snapshot),
      openMustFix: () => this.openMustFix(),
      recordCompletionRound: async (snapshot) => this.recordStandaloneRound(
        snapshot.digest,
        summarizeDiff(snapshot),
        this.latestImplementerExplanation,
        [],
        this.currentFixRound,
        this.deps.abortSignal,
      ),
      decision: this.terminalDecision,
      events: this.events,
      abortSignal: this.deps.abortSignal,
      onError: () => log.warn('Companion completion review failed; confirmed findings were retained', {
        step: this.deps.step.name,
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
    if (!this.active.has(companionName)) {
      throw new Error(`Inactive companion "${companionName}"`);
    }
    const detector = this.detectors.get(companionName);
    if (detector === undefined) throw new Error(`Missing detector for companion "${companionName}"`);
    try {
      await executeCompanionReviewRound({
        companionName,
        diff,
        trigger: request.reason,
        observedGeneration,
        changedRegionsSincePreviousReview: detector.changedRegionsSinceLastReview(diff),
        diffSummary: summarizeDiff(diff),
        implementerExplanation: this.latestImplementerExplanation,
        signal,
        task: this.deps.task,
        stepName: this.deps.step.name,
        stepInstruction: this.deps.step.instruction ?? '',
        activeNames: [...this.active.keys()],
        moderatorName: this.deps.step.companion?.moderator,
        stateStore: this.deps.stateStore,
        mailboxPath: (name) => this.mailboxPath(name),
        systemPrompt: (name) => this.definitionSystemPrompt(name),
        openFindings: () => this.openFindings(),
        callStructured: async (
          purpose,
          agentName,
          systemPrompt,
          prompt,
          schema,
          reviewSignal,
          validateResponse,
        ) => (
          this.structuredCaller.call({
            purpose,
            agentName,
            provider: this.requireProvider(agentName),
            systemPrompt,
            prompt,
            outputSchema: schema,
            abortSignal: reviewSignal,
            validateResponse,
          })
        ),
        emitFinding: (ownerName, findingId, severity) => {
          this.events.finding(ownerName, findingId, severity);
        },
        markReviewed: (snapshot, generation) => detector.markReviewed(snapshot, generation),
        evaluateRound: async (digest, diffSummary, implementerExplanation, transitions) => (
          this.evaluateRound(
            digest,
            diffSummary,
            implementerExplanation,
            transitions,
            this.currentFixRound,
            signal,
          )
        ),
        applyRoundDecision: (decision) => this.terminalDecision.update(decision),
        onRoundCompleted: (round) => this.events.reviewRound({
          companion: companionName,
          trigger: round.trigger,
          digest: round.snapshot.digest,
          changedLines: round.snapshot.changedLines,
          findingCount: round.findingCount,
        }),
      });
    } catch (error) {
      if (!isCompanionCapacityError(error)) throw error;
      this.recordCapacityExceeded(companionName);
    }
  }

  private async evaluateRound(
    diffDigest: string,
    diffSummary: string,
    implementerExplanation: string | undefined,
    transitions: CompanionLoopRound['transitions'],
    fixRound?: number,
    abortSignal?: AbortSignal,
  ) {
    const openFindings = this.openFindings();
    const historyScope = this.historyScope();
    const round: CompanionLoopRound = {
      diffDigest,
      diffSummary,
      ...(implementerExplanation === undefined ? {} : { implementerExplanation }),
      openCount: openFindings.length,
      transitions,
      ...(fixRound === undefined ? {} : { fixRound }),
    };
    const history = this.deps.stateStore.previewRound(historyScope, round);
    const evaluated = await evaluateCompanionLoop({
      history,
      judge: async ({ history: judgeHistory, signals }) => {
        const judgeName = this.deps.step.companion?.moderator ?? this.active.keys().next().value;
        if (judgeName === undefined) return { decision: 'continue' as const };
        const response = await this.structuredCaller.call({
          purpose: 'judge',
          agentName: judgeName,
          provider: this.requireProvider(judgeName),
          systemPrompt: this.definitionSystemPrompt(judgeName),
          prompt: buildCompanionLoopJudgePrompt(judgeHistory, signals),
          outputSchema: LOOP_JUDGE_OUTPUT_JSON_SCHEMA,
          abortSignal,
          validateResponse: (candidate) => {
            parseLoopJudgeOutput(candidate.structuredOutput);
          },
        });
        return parseLoopJudgeOutput(response.structuredOutput);
      },
    });
    return {
      historyScope,
      round,
      decision: {
        decision: evaluated.decision,
        ...(evaluated.reason === undefined ? {} : { reason: evaluated.reason }),
      },
    };
  }

  private async recordStandaloneRound(
    diffDigest: string,
    diffSummary: string,
    implementerExplanation: string | undefined,
    transitions: CompanionLoopRound['transitions'],
    fixRound?: number,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const evaluated = await this.evaluateRound(
      diffDigest,
      diffSummary,
      implementerExplanation,
      transitions,
      fixRound,
      abortSignal,
    );
    this.deps.stateStore.recordRound(evaluated.historyScope, evaluated.round);
    this.terminalDecision.update(evaluated.decision);
  }

  private openFindings() {
    const open = [];
    for (const name of this.active.keys()) {
      try {
        open.push(...this.deps.stateStore.get(this.mailboxPath(name), name).mailbox.findings.filter(
          ({ status }) => status === 'open' || status === 'unresolved',
        ));
      } catch (error) {
        if (!isCompanionCapacityError(error)) throw error;
        this.recordCapacityExceeded(name);
      }
    }
    return open;
  }

  private hasOpenMustFix(companionName: string): boolean {
    try {
      return this.deps.stateStore.get(
        this.mailboxPath(companionName),
        companionName,
      ).mailbox.findings.some(({ severity, status }) => (
        severity === 'must_fix' && (status === 'open' || status === 'unresolved')
      ));
    } catch (error) {
      if (!isCompanionCapacityError(error)) throw error;
      this.recordCapacityExceeded(companionName);
      return false;
    }
  }

  private recordCapacityExceeded(companionName: string): void {
    this.terminalDecision.update({
      decision: 'escalate',
      reason: `Companion "${companionName}" reached its cumulative capacity.`,
    });
  }

  private openMustFix(): CompanionFindingEvidence[] {
    return this.openFindings()
      .filter(({ severity }) => severity === 'must_fix')
      .map(toCompanionFindingEvidence);
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

  private historyScope(): string {
    return [this.deps.runSlug, ...this.deps.runPathNamespace, this.deps.step.name].join('\0');
  }

  private async readSnapshot(): Promise<CompanionDiff> {
    const result = await this.deps.diffReader.readDiff(
      this.deps.cwd,
      this.baselineSha,
      this.deps.abortSignal,
    );
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

  private mailboxPath(name: string): string {
    return buildCompanionMailboxPath({
      cwd: this.deps.cwd,
      runSlug: this.deps.runSlug,
      runPathNamespace: this.deps.runPathNamespace,
      stepName: this.deps.step.name,
      companionName: name,
    });
  }

  private requireScheduler(): CompanionTriggerScheduler {
    if (this.scheduler === undefined) throw new Error('Companion trigger scheduler is not initialized');
    return this.scheduler;
  }

  private requireCompletionCoordinator(): CompanionCompletionCoordinator {
    if (this.completionCoordinator === undefined) {
      throw new Error('Companion completion coordinator is not initialized');
    }
    return this.completionCoordinator;
  }
}

function summarizeDiff(diff: CompanionDiff): string {
  return truncateUtf8(JSON.stringify({
    digest: diff.digest,
    changedLines: diff.changedLines,
    changedFiles: diff.changedFiles,
    changedRegions: Object.keys(diff.hunkFingerprints),
    omittedBytes: diff.omittedBytes,
    truncated: diff.truncated,
  }), ROUND_CONTEXT_MAX_BYTES).value;
}
