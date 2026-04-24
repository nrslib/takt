import { join } from 'node:path';
import type { WorkflowStep, WorkflowState, Language } from '../../models/types.js';
import type { StepProviderOptions } from '../../models/workflow-types.js';
import type { RunAgentOptions } from '../../../agents/runner.js';
import type { WorkflowMeta } from '../../../agents/types.js';
import type { StructuredCaller } from '../../../agents/structured-caller.js';
import type { PhaseRunnerContext } from '../phase-runner.js';
import {
  resolveEffectiveProviderOptions,
  resolveEffectiveTeamLeaderPartProviderOptions,
  resolvePersonaProviderOptions,
} from '../../../infra/config/providerOptions.js';
import {
  assertProviderResolvedForCapabilitySensitiveOptions,
  resolveAllowedToolsForProvider,
  resolveMcpServersForProvider,
  resolvePartAllowedToolsForProvider,
} from './engine-provider-options.js';
import { providerSupportsStructuredOutput } from '../../../infra/providers/provider-capabilities.js';
import type {
  WorkflowEngineOptions,
  PhaseName,
  StepProviderInfo,
  PhasePromptParts,
  JudgeStageEntry,
  RuntimeStepResolution,
} from '../types.js';
import { buildSessionKey } from '../session-key.js';
import { resolveStepProviderModel } from '../provider-resolution.js';
import { buildPhase1WorkflowMeta } from './workflow-meta.js';

export class OptionsBuilder {
  constructor(
    private readonly engineOptions: WorkflowEngineOptions,
    private readonly getCwd: () => string,
    private readonly getProjectCwd: () => string,
    private readonly getSessionId: (persona: string) => string | undefined,
    private readonly getReportDir: () => string,
    private readonly getLanguage: () => Language | undefined,
    private readonly getWorkflowSteps: () => ReadonlyArray<{ name: string; description?: string }>,
    private readonly getWorkflowName: () => string,
    private readonly getWorkflowDescription: () => string | undefined,
  ) {}

  private resolveEngineProviderModel(): StepProviderInfo {
    return {
      provider: this.engineOptions.provider,
      providerSource: this.engineOptions.providerSource,
      model: this.engineOptions.model,
      modelSource: this.engineOptions.modelSource,
    };
  }

  resolveStepProviderModel(step: WorkflowStep, runtime?: RuntimeStepResolution): StepProviderInfo {
    if (runtime?.providerInfo) {
      return runtime.providerInfo;
    }

    const engineProviderInfo = this.resolveEngineProviderModel();
    const resolved = resolveStepProviderModel({
      step,
      provider: engineProviderInfo.provider,
      providerSource: engineProviderInfo.providerSource,
      model: engineProviderInfo.model,
      modelSource: engineProviderInfo.modelSource,
      personaProviders: this.engineOptions.personaProviders,
    });
    return {
      provider: resolved.provider ?? engineProviderInfo.provider,
      providerSource: resolved.providerSource ?? engineProviderInfo.providerSource,
      model: resolved.model ?? engineProviderInfo.model,
      modelSource: resolved.modelSource ?? engineProviderInfo.modelSource,
    };
  }

  private resolveMergedProviderOptions(
    step: WorkflowStep,
    runtime?: RuntimeStepResolution,
  ): StepProviderOptions | undefined {
    const personaProviderOptions = resolvePersonaProviderOptions(
      this.engineOptions.personaProviders,
      step.personaDisplayName,
    );

    if (runtime?.teamLeaderPart) {
      return resolveEffectiveTeamLeaderPartProviderOptions(
        this.engineOptions.providerOptionsSource,
        this.engineOptions.providerOptionsOriginResolver,
        this.engineOptions.providerOptions,
        step.providerOptions,
        this.resolveStepProviderModel(step, runtime).provider,
        runtime.teamLeaderPart.partAllowedTools,
        personaProviderOptions,
      );
    }

    return resolveEffectiveProviderOptions(
      this.engineOptions.providerOptionsSource,
      this.engineOptions.providerOptionsOriginResolver,
      this.engineOptions.providerOptions,
      step.providerOptions,
      personaProviderOptions,
    );
  }

  /** Build common RunAgentOptions shared by all phases */
  buildBaseOptions(
    step: WorkflowStep,
    mergedProviderOptions?: StepProviderOptions,
    runtime?: RuntimeStepResolution,
  ): RunAgentOptions {
    const steps = this.getWorkflowSteps();
    const currentIndex = steps.findIndex((currentStep) => currentStep.name === step.name);
    const currentPosition = currentIndex >= 0 ? `${currentIndex + 1}/${steps.length}` : '?/?';
    const { provider: resolvedProvider, model: resolvedModel } = this.resolveStepProviderModel(step, runtime);

    const providerOptions = mergedProviderOptions ?? this.resolveMergedProviderOptions(step, runtime);
    const workflowMeta: WorkflowMeta = {
      workflowName: this.getWorkflowName(),
      workflowDescription: this.getWorkflowDescription(),
      currentStep: step.name,
      stepsList: steps,
      currentPosition,
    };
    const baseOptions: RunAgentOptions & { resolvedProviderOptions?: StepProviderOptions } = {
      cwd: this.getCwd(),
      projectCwd: this.getProjectCwd(),
      abortSignal: this.engineOptions.abortSignal,
      personaPath: step.personaPath,
      resolvedProvider,
      resolvedModel,
      permissionResolution: {
        stepName: step.name,
        requiredPermissionMode: step.requiredPermissionMode,
        providerProfiles: this.engineOptions.providerProfiles,
      },
      providerOptions,
      resolvedProviderOptions: providerOptions,
      language: this.getLanguage(),
      onStream: this.engineOptions.onStream,
      onPermissionRequest: this.engineOptions.onPermissionRequest,
      onAskUserQuestion: this.engineOptions.onAskUserQuestion,
      bypassPermissions: this.engineOptions.bypassPermissions,
      workflowMeta,
    };
    return baseOptions;
  }

  buildPhase1WorkflowMeta(
    workflowMeta: WorkflowMeta | undefined,
    runtime?: RuntimeStepResolution,
  ): WorkflowMeta | undefined {
    if (!workflowMeta) {
      return undefined;
    }

    const processSafety = runtime?.teamLeaderPart?.processSafety
      ?? this.engineOptions.phase1ProcessSafetyByStep?.[workflowMeta.currentStep];
    return buildPhase1WorkflowMeta(workflowMeta, processSafety);
  }

  /** Build RunAgentOptions for Phase 1 (main execution) */
  buildAgentOptions(step: WorkflowStep, runtime?: RuntimeStepResolution): RunAgentOptions {
    const mergedProviderOptions = this.resolveMergedProviderOptions(step, runtime);
    const { provider: resolvedProvider } = this.resolveStepProviderModel(step, runtime);

    assertProviderResolvedForCapabilitySensitiveOptions(resolvedProvider, {
      stepName: step.name,
      usesStructuredOutput: step.structuredOutput !== undefined,
    });

    const hasOutputContracts = step.outputContracts !== undefined && step.outputContracts.length > 0;
    const resolvedPartAllowedTools = resolvePartAllowedToolsForProvider(
      runtime?.teamLeaderPart?.partAllowedTools,
      resolvedProvider,
    );
    const allowedTools = resolvedPartAllowedTools
      ?? resolveAllowedToolsForProvider(
        mergedProviderOptions,
        hasOutputContracts,
        step.edit,
        resolvedProvider,
      );

    // Skip session resume when cwd !== projectCwd (worktree execution) to avoid cross-directory contamination
    const shouldResumeSession = step.session !== 'refresh' && this.getCwd() === this.getProjectCwd();

    const supportsStructuredOutput = providerSupportsStructuredOutput(resolvedProvider);
    const baseOptions = this.buildBaseOptions(step, mergedProviderOptions, runtime);

    return {
      ...baseOptions,
      workflowMeta: this.buildPhase1WorkflowMeta(baseOptions.workflowMeta, runtime),
      sessionId: shouldResumeSession ? this.getSessionId(buildSessionKey(step, runtime?.providerInfo?.provider)) : undefined,
      allowedTools,
      mcpServers: resolveMcpServersForProvider(step.mcpServers, resolvedProvider),
      outputSchema: supportsStructuredOutput === false ? undefined : step.structuredOutput?.schema,
    };
  }

  /** Build RunAgentOptions for session-resume phases (Phase 2, Phase 3) */
  buildResumeOptions(
    step: WorkflowStep,
    sessionId: string,
    overrides: Pick<RunAgentOptions, 'maxTurns'>,
    runtime?: RuntimeStepResolution,
  ): RunAgentOptions {
    return {
      ...this.buildBaseOptions(step, undefined, runtime),
      // Report/status phases are read-only regardless of step settings.
      permissionMode: 'readonly',
      sessionId,
      allowedTools: [],
      maxTurns: overrides.maxTurns,
    };
  }

  /** Build RunAgentOptions for Phase 2 retry with a new session */
  buildNewSessionReportOptions(
    step: WorkflowStep,
    overrides: Pick<RunAgentOptions, 'allowedTools' | 'maxTurns'>,
    runtime?: RuntimeStepResolution,
  ): RunAgentOptions {
    return {
      ...this.buildBaseOptions(step, undefined, runtime),
      permissionMode: 'readonly',
      allowedTools: overrides.allowedTools,
      maxTurns: overrides.maxTurns,
    };
  }

  /** Build PhaseRunnerContext for Phase 2/3 execution */
  buildPhaseRunnerContext(
    state: WorkflowState,
    lastResponse: string | undefined,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
    onPhaseStart?: (
      step: WorkflowStep,
      phase: 1 | 2 | 3,
      phaseName: PhaseName,
      instruction: string,
      promptParts: PhasePromptParts,
      phaseExecutionId?: string,
      iteration?: number,
    ) => void,
    onPhaseComplete?: (
      step: WorkflowStep,
      phase: 1 | 2 | 3,
      phaseName: PhaseName,
      content: string,
      status: string,
      error?: string,
      phaseExecutionId?: string,
      iteration?: number,
    ) => void,
    onJudgeStage?: (
      step: WorkflowStep,
      phase: 3,
      phaseName: 'judge',
      entry: JudgeStageEntry,
      phaseExecutionId?: string,
      iteration?: number,
    ) => void,
    iteration?: number,
    runtime?: RuntimeStepResolution,
  ): PhaseRunnerContext {
    return {
      cwd: this.getCwd(),
      reportDir: join(this.getCwd(), this.getReportDir()),
      language: this.getLanguage(),
      interactive: this.engineOptions.interactive,
      lastResponse,
      onStream: this.engineOptions.onStream,
      structuredCaller: this.requireStructuredCaller(),
      resolveProvider: (step) => this.resolveStepProviderModel(step, runtime).provider,
      resolveStepProviderModel: (step) => this.resolveStepProviderModel(step, runtime),
      getSessionId: (persona: string) => state.personaSessions.get(persona),
      buildResumeOptions: (step, sessionId, overrides) => this.buildResumeOptions(step, sessionId, overrides, runtime),
      buildNewSessionReportOptions: (step, overrides) => this.buildNewSessionReportOptions(step, overrides, runtime),
      updatePersonaSession,
      onPhaseStart,
      onPhaseComplete,
      onJudgeStage,
      iteration,
    };
  }

  private requireStructuredCaller(): StructuredCaller {
    if (!this.engineOptions.structuredCaller) {
      throw new Error('structuredCaller is required for phase runner context');
    }

    return this.engineOptions.structuredCaller;
  }
}
