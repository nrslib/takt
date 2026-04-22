import type { WorkflowEffect, WorkflowState, WorkflowStep } from '../../models/types.js';

export interface SystemStepTaskContext {
  readonly issueNumber?: number;
  readonly runSlug?: string;
}

export interface SystemStepRuntimeState {
  readonly cache: Map<string, unknown>;
  readonly cleanupHandlers: Set<() => void>;
}

export interface SystemStepServicesOptions {
  readonly cwd: string;
  readonly projectCwd: string;
  readonly task: string;
  readonly taskContext?: SystemStepTaskContext;
  readonly runtimeState?: SystemStepRuntimeState;
}

export interface SystemStepInputResolutionContext {
  readonly cache: Map<string, unknown>;
}

export interface SystemStepServices {
  resolveSystemInput(
    input: NonNullable<WorkflowStep['systemInputs']>[number],
    state?: WorkflowState,
    stepName?: string,
    resolutionContext?: SystemStepInputResolutionContext,
  ): unknown;
  executeEffect(
    effect: WorkflowEffect,
    payload: Record<string, unknown>,
    state: WorkflowState,
  ): Promise<Record<string, unknown>>;
}

export type SystemStepServicesFactory = (options: SystemStepServicesOptions) => SystemStepServices;
