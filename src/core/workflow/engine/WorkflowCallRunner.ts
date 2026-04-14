import { resolveEffectiveProviderOptions } from '../../../infra/config/providerOptions.js';
import type {
  AgentResponse,
  WorkflowConfig,
  WorkflowCallStep,
  WorkflowResumePointEntry,
  WorkflowState,
} from '../../models/types.js';
import type { RunPaths } from '../run/run-paths.js';
import { resolveWorkflowCallProviderModel } from '../provider-resolution.js';
import {
  getResumePointWorkflowReference,
  getWorkflowReference,
} from '../workflow-reference.js';
import type {
  RuntimeStepResolution,
  WorkflowCallChildEngine,
  WorkflowCallResolver,
  WorkflowEngineOptions,
  WorkflowSharedRuntimeState,
} from '../types.js';
import {
  WorkflowCallExecutor,
  applyWorkflowCallOverridesToPersonaProviders,
  type WorkflowCallExecutionResult,
} from './WorkflowCallExecutor.js';

interface WorkflowCallRunnerDeps {
  getConfig: () => WorkflowConfig;
  getMaxSteps: () => number;
  updateMaxSteps: (maxSteps: number) => void;
  state: WorkflowState;
  projectCwd: string;
  getCwd: () => string;
  task: string;
  getOptions: () => WorkflowEngineOptions;
  sharedRuntime: WorkflowSharedRuntimeState;
  resumeStackPrefix: WorkflowResumePointEntry[];
  runPaths: RunPaths;
  setActiveResumePoint: (step: WorkflowCallStep, iteration: number) => void;
  emit: (event: string, ...args: unknown[]) => void;
  resolveWorkflowCall: WorkflowCallResolver;
  createEngine: (
    config: WorkflowConfig,
    cwd: string,
    task: string,
    options: WorkflowEngineOptions,
  ) => WorkflowCallChildEngine;
}

export class WorkflowCallRunner {
  private readonly executor: WorkflowCallExecutor;

  constructor(private readonly deps: WorkflowCallRunnerDeps) {
    this.executor = new WorkflowCallExecutor(deps);
  }

  private resolveParentWorkflowProviderContext(): {
    provider: WorkflowEngineOptions['provider'];
    model: string | undefined;
    providerOptions: WorkflowEngineOptions['providerOptions'];
  } {
    const options = this.deps.getOptions();
    const parentConfig = this.deps.getConfig();
    const providerInfo = resolveWorkflowCallProviderModel({
      workflow: parentConfig,
      provider: this.deps.getOptions().provider,
      model: this.deps.getOptions().model,
    });
    const providerOptions = resolveEffectiveProviderOptions(
      options.providerOptionsSource,
      options.providerOptionsOriginResolver,
      options.providerOptions,
      parentConfig.providerOptions,
    );

    return {
      provider: providerInfo.provider,
      model: providerInfo.model,
      providerOptions,
    };
  }

  private resolveChildProviderModel(step: WorkflowCallStep): { provider: WorkflowEngineOptions['provider']; model: string | undefined } {
    const parentProviderInfo = this.resolveParentWorkflowProviderContext();
    if (!step.overrides) {
      return {
        provider: parentProviderInfo.provider,
        model: parentProviderInfo.model,
      };
    }

    return {
      provider: step.overrides.provider ?? parentProviderInfo.provider,
      model: step.overrides.model ?? (step.overrides.provider !== undefined ? undefined : parentProviderInfo.model),
    };
  }

  resolveRuntime(step: WorkflowCallStep): RuntimeStepResolution {
    return {
      providerInfo: this.resolveChildProviderModel(step),
    };
  }

  private buildChildPersonaProviders(
    step: WorkflowCallStep,
  ): WorkflowEngineOptions['personaProviders'] {
    return applyWorkflowCallOverridesToPersonaProviders(
      this.deps.getOptions().personaProviders,
      step.overrides,
    );
  }

  private buildWorkflowCallResponse(
    step: WorkflowCallStep,
    childState: WorkflowState,
    abortKind: WorkflowCallExecutionResult['abortKind'],
    abortReason: string | undefined,
  ): AgentResponse {
    const terminalStatus = childState.status === 'completed' ? 'COMPLETE' : 'ABORT';
    const finalContent = terminalStatus === 'COMPLETE'
      ? childState.lastOutput?.content ?? terminalStatus
      : abortKind === 'step_transition'
        ? childState.lastOutput?.content ?? abortReason ?? terminalStatus
        : abortReason ?? terminalStatus;
    const matchedRuleIndex = step.rules?.findIndex((rule) => rule.condition === terminalStatus);

    return {
      persona: step.name,
      status: 'done',
      content: finalContent,
      timestamp: new Date(),
      ...(matchedRuleIndex !== undefined && matchedRuleIndex >= 0 ? { matchedRuleIndex } : {}),
    };
  }

  async run(
    step: WorkflowCallStep,
    runtime: RuntimeStepResolution = this.resolveRuntime(step),
  ): Promise<{ response: AgentResponse; instruction: string }> {
    const parentConfig = this.deps.getConfig();
    const childWorkflow = this.deps.resolveWorkflowCall({
      parentWorkflow: parentConfig,
      identifier: step.call,
      stepName: step.name,
      projectCwd: this.deps.projectCwd,
      lookupCwd: this.deps.getCwd(),
    });
    if (!childWorkflow) {
      throw new Error(`workflow_call step "${step.name}" references unknown workflow "${step.call}"`);
    }
    if (childWorkflow.subworkflow?.callable !== true) {
      throw new Error(`workflow "${childWorkflow.name}" is not callable`);
    }

    const workflowChain = [
      ...this.deps.resumeStackPrefix.map((entry) => getResumePointWorkflowReference(entry)),
      getWorkflowReference(parentConfig),
    ];
    const childWorkflowRef = getWorkflowReference(childWorkflow);
    if (workflowChain.includes(childWorkflowRef)) {
      throw new Error(`Detected workflow_call cycle: ${[...workflowChain, childWorkflow.name].join(' -> ')}`);
    }

    const currentDepth = this.deps.resumeStackPrefix.length + 1;
    const nextDepth = currentDepth + 1;
    if (nextDepth > 5) {
      throw new Error(`workflow_call depth exceeds limit (5): ${childWorkflow.name}`);
    }

    const childProviderInfo = runtime.providerInfo ?? this.resolveRuntime(step).providerInfo;
    if (!childProviderInfo) {
      throw new Error(`workflow_call step "${step.name}" could not resolve provider context`);
    }
    const parentProviderContext = this.resolveParentWorkflowProviderContext();
    const childResult = await this.executor.execute({
      step,
      childWorkflow,
      childProviderInfo,
      parentProviderOptions: parentProviderContext.providerOptions,
      personaProviders: this.buildChildPersonaProviders(step),
    });

    const response = this.buildWorkflowCallResponse(
      step,
      childResult,
      childResult.abortKind,
      childResult.abortReason,
    );
    this.deps.state.stepOutputs.set(step.name, response);
    this.deps.state.lastOutput = response;
    this.deps.state.previousResponseSourcePath = undefined;
    return { response, instruction: '' };
  }
}
