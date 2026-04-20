import type { WorkflowEffect, WorkflowState, WorkflowStep } from '../../models/types.js';

export interface SystemStepTaskContext {
  readonly issueNumber?: number;
  readonly runSlug?: string;
}

export interface SystemStepServicesOptions {
  readonly cwd: string;
  readonly projectCwd: string;
  readonly task: string;
  readonly taskContext?: SystemStepTaskContext;
}

export interface SystemStepServices {
  resolveSystemInput(input: NonNullable<WorkflowStep['systemInputs']>[number]): unknown;
  executeEffect(
    effect: WorkflowEffect,
    payload: Record<string, unknown>,
    state: WorkflowState,
  ): Promise<Record<string, unknown>>;
}

export type SystemStepServicesFactory = (options: SystemStepServicesOptions) => SystemStepServices;
