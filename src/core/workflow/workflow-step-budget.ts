import type { WorkflowMaxSteps } from '../models/types.js';
import type { WorkflowExecutionScope } from './workflow-execution-scope.js';

export interface WorkflowStepLimitRequest {
  readonly currentIteration: number;
  readonly currentStep: string;
  readonly scope: WorkflowExecutionScope;
}

export interface WorkflowStepBudgetCheck {
  readonly request: WorkflowStepLimitRequest;
  readonly ignoreLimit: boolean;
  readonly onLimitReached: (maxSteps: number) => void;
  readonly onMaxStepsExtended: (maxSteps: number) => void;
  readonly requestExtension?: (
    request: WorkflowStepLimitRequest & { readonly maxSteps: number },
  ) => Promise<number | null>;
}

export interface WorkflowStepBudgetCheckResult {
  readonly allowed: boolean;
  readonly maxSteps: WorkflowMaxSteps;
}

export class WorkflowStepBudget {
  private maxSteps: WorkflowMaxSteps;
  private decision?: {
    readonly maxSteps: number;
    readonly result: Promise<WorkflowStepBudgetCheckResult>;
  };

  constructor(maxSteps: WorkflowMaxSteps) {
    this.maxSteps = maxSteps;
  }

  currentMaxSteps(): WorkflowMaxSteps {
    return this.maxSteps;
  }

  async check(check: WorkflowStepBudgetCheck): Promise<WorkflowStepBudgetCheckResult> {
    if (this.isAvailable(check.request.currentIteration, check.ignoreLimit)) {
      return { allowed: true, maxSteps: this.maxSteps };
    }

    const maxSteps = this.maxSteps;
    if (typeof maxSteps !== 'number') {
      return { allowed: true, maxSteps };
    }
    if (this.decision?.maxSteps === maxSteps) {
      return this.recheckAfterExtension(check, await this.decision.result);
    }

    let resolveResult!: (result: WorkflowStepBudgetCheckResult) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<WorkflowStepBudgetCheckResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.decision = { maxSteps, result };
    void this.resolveDecision(check, maxSteps).then(resolveResult, rejectResult);
    return this.recheckAfterExtension(check, await result);
  }

  private recheckAfterExtension(
    check: WorkflowStepBudgetCheck,
    result: WorkflowStepBudgetCheckResult,
  ): Promise<WorkflowStepBudgetCheckResult> | WorkflowStepBudgetCheckResult {
    if (
      result.allowed
      && !this.isAvailable(check.request.currentIteration, check.ignoreLimit)
    ) {
      return this.check(check);
    }
    return result;
  }

  private async resolveDecision(
    check: WorkflowStepBudgetCheck,
    maxSteps: number,
  ): Promise<WorkflowStepBudgetCheckResult> {
    check.onLimitReached(maxSteps);
    const additionalSteps = await check.requestExtension?.({
      ...check.request,
      maxSteps,
    });
    if (additionalSteps !== undefined && additionalSteps !== null && additionalSteps > 0) {
      this.maxSteps = maxSteps + additionalSteps;
      check.onMaxStepsExtended(this.maxSteps);
      return { allowed: true, maxSteps: this.maxSteps };
    }
    return { allowed: false, maxSteps };
  }

  private isAvailable(iteration: number, ignoreLimit: boolean): boolean {
    return ignoreLimit || typeof this.maxSteps !== 'number' || iteration < this.maxSteps;
  }
}
