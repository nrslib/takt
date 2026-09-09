/**
 * Executes arpeggio workflow steps: data-driven batch processing.
 *
 * Reads data from a source, expands templates with batch data,
 * calls LLM for each batch (with concurrency control),
 * merges results, and returns an aggregated response.
 */

import type {
  WorkflowStep,
  WorkflowState,
  AgentResponse,
  WorkflowResumePointEntry,
  WorkflowMaxSteps,
  WorkflowWideRule,
} from '../../models/types.js';
import type { ArpeggioStepConfig, BatchResult, DataBatch } from '../arpeggio/types.js';
import { createDataSource } from '../arpeggio/data-source-factory.js';
import { loadTemplate, expandTemplate } from '../arpeggio/template.js';
import { buildMergeFn, writeMergedOutput } from '../arpeggio/merge.js';
import type { RunAgentOptions } from '../../../agents/runner.js';
import { executeAgent } from '../../../agents/agent-usecases.js';
import { evaluatePostExecutionRules } from './post-execution-rule-evaluator.js';
import { getPreviousOutput, incrementStepIteration } from './state-manager.js';
import { createLogger, delay } from '../../../shared/utils/index.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { StepExecutor } from './StepExecutor.js';
import type { PhaseName, PhasePromptParts, RuntimeStepResolution, StepProviderInfo, StepRunResult } from '../types.js';
import type {
  LiveInterventionChannel,
  PreparedLiveInterventionDelivery,
} from '../live-intervention/types.js';
import {
  createLiveInterventionDeliveryCommitter,
  type LiveInterventionDeliveryCommitter,
} from '../live-intervention/delivery.js';
import { buildGitRules } from '../instruction/instruction-context.js';
import type { InstructionContext } from '../instruction/instruction-context.js';
import { preparePreviousResponseContent } from '../instruction/InstructionBuilder.js';
import { renderFallbackNotice } from '../instruction/fallback-notice.js';
import { renderWorkflowWideRules } from '../instruction/workflow-wide-rules.js';
import { buildResumeReportConsumerKeyFromStack } from '../run/resume-report-consumer.js';
import { resolveReportDirectory } from '../run/run-paths.js';
import { runWithPhaseSpan } from '../observability/workflowSpans.js';
import { USAGE_MISSING_REASONS } from '../../logging/contracts.js';
import { sumRetryCounts } from '../../models/response.js';
import {
  AGENT_FAILURE_CATEGORIES,
  createAgentResponseFailureError,
  isAgentFailureError,
  isProviderStreamParseError,
} from '../../../shared/types/agent-failure.js';

const log = createLogger('arpeggio-runner');

export interface ArpeggioRunnerDeps {
  readonly optionsBuilder: OptionsBuilder;
  readonly stepExecutor: StepExecutor;
  readonly liveIntervention?: LiveInterventionChannel;
  readonly getAbortSignal?: () => AbortSignal | undefined;
  readonly getCwd: () => string;
  readonly getReportDir: () => string;
  readonly getReportsRootDir: () => string;
  readonly getProjectCwd: () => string;
  readonly getTask: () => string;
  readonly getMaxSteps: () => WorkflowMaxSteps;
  readonly getWorkflowName: () => string;
  readonly getWorkflowRules: () => readonly WorkflowWideRule[] | undefined;
  readonly getReviewScope: () => InstructionContext['reviewScope'];
  readonly getWorkflowCallVars?: () => InstructionContext['workflowCallVars'];
  readonly getInteractive: () => boolean;
  readonly childProcessEnv?: RunAgentOptions['childProcessEnv'];
  readonly observabilityEnabled: boolean;
  readonly observabilityRunId?: string;
  readonly sanitizeObservabilityText?: (text: string) => string;
  readonly getCurrentWorkflowStack?: () => WorkflowResumePointEntry[] | undefined;
  readonly onPhaseStart?: (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    instruction: string,
    promptParts: PhasePromptParts,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
  readonly onPhaseComplete?: (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    content: string,
    status: string,
    error?: string,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
}

/**
 * Simple semaphore for controlling concurrency.
 * Limits the number of concurrent async operations.
 */
class Semaphore {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    if (this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      next();
    } else {
      this.running--;
    }
  }
}

interface ArpeggioBatchObservability {
  readonly enabled: boolean;
  readonly runId?: string;
  readonly workflowName: string;
  readonly step: WorkflowStep;
  readonly iteration: number;
  readonly phaseExecutionId: string;
  readonly workflowStack?: WorkflowResumePointEntry[];
  readonly sanitizeText?: (text: string) => string;
  readonly providerInfo?: StepProviderInfo;
  readonly getPromptParts?: () => PhasePromptParts | undefined;
}

/** Execute a single batch with retry logic */
async function executeBatchWithRetry(
  batch: DataBatch,
  template: string,
  allowGitCommit: boolean | undefined,
  persona: string | undefined,
  agentOptions: RunAgentOptions,
  maxRetries: number,
  retryDelayMs: number,
  observability: ArpeggioBatchObservability,
  instructionContext: InstructionContext,
  runtime?: RuntimeStepResolution,
  additionalPrompt?: string,
): Promise<BatchResult> {
  const prompt = buildArpeggioPrompt(
    template,
    batch,
    observability.step,
    allowGitCommit,
    agentOptions.language ?? 'en',
    instructionContext,
    runtime,
    additionalPrompt,
  );
  let lastError: string | undefined;
  let lastFailureCategory: AgentResponse['failureCategory'];

  return runWithPhaseSpan<BatchResult>({
    enabled: observability.enabled,
    runId: observability.runId,
    workflowName: observability.workflowName,
    step: observability.step,
    iteration: observability.iteration,
    phase: 1,
    phaseName: 'execute',
    instruction: prompt,
    phaseExecutionId: observability.phaseExecutionId,
    workflowStack: observability.workflowStack,
    sanitizeText: observability.sanitizeText,
    providerInfo: observability.providerInfo,
    getPromptParts: observability.getPromptParts,
  }, async () => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await executeAgent(persona, prompt, agentOptions);
        if (response.status === 'error') {
          if (
            response.failureCategory
            === AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR
          ) {
            throw createAgentResponseFailureError(response, 'Arpeggio batch failed');
          }
          lastError = response.error ?? response.content ?? 'Agent returned error status';
          log.info('Batch execution failed, retrying', {
            batchIndex: batch.batchIndex,
            attempt: attempt + 1,
            maxRetries,
            error: lastError,
          });
          if (attempt < maxRetries) {
            await delay(retryDelayMs);
            continue;
          }
          return {
            batchIndex: batch.batchIndex,
            content: '',
            success: false,
            error: lastError,
            providerUsage: response.providerUsage,
            ...(response.retryCount === undefined ? {} : { retryCount: response.retryCount }),
            ...(response.failureCategory === undefined ? {} : { failureCategory: response.failureCategory }),
          };
        }
        if (response.status === 'rate_limited') {
          return {
            batchIndex: batch.batchIndex,
            content: response.content,
            success: false,
            error: response.error ?? response.content,
            rateLimitedResponse: response,
            providerUsage: response.providerUsage,
            ...(response.retryCount === undefined ? {} : { retryCount: response.retryCount }),
          };
        }
        return {
          batchIndex: batch.batchIndex,
          content: response.content,
          success: true,
          providerUsage: response.providerUsage,
          ...(response.retryCount === undefined ? {} : { retryCount: response.retryCount }),
        };
      } catch (error) {
        if (isProviderStreamParseError(error)) {
          throw error;
        }
        lastError = error instanceof Error ? error.message : String(error);
        lastFailureCategory = isAgentFailureError(error) ? error.failureCategory : undefined;
        log.info('Batch execution threw, retrying', {
          batchIndex: batch.batchIndex,
          attempt: attempt + 1,
          maxRetries,
          error: lastError,
        });
        if (attempt < maxRetries) {
          await delay(retryDelayMs);
          continue;
        }
      }
    }

    return {
      batchIndex: batch.batchIndex,
      content: '',
      success: false,
      error: lastError,
      providerUsage: {
        usageMissing: true,
        reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
      },
      ...(lastFailureCategory === undefined ? {} : { failureCategory: lastFailureCategory }),
    };
  }, (result) => ({
    status: getBatchResultStatus(result),
    content: result.content,
    error: result.error,
    providerUsage: result.providerUsage,
  }));
}

function getBatchResultStatus(result: BatchResult): string {
  return result.rateLimitedResponse?.status ?? (result.success ? 'done' : 'error');
}

function hasPendingOutsideDeliveries(
  channel: LiveInterventionChannel | undefined,
  deliveries: readonly PreparedLiveInterventionDelivery[],
): boolean {
  if (channel === undefined) return false;
  const deliveredIds = new Set(deliveries.flatMap((delivery) => delivery.instructionIds));
  return channel.read().instructions.some((instruction) => (
    instruction.state === 'pending' && !deliveredIds.has(instruction.instructionId)
  ));
}

function buildArpeggioPrompt(
  template: string,
  batch: DataBatch,
  step: WorkflowStep,
  allowGitCommit: boolean | undefined,
  language: NonNullable<RunAgentOptions['language']>,
  instructionContext: InstructionContext,
  runtime?: RuntimeStepResolution,
  additionalPrompt?: string,
): string {
  const prompt = expandTemplate(template, batch);
  const gitRules = buildGitRules(allowGitCommit, language, 'phase1');
  const fallbackNotice = runtime?.fallback
    ? renderFallbackNotice(runtime.fallback, language)
    : '';
  const renderedRules = renderWorkflowWideRules(
    instructionContext.workflowRules,
    language,
    step,
    instructionContext,
  );
  return [
    gitRules,
    renderedRules.noticeAfterExecutionRules,
    renderedRules.afterExecutionRules,
    fallbackNotice,
    renderedRules.noticeBeforeInstructionRules,
    renderedRules.beforeInstructionRules,
    prompt,
    additionalPrompt,
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n\n');
}

export class ArpeggioRunner {
  constructor(
    private readonly deps: ArpeggioRunnerDeps,
  ) {}

  /**
   * Run an arpeggio step: read data, expand templates, call LLM,
   * merge results, and return an aggregated response.
   */
  async runArpeggioStep(
    step: WorkflowStep,
    state: WorkflowState,
    runtime?: RuntimeStepResolution,
    activeStepIteration?: number,
  ): Promise<StepRunResult> {
    const arpeggioConfig = step.arpeggio;
    if (!arpeggioConfig) {
      throw new Error(`Step "${step.name}" has no arpeggio configuration`);
    }

    const stepIteration = activeStepIteration ?? incrementStepIteration(state, step.name);
    log.debug('Running arpeggio step', {
      step: step.name,
      source: arpeggioConfig.source,
      batchSize: arpeggioConfig.batchSize,
      concurrency: arpeggioConfig.concurrency,
      stepIteration,
    });

    const dataSource = await createDataSource(arpeggioConfig.source, arpeggioConfig.sourcePath);
    const batches = await dataSource.readBatches(arpeggioConfig.batchSize);

    if (batches.length === 0) {
      throw new Error(`Data source returned no batches for step "${step.name}"`);
    }

    log.info('Arpeggio data loaded', {
      step: step.name,
      batchCount: batches.length,
      batchSize: arpeggioConfig.batchSize,
    });

    const template = loadTemplate(arpeggioConfig.templatePath);

    const stepProviderModel = runtime
      ? this.deps.optionsBuilder.resolveStepProviderModel(step, runtime)
      : this.deps.optionsBuilder.resolveStepProviderModel(step);
    const agentOptions = this.deps.optionsBuilder.buildAgentOptions(step, runtime);
    const previousOutput = getPreviousOutput(state);
    const previousResponseText = step.passPreviousResponse && previousOutput
      ? preparePreviousResponseContent(
          previousOutput.content,
          state.previousResponseSourcePath,
          step.preserveFullPreviousResponse === true,
        )
      : undefined;
    const instructionContext: InstructionContext = {
      task: this.deps.getTask(),
      iteration: state.iteration,
      maxSteps: this.deps.getMaxSteps(),
      stepIteration,
      cwd: this.deps.getCwd(),
      projectCwd: this.deps.getProjectCwd(),
      userInputs: state.userInputs,
      previousOutput,
      previousResponseSourcePath: state.previousResponseSourcePath,
      previousResponseText,
      reportDir: resolveReportDirectory(this.deps.getCwd(), this.deps.getReportDir()),
      reportsRootDir: this.deps.getReportsRootDir(),
      resumeReportConsumerKey: buildResumeReportConsumerKeyFromStack(
        this.deps.getCurrentWorkflowStack?.() ?? [],
      ),
      language: agentOptions.language ?? 'en',
      interactive: this.deps.getInteractive(),
      workflowName: this.deps.getWorkflowName(),
      reviewScope: this.deps.getReviewScope(),
      workflowState: state,
      workflowRules: this.deps.getWorkflowRules(),
      workflowCallVars: this.deps.getWorkflowCallVars?.(),
    };
    const semaphore = new Semaphore(arpeggioConfig.concurrency);
    const results = await this.executeBatches(
      batches,
      template,
      step,
      stepIteration,
      state.iteration,
      agentOptions,
      arpeggioConfig,
      semaphore,
      stepProviderModel,
      instructionContext,
      runtime,
    );

    const instruction = `[Arpeggio] ${step.name}: ${batches.length} batches, source=${arpeggioConfig.source}`;
    const retryCount = sumRetryCounts(results);
    const rateLimitedResult = results.find((result) => result.rateLimitedResponse);
    if (rateLimitedResult?.rateLimitedResponse) {
      const rateLimitedResponse: AgentResponse = {
        ...rateLimitedResult.rateLimitedResponse,
        persona: step.name,
        ...(retryCount === undefined ? {} : { retryCount }),
      };
      state.stepOutputs.set(step.name, rateLimitedResponse);
      state.lastOutput = rateLimitedResponse;
      return { response: rateLimitedResponse, instruction, providerInfo: stepProviderModel };
    }

    const failedBatches = results.filter((r) => !r.success);
    if (failedBatches.length > 0) {
      const errorDetails = failedBatches
        .map((r) => `batch ${r.batchIndex}: ${r.error}`)
        .join('; ');
      const primaryFailure = failedBatches.find((result) => result.failureCategory !== undefined)
        ?? failedBatches[0];
      if (primaryFailure === undefined) {
        throw new Error(`Arpeggio step "${step.name}" has no primary failed batch`);
      }
      const failureMessage = `Arpeggio step "${step.name}" failed: ${failedBatches.length}/${results.length} batches failed (${errorDetails})`;
      const failureResponse: AgentResponse = {
        persona: step.name,
        status: 'error',
        content: failureMessage,
        error: primaryFailure.error ?? failureMessage,
        timestamp: new Date(),
        ...(primaryFailure.failureCategory === undefined
          ? {}
          : { failureCategory: primaryFailure.failureCategory }),
        ...(retryCount === undefined ? {} : { retryCount }),
      };
      state.stepOutputs.set(step.name, failureResponse);
      state.lastOutput = failureResponse;
      return { response: failureResponse, instruction, providerInfo: stepProviderModel };
    }

    const mergeFn = buildMergeFn(arpeggioConfig.merge);
    const mergedContent = mergeFn(results);

    if (arpeggioConfig.outputPath) {
      writeMergedOutput(arpeggioConfig.outputPath, mergedContent);
      log.info('Arpeggio output written', { outputPath: arpeggioConfig.outputPath });
    }

    const ruleCtx = {
      state,
      interactive: this.deps.getInteractive(),
    };
    const match = await evaluatePostExecutionRules(
      step,
      () => this.deps.optionsBuilder.buildPhaseRunnerContext(
        step,
        state,
        mergedContent,
        () => undefined,
        this.deps.onPhaseStart,
        this.deps.onPhaseComplete,
        undefined,
        state.iteration,
        runtime,
      ),
      ruleCtx,
    );

    const aggregatedResponse: AgentResponse = {
      persona: step.name,
      status: 'done',
      content: mergedContent,
      timestamp: new Date(),
      ...(match && { matchedRuleIndex: match.index, matchedRuleMethod: match.method }),
      ...(retryCount === undefined ? {} : { retryCount }),
    };

    state.stepOutputs.set(step.name, aggregatedResponse);
    state.lastOutput = aggregatedResponse;
    this.deps.stepExecutor.persistPreviousResponseSnapshot(
      state,
      step.name,
      stepIteration,
      aggregatedResponse.content,
    );

    return { response: aggregatedResponse, instruction, providerInfo: stepProviderModel };
  }

  /** Execute all batches with concurrency control */
  private async executeBatches(
    batches: readonly DataBatch[],
    template: string,
    step: WorkflowStep,
    stepIteration: number,
    iteration: number,
    agentOptions: RunAgentOptions,
    config: ArpeggioStepConfig,
    semaphore: Semaphore,
    providerInfo: StepProviderInfo,
    instructionContext: InstructionContext,
    runtime?: RuntimeStepResolution,
  ): Promise<BatchResult[]> {
    const liveIntervention = this.deps.liveIntervention;
    const liveDeliveries: PreparedLiveInterventionDelivery[] = [];
    if (liveIntervention !== undefined && liveIntervention.read().pending > 0) {
      liveDeliveries.push(await liveIntervention.prepareDelivery({
        language: agentOptions.language,
        mode: 'batch_boundary',
        step: step.name,
        phase: 1,
        processedBatchCount: 0,
        runningBatchIndexes: [],
        appliesToBatchIndexes: batches.map((batch) => batch.batchIndex),
      }));
    }
    const completedBatchIndexes = new Set<number>();
    const runningBatchIndexes = new Set<number>();
    const deliveryCommitters = new Map<
      PreparedLiveInterventionDelivery,
      LiveInterventionDeliveryCommitter
    >();
    let boundaryPreparation: Promise<PreparedLiveInterventionDelivery | undefined> | undefined;
    const getDeliveryCommitter = (
      delivery: PreparedLiveInterventionDelivery | undefined,
    ): LiveInterventionDeliveryCommitter | undefined => {
      if (liveIntervention === undefined || delivery === undefined) {
        return undefined;
      }
      const existing = deliveryCommitters.get(delivery);
      if (existing !== undefined) {
        return existing;
      }
      const created = createLiveInterventionDeliveryCommitter(liveIntervention, delivery);
      if (created === undefined) {
        return undefined;
      }
      deliveryCommitters.set(delivery, created);
      return created;
    };
    const batchAbortSignal = agentOptions.abortSignal
      ?? this.deps.getAbortSignal?.()
      ?? new AbortController().signal;
    const prepareBoundaryDelivery = async (): Promise<PreparedLiveInterventionDelivery | undefined> => {
      const previousDelivery = liveDeliveries.at(-1);
      if (boundaryPreparation !== undefined) {
        const preparedDelivery = await boundaryPreparation;
        return preparedDelivery ?? previousDelivery;
      }
      const preparation = (async (): Promise<PreparedLiveInterventionDelivery | undefined> => {
        if (
          liveIntervention === undefined
          || !hasPendingOutsideDeliveries(liveIntervention, liveDeliveries)
        ) {
          return undefined;
        }
        const appliesToBatchIndexes = batches
          .filter((batch) => !completedBatchIndexes.has(batch.batchIndex)
            && !runningBatchIndexes.has(batch.batchIndex))
          .map((batch) => batch.batchIndex);
        if (appliesToBatchIndexes.length === 0) {
          return undefined;
        }
        const preparedDelivery = await liveIntervention.prepareDelivery({
          language: agentOptions.language,
          mode: 'batch_boundary',
          step: step.name,
          phase: 1,
          processedBatchCount: completedBatchIndexes.size,
          runningBatchIndexes: [...runningBatchIndexes].sort((left, right) => left - right),
          appliesToBatchIndexes,
        });
        liveDeliveries.push(preparedDelivery);
        return preparedDelivery;
      })();
      boundaryPreparation = preparation;
      try {
        const preparedDelivery = await preparation;
        return preparedDelivery ?? previousDelivery;
      } finally {
        if (boundaryPreparation === preparation) {
          boundaryPreparation = undefined;
        }
      }
    };
    const promises = batches.map(async (batch) => {
      await semaphore.acquire();
      try {
        const liveDelivery = await prepareBoundaryDelivery();
        runningBatchIndexes.add(batch.batchIndex);
        let didEmitPhaseStart = false;
        let resolvedPromptParts: PhasePromptParts | undefined;
        const phaseExecutionId = `${step.name}:1:${stepIteration}:${batch.batchIndex}`;
        const batchAgentOptions: RunAgentOptions = {
          ...agentOptions,
          abortSignal: batchAbortSignal,
          onPromptResolved: (promptParts) => {
            if (didEmitPhaseStart) return;
            resolvedPromptParts = promptParts;
            this.deps.onPhaseStart?.(step, 1, 'execute', promptParts.userInstruction, promptParts, phaseExecutionId, iteration);
            didEmitPhaseStart = true;
          },
        };
        const deliveryCommitter = getDeliveryCommitter(liveDelivery);
        const batchCallOptions: RunAgentOptions = deliveryCommitter === undefined
          ? batchAgentOptions
          : {
              ...batchAgentOptions,
              onDispatch: (permissionMode) => {
                batchAgentOptions.onDispatch?.(permissionMode);
                deliveryCommitter.onDispatch(permissionMode);
              },
            };
        try {
          const result = await executeBatchWithRetry(
            batch,
            template,
            step.allowGitCommit,
            step.persona,
            batchCallOptions,
            config.maxRetries,
            config.retryDelayMs,
            {
              enabled: this.deps.observabilityEnabled,
              runId: this.deps.observabilityRunId,
              workflowName: this.deps.getWorkflowName(),
              step,
              iteration,
              phaseExecutionId,
              workflowStack: this.deps.getCurrentWorkflowStack?.(),
              sanitizeText: this.deps.sanitizeObservabilityText,
              providerInfo,
              getPromptParts: () => resolvedPromptParts,
            },
            instructionContext,
            runtime,
            liveDelivery?.prompt,
          );
          if (!didEmitPhaseStart) {
            throw new Error(`Missing prompt parts for phase start: ${step.name}:1`);
          }
          this.deps.onPhaseComplete?.(
            step, 1, 'execute',
            result.content,
            getBatchResultStatus(result),
            result.error,
            phaseExecutionId,
            iteration,
          );
          await deliveryCommitter?.settle();
          completedBatchIndexes.add(batch.batchIndex);
          runningBatchIndexes.delete(batch.batchIndex);
          await prepareBoundaryDelivery();
          return result;
        } finally {
          await deliveryCommitter?.settle();
        }
      } finally {
        runningBatchIndexes.delete(batch.batchIndex);
        semaphore.release();
      }
    });

    const results = await Promise.all(promises);
    return results;
  }
}
