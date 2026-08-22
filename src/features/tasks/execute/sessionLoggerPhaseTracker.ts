import type { PhasePromptParts } from '../../../core/workflow/types.js';
import { buildPhaseExecutionId } from '../../../shared/utils/phaseExecutionId.js';

interface PhaseTrackerOptions {
  stepName: string;
  phase: 1 | 2 | 3;
  phaseExecutionId: string | undefined;
  iteration: number | undefined;
  scopeKey: string;
}

interface PhaseStartTrackerOptions extends PhaseTrackerOptions {
  promptParts: PhasePromptParts;
  capturePrompt: boolean;
}

interface PhaseCompletionTrackerOptions extends PhaseTrackerOptions {
  requirePrompt: boolean;
}

function buildExecutionCounterKey(
  scopeKey: string,
  stepName: string,
  phase: 1 | 2 | 3,
  iteration: number,
): string {
  return JSON.stringify([scopeKey, stepName, iteration, phase]);
}

function buildScopedExecutionKey(scopeKey: string, phaseExecutionId: string): string {
  return JSON.stringify([scopeKey, phaseExecutionId]);
}

function requireIteration(stepName: string, phase: 1 | 2 | 3, iteration: number | undefined): number {
  if (iteration == null) {
    throw new Error(`Missing iteration for phase execution id: ${stepName}:${phase}`);
  }
  return iteration;
}

export class SessionLoggerPhaseTracker {
  private readonly promptsByScopedExecution = new Map<string, PhasePromptParts>();
  private readonly executionCounters = new Map<string, number>();

  trackStart(options: PhaseStartTrackerOptions): string {
    const phaseExecutionId = this.resolvePhaseExecutionId(
      options.stepName,
      options.phase,
      options.phaseExecutionId,
      options.iteration,
      options.scopeKey,
    );
    if (options.capturePrompt) {
      const scopedExecutionKey = buildScopedExecutionKey(
        options.scopeKey,
        phaseExecutionId,
      );
      if (this.promptsByScopedExecution.has(scopedExecutionKey)) {
        throw new Error(
          `Duplicate debug prompt execution: ${options.stepName}:${options.phase}:${phaseExecutionId}`,
        );
      }
      this.promptsByScopedExecution.set(scopedExecutionKey, options.promptParts);
    }
    return phaseExecutionId;
  }

  trackCompletion(
    options: PhaseCompletionTrackerOptions,
  ): { phaseExecutionId: string; promptParts?: PhasePromptParts } {
    const phaseExecutionId = this.resolveCompletionPhaseExecutionId(
      options.stepName,
      options.phase,
      options.phaseExecutionId,
      options.iteration,
      options.scopeKey,
    );
    if (!options.requirePrompt) {
      return { phaseExecutionId };
    }

    const scopedExecutionKey = buildScopedExecutionKey(
      options.scopeKey,
      phaseExecutionId,
    );
    const promptParts = this.promptsByScopedExecution.get(scopedExecutionKey);
    if (!promptParts) {
      throw new Error(`Missing debug prompt for ${options.stepName}:${options.phase}:${phaseExecutionId}`);
    }
    this.promptsByScopedExecution.delete(scopedExecutionKey);
    return { phaseExecutionId, promptParts };
  }

  resolveExistingExecutionId(options: PhaseTrackerOptions): string {
    return this.resolveCompletionPhaseExecutionId(
      options.stepName,
      options.phase,
      options.phaseExecutionId,
      options.iteration,
      options.scopeKey,
    );
  }

  private resolvePhaseExecutionId(
    stepName: string,
    phase: 1 | 2 | 3,
    phaseExecutionId: string | undefined,
    iteration: number | undefined,
    scopeKey: string,
  ): string {
    if (phaseExecutionId) {
      return phaseExecutionId;
    }

    const resolvedIteration = requireIteration(stepName, phase, iteration);
    const key = buildExecutionCounterKey(
      scopeKey,
      stepName,
      phase,
      resolvedIteration,
    );
    const current = this.executionCounters.get(key) ?? 0;
    const next = current + 1;
    this.executionCounters.set(key, next);
    return buildPhaseExecutionId({
      step: stepName,
      iteration: resolvedIteration,
      phase,
      sequence: next,
    });
  }

  private resolveCompletionPhaseExecutionId(
    stepName: string,
    phase: 1 | 2 | 3,
    phaseExecutionId: string | undefined,
    iteration: number | undefined,
    scopeKey: string,
  ): string {
    if (phaseExecutionId) {
      return phaseExecutionId;
    }

    const resolvedIteration = requireIteration(stepName, phase, iteration);
    const key = buildExecutionCounterKey(
      scopeKey,
      stepName,
      phase,
      resolvedIteration,
    );
    const current = this.executionCounters.get(key);
    if (current == null) {
      throw new Error(`Missing phase execution id on completion for ${stepName}:${phase}`);
    }
    return buildPhaseExecutionId({
      step: stepName,
      iteration: resolvedIteration,
      phase,
      sequence: current,
    });
  }
}
