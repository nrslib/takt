/**
 * Executes arpeggio piece movements: data-driven batch processing.
 *
 * Reads data from a source, expands templates with batch data,
 * calls LLM for each batch (with concurrency control),
 * merges results, and returns an aggregated response.
 */

import type {
  PieceMovement,
  PieceState,
  AgentResponse,
} from '../../models/types.js';
import type { ArpeggioMovementConfig, BatchResult, DataBatch } from '../arpeggio/types.js';
import { createDataSource } from '../arpeggio/data-source-factory.js';
import { loadTemplate, expandTemplate } from '../arpeggio/template.js';
import { buildMergeFn, writeMergedOutput } from '../arpeggio/merge.js';
import { runAgent, type RunAgentOptions } from '../../../agents/runner.js';
import { detectMatchedRule } from '../evaluation/index.js';
import { incrementMovementIteration } from './state-manager.js';
import { createLogger } from '../../../shared/utils/index.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { MovementExecutor } from './MovementExecutor.js';
import type { PhaseName } from '../types.js';

const log = createLogger('arpeggio-runner');

export interface ArpeggioRunnerDeps {
  readonly optionsBuilder: OptionsBuilder;
  readonly movementExecutor: MovementExecutor;
  readonly getCwd: () => string;
  readonly getInteractive: () => boolean;
  readonly detectRuleIndex: (content: string, movementName: string) => number;
  readonly callAiJudge: (
    agentOutput: string,
    conditions: Array<{ index: number; text: string }>,
    options: { cwd: string }
  ) => Promise<number>;
  readonly onPhaseStart?: (step: PieceMovement, phase: 1 | 2 | 3, phaseName: PhaseName, instruction: string) => void;
  readonly onPhaseComplete?: (step: PieceMovement, phase: 1 | 2 | 3, phaseName: PhaseName, content: string, status: string, error?: string) => void;
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

/** Execute a single batch with retry logic */
async function executeBatchWithRetry(
  batch: DataBatch,
  template: string,
  persona: string | undefined,
  agentOptions: RunAgentOptions,
  maxRetries: number,
  retryDelayMs: number,
): Promise<BatchResult> {
  const prompt = expandTemplate(template, batch);
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await runAgent(persona, prompt, agentOptions);
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
        };
      }
      return {
        batchIndex: batch.batchIndex,
        content: response.content,
        success: true,
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
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ArpeggioRunner {
  constructor(
    private readonly deps: ArpeggioRunnerDeps,
  ) {}

  /**
   * Run an arpeggio movement: read data, expand templates, call LLM,
   * merge results, and return an aggregated response.
   */
  async runArpeggioMovement(
    step: PieceMovement,
    state: PieceState,
  ): Promise<{ response: AgentResponse; instruction: string }> {
    const arpeggioConfig = step.arpeggio;
    if (!arpeggioConfig) {
      throw new Error(`Movement "${step.name}" has no arpeggio configuration`);
    }

    const movementIteration = incrementMovementIteration(state, step.name);
    log.debug('Running arpeggio movement', {
      movement: step.name,
      source: arpeggioConfig.source,
      batchSize: arpeggioConfig.batchSize,
      concurrency: arpeggioConfig.concurrency,
      movementIteration,
    });

    const dataSource = await createDataSource(arpeggioConfig.source, arpeggioConfig.sourcePath);
    const batches = await dataSource.readBatches(arpeggioConfig.batchSize);

    if (batches.length === 0) {
      throw new Error(`Data source returned no batches for movement "${step.name}"`);
    }

    log.info('Arpeggio data loaded', {
      movement: step.name,
      batchCount: batches.length,
      batchSize: arpeggioConfig.batchSize,
    });

    const template = loadTemplate(arpeggioConfig.templatePath);

    const agentOptions = this.deps.optionsBuilder.buildAgentOptions(step);
    const semaphore = new Semaphore(arpeggioConfig.concurrency);
    const results = await this.executeBatches(
      batches,
      template,
      step,
      agentOptions,
      arpeggioConfig,
      semaphore,
    );

    const failedBatches = results.filter((r) => !r.success);
    if (failedBatches.length > 0) {
      const errorDetails = failedBatches
        .map((r) => `batch ${r.batchIndex}: ${r.error}`)
        .join('; ');
      throw new Error(
        `Arpeggio movement "${step.name}" failed: ${failedBatches.length}/${results.length} batches failed (${errorDetails})`
      );
    }

    const mergeFn = await buildMergeFn(arpeggioConfig.merge);
    const mergedContent = mergeFn(results);

    if (arpeggioConfig.outputPath) {
      writeMergedOutput(arpeggioConfig.outputPath, mergedContent);
      log.info('Arpeggio output written', { outputPath: arpeggioConfig.outputPath });
    }

    const ruleCtx = {
      state,
      cwd: this.deps.getCwd(),
      interactive: this.deps.getInteractive(),
      detectRuleIndex: this.deps.detectRuleIndex,
      callAiJudge: this.deps.callAiJudge,
    };
    const match = await detectMatchedRule(step, mergedContent, '', ruleCtx);

    const aggregatedResponse: AgentResponse = {
      persona: step.name,
      status: 'done',
      content: mergedContent,
      timestamp: new Date(),
      ...(match && { matchedRuleIndex: match.index, matchedRuleMethod: match.method }),
    };

    state.movementOutputs.set(step.name, aggregatedResponse);
    state.lastOutput = aggregatedResponse;
    this.deps.movementExecutor.persistPreviousResponseSnapshot(
      state,
      step.name,
      movementIteration,
      aggregatedResponse.content,
    );

    const instruction = `[Arpeggio] ${step.name}: ${batches.length} batches, source=${arpeggioConfig.source}`;

    return { response: aggregatedResponse, instruction };
  }

  /** Execute all batches with concurrency control */
  private async executeBatches(
    batches: readonly DataBatch[],
    template: string,
    step: PieceMovement,
    agentOptions: RunAgentOptions,
    config: ArpeggioMovementConfig,
    semaphore: Semaphore,
  ): Promise<BatchResult[]> {
    const promises = batches.map(async (batch) => {
      await semaphore.acquire();
      try {
        this.deps.onPhaseStart?.(step, 1, 'execute', `[Arpeggio batch ${batch.batchIndex + 1}/${batch.totalBatches}]`);
        const result = await executeBatchWithRetry(
          batch,
          template,
          step.persona,
          agentOptions,
          config.maxRetries,
          config.retryDelayMs,
        );
        this.deps.onPhaseComplete?.(
          step, 1, 'execute',
          result.content,
          result.success ? 'done' : 'error',
          result.error,
        );
        return result;
      } finally {
        semaphore.release();
      }
    });

    return Promise.all(promises);
  }
}
