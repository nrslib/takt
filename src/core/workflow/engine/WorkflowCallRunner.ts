import { resolveEffectiveProviderOptions } from '../../../infra/config/providerOptions.js';
import type {
  AgentResponse,
  WorkflowConfig,
  WorkflowCallStep,
  WorkflowMaxSteps,
  WorkflowResumePointEntry,
  WorkflowState,
} from '../../models/types.js';
import type { RunPaths } from '../run/run-paths.js';
import {
  applyProviderModelOverride,
  resolveWorkflowCallProviderModel,
} from '../provider-resolution.js';
import {
  getResumePointWorkflowReference,
  getWorkflowReference,
} from '../workflow-reference.js';
import type {
  RuntimeStepResolution,
  StepProviderInfo,
  StepRunResult,
  WorkflowCallChildEngine,
  WorkflowCallResolver,
  WorkflowEngineOptions,
  WorkflowSharedRuntimeState,
} from '../types.js';
import {
  WorkflowCallExecutor,
  applyWorkflowCallOverridesToProviderRouting,
  applyWorkflowCallOverridesToPersonaProviders,
  type WorkflowCallExecutionResult,
  type WorkflowCallIsolatedStateSync,
  type WorkflowCallSessionUpdates,
} from './WorkflowCallExecutor.js';

interface WorkflowCallRunnerDeps {
  getConfig: () => WorkflowConfig;
  getMaxSteps: () => WorkflowMaxSteps;
  updateMaxSteps: (maxSteps: WorkflowMaxSteps) => void;
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
    providerSource: WorkflowEngineOptions['providerSource'];
    model: string | undefined;
    modelSource: WorkflowEngineOptions['modelSource'];
    providerOptions: WorkflowEngineOptions['providerOptions'];
  } {
    const options = this.deps.getOptions();
    const parentConfig = this.deps.getConfig();
    const providerInfo = resolveWorkflowCallProviderModel({
      workflow: parentConfig,
      provider: options.provider,
      providerSource: options.providerSource,
      model: options.model,
      modelSource: options.modelSource,
    });
    const providerOptions = resolveEffectiveProviderOptions(
      options.providerOptionsSource,
      options.providerOptionsOriginResolver,
      options.providerOptions,
      parentConfig.providerOptions,
    );

    return {
      provider: providerInfo.provider,
      providerSource: providerInfo.providerSource,
      model: providerInfo.model,
      modelSource: providerInfo.modelSource,
      providerOptions,
    };
  }

  private resolveChildProviderModel(
    step: WorkflowCallStep,
    childWorkflow: WorkflowConfig,
  ): StepProviderInfo {
    const parentProviderInfo = this.resolveParentWorkflowProviderContext();
    const childProviderInfo = resolveWorkflowCallProviderModel({
      workflow: childWorkflow,
      provider: parentProviderInfo.provider,
      providerSource: parentProviderInfo.providerSource,
      model: parentProviderInfo.model,
      modelSource: parentProviderInfo.modelSource,
    });
    if (!step.overrides) {
      return {
        provider: childProviderInfo.provider,
        providerSource: childProviderInfo.providerSource,
        model: childProviderInfo.model,
        modelSource: childProviderInfo.modelSource,
      };
    }

    return applyProviderModelOverride(childProviderInfo, {
      provider: step.overrides.provider,
      providerSpecified: step.overrides.provider !== undefined,
      model: step.overrides.model,
      modelSpecified: step.overrides.model !== undefined,
      source: 'workflow_call',
    });
  }

  resolveRuntime(step: WorkflowCallStep): RuntimeStepResolution {
    const parentProviderInfo = this.resolveParentWorkflowProviderContext();
    const workflowCallProviderModel = applyProviderModelOverride(parentProviderInfo, {
      provider: step.overrides?.provider,
      providerSpecified: step.overrides?.provider !== undefined,
      model: step.overrides?.model,
      modelSpecified: step.overrides?.model !== undefined,
      source: 'workflow_call',
    });
    return {
      providerInfo: {
        provider: workflowCallProviderModel.provider,
        providerSource: workflowCallProviderModel.providerSource,
        model: workflowCallProviderModel.model,
        modelSource: workflowCallProviderModel.modelSource,
      },
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

  private buildChildProviderRouting(
    step: WorkflowCallStep,
  ): WorkflowEngineOptions['providerRouting'] {
    return applyWorkflowCallOverridesToProviderRouting(
      this.deps.getOptions().providerRouting,
      step.overrides,
    );
  }

  private buildWorkflowCallResponse(
    step: WorkflowCallStep,
    childState: WorkflowState,
    abortKind: WorkflowCallExecutionResult['abortKind'],
    abortReason: string | undefined,
    returnValue: string | undefined,
  ): AgentResponse {
    const terminalStatus = childState.status === 'completed' ? 'COMPLETE' : 'ABORT';
    const matchedCondition = returnValue ?? terminalStatus;
    const finalContent = returnValue !== undefined
      ? childState.lastOutput?.content ?? returnValue
      : terminalStatus === 'COMPLETE'
      ? childState.lastOutput?.content ?? terminalStatus
      : abortKind === 'step_transition'
        ? childState.lastOutput?.content ?? abortReason ?? terminalStatus
        : abortReason ?? terminalStatus;
    const matchedRuleIndex = step.rules?.findIndex((rule) => rule.condition === matchedCondition);

    return {
      persona: step.name,
      status: 'done',
      content: finalContent,
      timestamp: new Date(),
      ...(matchedRuleIndex !== undefined && matchedRuleIndex >= 0 ? { matchedRuleIndex } : {}),
    };
  }

  private requireIsolatedSessionUpdates(
    step: WorkflowCallStep,
    childResult: WorkflowCallExecutionResult,
  ): WorkflowCallSessionUpdates {
    if (!childResult.sessionUpdates) {
      throw new Error(`workflow_call step "${step.name}" isolated execution did not return session updates`);
    }
    return childResult.sessionUpdates;
  }

  private requireIsolatedStateSync(
    step: WorkflowCallStep,
    childResult: WorkflowCallExecutionResult,
  ): WorkflowCallIsolatedStateSync {
    if (!childResult.isolatedStateSync) {
      throw new Error(`workflow_call step "${step.name}" isolated execution did not return state sync`);
    }
    return childResult.isolatedStateSync;
  }

  private async executeChildWorkflow(
    step: WorkflowCallStep,
    runtime: RuntimeStepResolution,
    syncParentState: boolean,
  ): Promise<{
    childResult: WorkflowCallExecutionResult;
    providerInfo: NonNullable<StepRunResult['providerInfo']>;
  }> {
    const parentConfig = this.deps.getConfig();
    const childWorkflow = this.deps.resolveWorkflowCall({
      parentWorkflow: parentConfig,
      step,
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

    const runtimeProviderInfo = runtime.providerInfo ?? this.resolveRuntime(step).providerInfo;
    if (!runtimeProviderInfo) {
      throw new Error(`workflow_call step "${step.name}" could not resolve provider context`);
    }
    const childProviderInfo = runtime.fallback
      ? runtimeProviderInfo
      : this.resolveChildProviderModel(step, childWorkflow);
    const parentProviderContext = this.resolveParentWorkflowProviderContext();
    const childResult = await this.executor.execute({
      step,
      childWorkflow,
      childProviderInfo,
      parentProviderOptions: parentProviderContext.providerOptions,
      personaProviders: this.buildChildPersonaProviders(step),
      providerRouting: this.buildChildProviderRouting(step),
    }, { syncParentState });

    return {
      childResult,
      providerInfo: runtimeProviderInfo,
    };
  }

  async run(
    step: WorkflowCallStep,
    runtime: RuntimeStepResolution = this.resolveRuntime(step),
  ): Promise<StepRunResult> {
    const { childResult, providerInfo } = await this.executeChildWorkflow(step, runtime, true);

    const response = this.buildWorkflowCallResponse(
      step,
      childResult,
      childResult.abortKind,
      childResult.abortReason,
      childResult.returnValue,
    );
    this.deps.state.stepOutputs.set(step.name, response);
    this.deps.state.lastOutput = response;
    this.deps.state.previousResponseSourcePath = undefined;
    return { response, instruction: '', providerInfo };
  }

  async runIsolated(
    step: WorkflowCallStep,
    runtime: RuntimeStepResolution = this.resolveRuntime(step),
  ): Promise<{
    result: StepRunResult;
    sessionUpdates: WorkflowCallSessionUpdates;
    stateSync: WorkflowCallIsolatedStateSync;
  }> {
    const { childResult, providerInfo } = await this.executeChildWorkflow(step, runtime, false);
    const response = this.buildWorkflowCallResponse(
      step,
      childResult,
      childResult.abortKind,
      childResult.abortReason,
      childResult.returnValue,
    );
    return {
      result: { response, instruction: '', providerInfo },
      sessionUpdates: this.requireIsolatedSessionUpdates(step, childResult),
      stateSync: this.requireIsolatedStateSync(step, childResult),
    };
  }
}
