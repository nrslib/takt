import { join } from 'node:path';
import type { WorkflowStep, WorkflowState, Language, WorkflowResumePointEntry, McpServerConfig } from '../../models/types.js';
import type { StepProviderOptions } from '../../models/workflow-types.js';
import type { RunAgentOptions } from '../../../agents/runner.js';
import type { WorkflowMeta } from '../../../agents/types.js';
import type { StructuredCaller } from '../../../agents/structured-caller.js';
import type { ReportPhaseRunnerContext, StatusJudgmentPhaseContext } from '../phase-runner.js';
import {
  resolveEffectiveProviderOptions,
  resolveEffectiveTeamLeaderPartProviderOptions,
  resolveDirectStepProviderOptions,
  resolveStepProviderOptionsLayers,
  mergeStepProviderOptionsLayers,
  resolveProviderOptionsSources,
} from '../../../infra/config/providerOptions.js';
import {
  assertProviderResolvedForCapabilitySensitiveOptions,
  resolveAllowedToolsForProvider,
  resolveMcpServersForProvider,
  resolveSessionMcpServersForProvider,
  resolvePartAllowedToolsForProvider,
} from './engine-provider-options.js';
import {
  providerSupportsMaxTurns,
  providerSupportsStructuredOutput,
} from '../../../infra/providers/provider-capabilities.js';
import type { ProviderType } from '../../../shared/types/provider.js';
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
import type { FindingContractInstructionContext } from '../instruction/instruction-context.js';

type ResolvedRunAgentOptions = RunAgentOptions & {
  resolvedProviderOptions?: StepProviderOptions;
};

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
    private readonly getCurrentWorkflowStack: () => WorkflowResumePointEntry[] | undefined = () => undefined,
    private readonly getFindingContractInstructionContext?: (
      step: WorkflowStep,
      includeRawFindingsSchema: boolean,
    ) => FindingContractInstructionContext | undefined,
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
      const providerOptions = this.resolveMergedProviderOptions(step, runtime.providerInfo.provider, runtime);
      const providerOptionsSources = runtime.providerInfo.providerOptionsSources
        ?? this.resolveProviderOptionsSourcesForStep(step);
      return {
        ...runtime.providerInfo,
        ...(providerOptions !== undefined ? { providerOptions } : {}),
        ...(providerOptionsSources !== undefined ? { providerOptionsSources } : {}),
      };
    }

    const engineProviderInfo = this.resolveEngineProviderModel();
    const resolved = resolveStepProviderModel({
      step,
      provider: engineProviderInfo.provider,
      providerSource: engineProviderInfo.providerSource,
      model: engineProviderInfo.model,
      modelSource: engineProviderInfo.modelSource,
      providerRouting: this.engineOptions.providerRouting,
      personaProviders: this.engineOptions.personaProviders,
    });
    const provider = resolved.provider ?? engineProviderInfo.provider;
    const modelWasResolved = resolved.modelSource !== undefined;
    const providerOptions = this.resolveMergedProviderOptions(step, provider, runtime);
    const providerOptionsSources = this.resolveProviderOptionsSourcesForStep(step);
    return {
      provider,
      providerSource: resolved.providerSource ?? engineProviderInfo.providerSource,
      model: modelWasResolved ? resolved.model : resolved.model ?? engineProviderInfo.model,
      modelSource: modelWasResolved ? resolved.modelSource : resolved.modelSource ?? engineProviderInfo.modelSource,
      providerOptions,
      providerOptionsSources,
    };
  }

  private resolveProviderOptionsSourcesForStep(step: WorkflowStep) {
    const providerOptionsSources = resolveProviderOptionsSources(
      resolveDirectStepProviderOptions(step),
      resolveStepProviderOptionsLayers(step, {
        providerRouting: this.engineOptions.providerRouting,
        personaProviders: this.engineOptions.personaProviders,
      }),
      this.engineOptions.providerOptions,
      this.engineOptions.providerOptionsOriginResolver,
      this.engineOptions.providerOptionsSource,
    );
    return Object.keys(providerOptionsSources).length > 0
      ? providerOptionsSources
      : undefined;
  }

  private resolveMergedProviderOptions(
    step: WorkflowStep,
    resolvedProvider: StepProviderInfo['provider'],
    runtime?: RuntimeStepResolution,
  ): StepProviderOptions | undefined {
    if (runtime?.providerInfo?.providerOptions && !runtime.teamLeaderPart) {
      return runtime.providerInfo.providerOptions;
    }

    const middleProviderOptions = mergeStepProviderOptionsLayers(step, {
      providerRouting: this.engineOptions.providerRouting,
      personaProviders: this.engineOptions.personaProviders,
    });

    if (runtime?.teamLeaderPart) {
      return resolveEffectiveTeamLeaderPartProviderOptions(
        this.engineOptions.providerOptionsSource,
        this.engineOptions.providerOptionsOriginResolver,
        this.engineOptions.providerOptions,
        resolveDirectStepProviderOptions(step),
        resolvedProvider,
        runtime.teamLeaderPart.partAllowedTools,
        middleProviderOptions,
      );
    }

    return resolveEffectiveProviderOptions(
      this.engineOptions.providerOptionsSource,
      this.engineOptions.providerOptionsOriginResolver,
      this.engineOptions.providerOptions,
      resolveDirectStepProviderOptions(step),
      middleProviderOptions,
    );
  }

  /** Build common RunAgentOptions shared by all phases */
  buildBaseOptions(
    step: WorkflowStep,
    mergedProviderOptions?: StepProviderOptions,
    runtime?: RuntimeStepResolution,
  ): ResolvedRunAgentOptions {
    const steps = this.getWorkflowSteps();
    const currentIndex = steps.findIndex((currentStep) => currentStep.name === step.name);
    const currentPosition = currentIndex >= 0 ? `${currentIndex + 1}/${steps.length}` : '?/?';
    const { provider: resolvedProvider, model: resolvedModel } = this.resolveStepProviderModel(step, runtime);

    const providerOptions = mergedProviderOptions
      ?? this.resolveMergedProviderOptions(step, resolvedProvider, runtime);
    const workflowMeta: WorkflowMeta = {
      workflowName: this.getWorkflowName(),
      workflowDescription: this.getWorkflowDescription(),
      currentStep: step.name,
      stepsList: steps,
      currentPosition,
    };
    const baseOptions: ResolvedRunAgentOptions = {
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
      childProcessEnv: this.engineOptions.childProcessEnv,
    };
    return baseOptions;
  }

  private buildReadonlyPhaseBaseOptions(
    step: WorkflowStep,
    mergedProviderOptions?: StepProviderOptions,
    runtime?: RuntimeStepResolution,
  ): ResolvedRunAgentOptions {
    const baseOptions = this.buildBaseOptions(step, mergedProviderOptions, runtime);
    return {
      cwd: baseOptions.cwd,
      projectCwd: baseOptions.projectCwd,
      abortSignal: baseOptions.abortSignal,
      personaPath: baseOptions.personaPath,
      resolvedProvider: baseOptions.resolvedProvider,
      resolvedModel: baseOptions.resolvedModel,
      providerOptions: baseOptions.providerOptions,
      resolvedProviderOptions: baseOptions.resolvedProviderOptions,
      language: baseOptions.language,
      onStream: baseOptions.onStream,
      onPermissionRequest: baseOptions.onPermissionRequest,
      onAskUserQuestion: baseOptions.onAskUserQuestion,
      workflowMeta: baseOptions.workflowMeta,
      childProcessEnv: baseOptions.childProcessEnv,
    };
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

  buildFindingContractInstructionContext(
    step: WorkflowStep,
    includeRawFindingsSchema: boolean,
  ): FindingContractInstructionContext | undefined {
    return this.getFindingContractInstructionContext?.(step, includeRawFindingsSchema);
  }

  private resolveSupportedMaxTurns(
    step: WorkflowStep,
    maxTurns: number | undefined,
    runtime?: RuntimeStepResolution,
  ): number | undefined {
    const { provider: resolvedProvider } = this.resolveStepProviderModel(step, runtime);
    return providerSupportsMaxTurns(resolvedProvider) === false ? undefined : maxTurns;
  }

  resolveMcpServersForStep(
    step: WorkflowStep,
    provider: ProviderType | undefined,
  ): Record<string, McpServerConfig> | undefined {
    const sessionServers = resolveSessionMcpServersForProvider(
      this.engineOptions.mcpServers,
      provider,
      step.name,
    );
    const stepServers = resolveMcpServersForProvider(step.mcpServers, provider);
    if (!sessionServers) {
      return stepServers;
    }
    if (!stepServers) {
      return sessionServers;
    }
    for (const serverName of Object.keys(sessionServers)) {
      if (Object.prototype.hasOwnProperty.call(stepServers, serverName)) {
        throw new Error(`MCP server "${serverName}" is defined by both session and step "${step.name}"`);
      }
    }
    return {
      ...sessionServers,
      ...stepServers,
    };
  }

  /** Build RunAgentOptions for Phase 1 (main execution) */
  buildAgentOptions(step: WorkflowStep, runtime?: RuntimeStepResolution): RunAgentOptions {
    const { provider: resolvedProvider } = this.resolveStepProviderModel(step, runtime);
    const mergedProviderOptions = this.resolveMergedProviderOptions(step, resolvedProvider, runtime);

    assertProviderResolvedForCapabilitySensitiveOptions(resolvedProvider, {
      stepName: step.name,
      usesStructuredOutput: step.structuredOutput !== undefined,
    });

    const hasOutputContracts = step.outputContracts !== undefined && step.outputContracts.length > 0;
    const resolvedPartAllowedTools = resolvePartAllowedToolsForProvider(
      runtime?.teamLeaderPart?.partAllowedTools,
      step.edit,
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
    const shouldResumeSession = !runtime?.fallback && step.session !== 'refresh' && this.getCwd() === this.getProjectCwd();

    const supportsStructuredOutput = providerSupportsStructuredOutput(resolvedProvider);
    const baseOptions = this.buildBaseOptions(step, mergedProviderOptions, runtime);

    return {
      ...baseOptions,
      workflowMeta: this.buildPhase1WorkflowMeta(baseOptions.workflowMeta, runtime),
      sessionId: shouldResumeSession ? this.getSessionId(buildSessionKey(step, resolvedProvider)) : undefined,
      allowedTools,
      mcpServers: this.resolveMcpServersForStep(step, resolvedProvider),
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
    const maxTurns = this.resolveSupportedMaxTurns(step, overrides.maxTurns, runtime);
    return {
      ...this.buildReadonlyPhaseBaseOptions(step, undefined, runtime),
      // Report/status phases are read-only regardless of step settings.
      permissionMode: 'readonly',
      sessionId,
      allowedTools: [],
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
  }

  /** Build RunAgentOptions for Phase 2 retry with a new session */
  buildNewSessionReportOptions(
    step: WorkflowStep,
    overrides: Pick<RunAgentOptions, 'allowedTools' | 'maxTurns'>,
    runtime?: RuntimeStepResolution,
  ): RunAgentOptions {
    const maxTurns = this.resolveSupportedMaxTurns(step, overrides.maxTurns, runtime);
    return {
      ...this.buildReadonlyPhaseBaseOptions(step, undefined, runtime),
      permissionMode: 'readonly',
      allowedTools: overrides.allowedTools,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
  }

  buildFallbackReportOptions(
    step: WorkflowStep,
    failedPrimaryOptions: RunAgentOptions,
    overrides: Pick<RunAgentOptions, 'allowedTools' | 'maxTurns'>,
  ): RunAgentOptions | undefined {
    if (this.engineOptions.reportFallbackProvider === undefined) {
      return undefined;
    }

    const fallbackRuntime: RuntimeStepResolution = {
      providerInfo: this.engineOptions.reportFallbackProvider,
    };
    const maxTurns = this.resolveSupportedMaxTurns(step, overrides.maxTurns, fallbackRuntime);
    const options: RunAgentOptions = {
      ...this.buildReadonlyPhaseBaseOptions(step, undefined, fallbackRuntime),
      permissionMode: 'readonly',
      sessionId: undefined,
      allowedTools: overrides.allowedTools,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    };

    if (!this.canUseReportFallback(failedPrimaryOptions, options)) {
      return undefined;
    }

    return options;
  }

  private canUseReportFallback(
    failedPrimaryOptions: RunAgentOptions,
    fallbackOptions: RunAgentOptions,
  ): boolean {
    return failedPrimaryOptions.resolvedProvider === 'opencode'
      && fallbackOptions.resolvedProvider !== undefined
      && fallbackOptions.resolvedProvider !== failedPrimaryOptions.resolvedProvider;
  }

  /** Build context for Phase 2/3 execution */
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
  ): ReportPhaseRunnerContext & StatusJudgmentPhaseContext {
    return {
      cwd: this.getCwd(),
      reportDir: join(this.getCwd(), this.getReportDir()),
      language: this.getLanguage(),
      interactive: this.engineOptions.interactive,
      lastResponse,
      workflowName: this.getWorkflowName(),
      observabilityRunId: this.engineOptions.observabilityRunId,
      observabilityEnabled: this.engineOptions.observability?.enabled === true,
      sanitizeObservabilityText: this.engineOptions.sanitizeObservabilityText,
      getCurrentWorkflowStack: this.getCurrentWorkflowStack,
      childProcessEnv: this.engineOptions.childProcessEnv,
      onStream: this.engineOptions.onStream,
      structuredCaller: this.requireStructuredCaller(),
      resolveStepProviderModel: (step) => this.resolveStepProviderModel(step, runtime),
      buildFindingContractInstructionContext: (step, includeRawFindingsSchema) =>
        this.buildFindingContractInstructionContext(step, includeRawFindingsSchema),
      getSessionId: (persona: string) => state.personaSessions.get(persona),
      resolveSessionKey: (step) => buildSessionKey(step, this.resolveStepProviderModel(step, runtime).provider),
      buildResumeOptions: (step, sessionId, overrides) => this.buildResumeOptions(step, sessionId, overrides, runtime),
      buildNewSessionReportOptions: (step, overrides) => this.buildNewSessionReportOptions(step, overrides, runtime),
      buildFallbackReportOptions: (step, failedPrimaryOptions, overrides) =>
        this.buildFallbackReportOptions(step, failedPrimaryOptions, overrides),
      resolveReportFallbackProviderModel: () => this.engineOptions.reportFallbackProvider,
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
