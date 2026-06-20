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
} from '../../models/types.js';
import type { ArpeggioStepConfig, BatchResult, DataBatch } from '../arpeggio/types.js';
import { createDataSource } from '../arpeggio/data-source-factory.js';
import { loadTemplate, expandTemplate } from '../arpeggio/template.js';
import { buildMergeFn, writeMergedOutput } from '../arpeggio/merge.js';
import type { RunAgentOptions } from '../../../agents/runner.js';
import { executeAgent } from '../../../agents/agent-usecases.js';
import { detectMatchedRule } from '../evaluation/index.js';
import { incrementStepIteration } from './state-manager.js';
import { createLogger, delay } from '../../../shared/utils/index.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { StepExecutor } from './StepExecutor.js';
import type { PhaseName, PhasePromptParts, RuntimeStepResolution, StepProviderInfo, StepRunResult } from '../types.js';
import type { StructuredCaller } from '../../../agents/structured-caller.js';
import { buildGitRules } from '../instruction/instruction-context.js';
import { renderFallbackNotice } from '../instruction/fallback-notice.js';
import { runWithPhaseSpan } from '../observability/workflowSpans.js';
import { USAGE_MISSING_REASONS } from '../../logging/contracts.js';

const log = createLogger('arpeggio-runner');

export interface ArpeggioRunnerDeps {
  readonly optionsBuilder: OptionsBuilder;
  readonly stepExecutor: StepExecutor;
  readonly getCwd: () => string;
  readonly getWorkflowName: () => string;
  readonly getInteractive: () => boolean;
  readonly childProcessEnv?: RunAgentOptions['childProcessEnv'];
  readonly observabilityEnabled: boolean;
  readonly observabilityRunId?: string;
  readonly sanitizeObservabilityText?: (text: string) => string;
  readonly getCurrentWorkflowStack?: () => WorkflowResumePointEntry[] | undefined;
  readonly detectRuleIndex: (content: string, stepName: string) => number;
  readonly structuredCaller: StructuredCaller;
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
  runtime?: RuntimeStepResolution,
): Promise<BatchResult> {
  const prompt = buildArpeggioPrompt(
    template,
    batch,
    allowGitCommit,
    agentOptions.language ?? 'en',
    runtime,
  );
  let lastError: string | undefined;

  return runWithPhaseSpan({
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
          };
        }
        return {
          batchIndex: batch.batchIndex,
          content: response.content,
          success: true,
          providerUsage: response.providerUsage,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
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

function buildArpeggioPrompt(
  template: string,
  batch: DataBatch,
  allowGitCommit: boolean | undefined,
  language: NonNullable<RunAgentOptions['language']>,
  runtime?: RuntimeStepResolution,
): string {
  const prompt = expandTemplate(template, batch);
  const gitRules = buildGitRules(allowGitCommit, language, 'phase1');
  const fallbackNotice = runtime?.fallback
    ? renderFallbackNotice(runtime.fallback, language)
    : '';
  return [gitRules, fallbackNotice, prompt]
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
  ): Promise<StepRunResult> {
    const arpeggioConfig = step.arpeggio;
    if (!arpeggioConfig) {
      throw new Error(`Step "${step.name}" has no arpeggio configuration`);
    }

    const stepIteration = incrementStepIteration(state, step.name);
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
      runtime,
    );

    const instruction = `[Arpeggio] ${step.name}: ${batches.length} batches, source=${arpeggioConfig.source}`;
    const rateLimitedResult = results.find((result) => result.rateLimitedResponse);
    if (rateLimitedResult?.rateLimitedResponse) {
      const rateLimitedResponse: AgentResponse = {
        ...rateLimitedResult.rateLimitedResponse,
        persona: step.name,
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
      throw new Error(
        `Arpeggio step "${step.name}" failed: ${failedBatches.length}/${results.length} batches failed (${errorDetails})`
      );
    }

    const mergeFn = buildMergeFn(arpeggioConfig.merge);
    const mergedContent = mergeFn(results);

    if (arpeggioConfig.outputPath) {
      writeMergedOutput(arpeggioConfig.outputPath, mergedContent);
      log.info('Arpeggio output written', { outputPath: arpeggioConfig.outputPath });
    }

    const ruleCtx = {
      state,
      cwd: this.deps.getCwd(),
      provider: stepProviderModel.provider,
      resolvedProvider: stepProviderModel.provider,
      resolvedModel: stepProviderModel.model,
      childProcessEnv: this.deps.childProcessEnv,
      interactive: this.deps.getInteractive(),
      detectRuleIndex: this.deps.detectRuleIndex,
      structuredCaller: this.deps.structuredCaller,
    };
    const match = await detectMatchedRule(step, mergedContent, '', ruleCtx);

    const aggregatedResponse: AgentResponse = {
      persona: step.name,
      status: 'done',
      content: mergedContent,
      timestamp: new Date(),
      ...(match && { matchedRuleIndex: match.index, matchedRuleMethod: match.method }),
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
    runtime?: RuntimeStepResolution,
  ): Promise<BatchResult[]> {
    const promises = batches.map(async (batch) => {
      await semaphore.acquire();
      try {
        let didEmitPhaseStart = false;
        let resolvedPromptParts: PhasePromptParts | undefined;
        const phaseExecutionId = `${step.name}:1:${stepIteration}:${batch.batchIndex}`;
        const batchAgentOptions: RunAgentOptions = {
          ...agentOptions,
          onPromptResolved: (promptParts) => {
            if (didEmitPhaseStart) return;
            resolvedPromptParts = promptParts;
            this.deps.onPhaseStart?.(step, 1, 'execute', promptParts.userInstruction, promptParts, phaseExecutionId, iteration);
            didEmitPhaseStart = true;
          },
        };
        const result = await executeBatchWithRetry(
          batch,
          template,
          step.allowGitCommit,
          step.persona,
          batchAgentOptions,
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
          runtime,
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
        return result;
      } finally {
        semaphore.release();
      }
    });

    return Promise.all(promises);
  }
}
