import { mergeProviderOptions } from '../../../infra/config/providerOptions.js';
import type {
  WorkflowConfig,
  WorkflowCallStep,
  WorkflowResumePointEntry,
  WorkflowState,
} from '../../models/types.js';
import type { PersonaProviderEntry } from '../../models/config-types.js';
import type { RunPaths } from '../run/run-paths.js';
import { trimResumePointStackForWorkflow } from '../run/resume-point.js';
import { buildWorkflowResumePointEntry, workflowEntryMatchesWorkflow } from '../workflow-reference.js';
import type {
  WorkflowAbortKind,
  WorkflowCallChildEngine,
  WorkflowCallResolver,
  WorkflowEngineOptions,
  WorkflowSharedRuntimeState,
} from '../types.js';

function encodeWorkflowNamespaceValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildWorkflowCallNamespaceSegment(stepName: string, workflowName: string, iteration: number): string {
  return `iteration-${iteration}--step-${encodeWorkflowNamespaceValue(stepName)}--workflow-${encodeWorkflowNamespaceValue(workflowName)}`;
}

export function applyWorkflowCallOverridesToPersonaProviders(
  personaProviders: Record<string, PersonaProviderEntry> | undefined,
  overrides: WorkflowCallStep['overrides'],
): Record<string, PersonaProviderEntry> | undefined {
  if (!personaProviders) {
    return undefined;
  }
  if (overrides?.provider === undefined && overrides?.model === undefined) {
    return personaProviders;
  }

  return Object.fromEntries(
    Object.entries(personaProviders).map(([persona, entry]) => {
      const nextEntry: PersonaProviderEntry = {
        ...(overrides.provider !== undefined
          ? { provider: overrides.provider }
          : entry.provider !== undefined
            ? { provider: entry.provider }
            : {}),
      };

      if (overrides.model !== undefined) {
        nextEntry.model = overrides.model;
      } else if (overrides.provider === undefined && entry.model !== undefined) {
        nextEntry.model = entry.model;
      }

      return [persona, nextEntry];
    }),
  );
}

interface WorkflowCallExecutorDeps {
  getConfig: () => WorkflowConfig;
  getOptions: () => WorkflowEngineOptions;
  getMaxSteps: () => number;
  updateMaxSteps: (maxSteps: number) => void;
  getCwd: () => string;
  projectCwd: string;
  task: string;
  sharedRuntime: WorkflowSharedRuntimeState;
  resumeStackPrefix: WorkflowResumePointEntry[];
  runPaths: RunPaths;
  resolveWorkflowCall: WorkflowCallResolver;
  createEngine: (
    config: WorkflowConfig,
    cwd: string,
    task: string,
    options: WorkflowEngineOptions,
  ) => WorkflowCallChildEngine;
  emit: (event: string, ...args: unknown[]) => void;
  state: {
    iteration: number;
    personaSessions: Map<string, string>;
  };
  setActiveResumePoint: (step: WorkflowCallStep, iteration: number) => void;
}

interface ExecuteWorkflowCallRequest {
  step: WorkflowCallStep;
  childWorkflow: WorkflowConfig;
  childProviderInfo: {
    provider: WorkflowEngineOptions['provider'];
    model: string | undefined;
  };
  parentProviderOptions: WorkflowEngineOptions['providerOptions'];
  personaProviders: WorkflowEngineOptions['personaProviders'];
}

export type WorkflowCallExecutionResult = WorkflowState & {
  abortKind?: WorkflowAbortKind;
  abortReason?: string;
  returnValue?: string;
};

export class WorkflowCallExecutor {
  constructor(private readonly deps: WorkflowCallExecutorDeps) {}

  private buildWorkflowCallNamespace(step: WorkflowCallStep, childWorkflow: WorkflowConfig): string[] {
    const baseNamespace = this.deps.getOptions().runPathNamespace ?? [];
    const callIteration = this.deps.state.iteration;
    if (!Number.isInteger(callIteration) || callIteration <= 0) {
      throw new Error(`workflow_call step "${step.name}" requires a positive parent iteration before creating child report namespace`);
    }

    return [
      ...baseNamespace,
      'subworkflows',
      buildWorkflowCallNamespaceSegment(step.name, childWorkflow.name, callIteration),
    ];
  }

  private resolveChildResumeStartStep(
    childWorkflow: WorkflowConfig,
    resumePoint: WorkflowEngineOptions['resumePoint'],
  ): string | undefined {
    if (!resumePoint) {
      return undefined;
    }

    const nextEntry = resumePoint.stack[this.deps.resumeStackPrefix.length + 1];
    if (!nextEntry || !workflowEntryMatchesWorkflow(nextEntry, childWorkflow)) {
      return undefined;
    }

    const targetStep = childWorkflow.steps.find((step) => step.name === nextEntry.step);
    return targetStep?.name;
  }

  private resolveChildResumePoint(
    step: WorkflowCallStep,
    childWorkflow: WorkflowConfig,
  ): WorkflowEngineOptions['resumePoint'] {
    const options = this.deps.getOptions();
    const parentConfig = this.deps.getConfig();
    return trimResumePointStackForWorkflow({
      workflow: childWorkflow,
      resumePoint: options.resumePoint,
      resumeStackPrefix: [
        ...this.deps.resumeStackPrefix,
        buildWorkflowResumePointEntry(parentConfig, step.name, 'workflow_call'),
      ],
      resolveWorkflowCall: (parentWorkflow, nestedStep) => this.deps.resolveWorkflowCall({
        parentWorkflow,
        identifier: nestedStep.call,
        stepName: nestedStep.name,
        projectCwd: this.deps.projectCwd,
        lookupCwd: this.deps.getCwd(),
      }),
    });
  }

  private relayChildEvents(childEngine: WorkflowCallChildEngine): void {
    for (const eventName of [
      'step:start',
      'step:complete',
      'step:report',
      'step:blocked',
      'step:user_input',
      'phase:start',
      'phase:complete',
      'phase:judge_stage',
      'step:loop_detected',
      'step:cycle_detected',
      'iteration:limit',
    ] as const) {
      childEngine.on(eventName, (...args) => this.deps.emit(eventName, ...args));
    }
  }

  private syncStateFromChild(step: WorkflowCallStep, childState: WorkflowState): void {
    if (this.deps.sharedRuntime.maxSteps !== undefined) {
      this.deps.updateMaxSteps(this.deps.sharedRuntime.maxSteps);
    }
    this.deps.state.iteration = childState.iteration;
    for (const [sessionKey, sessionId] of childState.personaSessions.entries()) {
      this.deps.state.personaSessions.set(sessionKey, sessionId);
    }
    this.deps.setActiveResumePoint(step, this.deps.state.iteration);
  }

  async execute(request: ExecuteWorkflowCallRequest): Promise<WorkflowCallExecutionResult> {
    const options = this.deps.getOptions();
    const parentConfig = this.deps.getConfig();
    const childResumePoint = this.resolveChildResumePoint(request.step, request.childWorkflow);
    const childEngine = this.deps.createEngine(request.childWorkflow, this.deps.getCwd(), this.deps.task, {
      ...options,
      maxStepsOverride: this.deps.sharedRuntime.maxSteps ?? this.deps.getMaxSteps(),
      initialSessions: Object.fromEntries(this.deps.state.personaSessions),
      provider: request.childProviderInfo.provider,
      model: request.childProviderInfo.model,
      providerOptions: mergeProviderOptions(
        request.parentProviderOptions,
        request.step.overrides?.providerOptions,
      ),
      personaProviders: request.personaProviders,
      startStep: this.resolveChildResumeStartStep(request.childWorkflow, childResumePoint),
      resumePoint: childResumePoint,
      initialIteration: this.deps.state.iteration,
      reportDirName: this.deps.runPaths.slug,
      runPathNamespace: this.buildWorkflowCallNamespace(request.step, request.childWorkflow),
      sharedRuntime: this.deps.sharedRuntime,
      resumeStackPrefix: [
        ...this.deps.resumeStackPrefix,
        buildWorkflowResumePointEntry(parentConfig, request.step.name, 'workflow_call'),
      ],
    });

    this.relayChildEvents(childEngine);
    const childResult = await childEngine.runWithResult();
    const childState = childResult.state;
    this.syncStateFromChild(request.step, childState);
    return {
      ...childState,
      ...(childResult.returnValue !== undefined ? { returnValue: childResult.returnValue } : {}),
      ...(childResult.abort
        ? {
            abortKind: childResult.abort.kind,
            abortReason: childResult.abort.reason,
          }
        : {}),
    };
  }
}
