import { join } from 'node:path';
import type { WorkflowStep, WorkflowState, Language, WorkflowResumePointEntry, McpServerConfig } from '../../models/types.js';
import type { StepProviderOptions } from '../../models/workflow-types.js';
import type { TaskReviewScope } from '../review-scope.js';
import type { RunAgentOptions } from '../../../agents/runner.js';
import type { WorkflowMeta } from '../../../agents/types.js';
import type { StructuredCaller } from '../../../agents/structured-caller.js';
import type { ReportPhaseRunnerContext, StatusJudgmentPhaseContext } from '../phase-runner.js';
import {
  resolveEffectiveProviderOptions,
  resolveEffectiveTeamLeaderPartProviderOptions,
  resolveDirectStepProviderOptions,
  resolveProfileScopedProviderOptionsLayers,
  mergeProviderOptions,
  resolveProviderOptionsSources,
  type ProviderOptionsLayer,
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
import type { ProviderType, StreamCallback } from '../../../shared/types/provider.js';
import type {
  WorkflowEngineOptions,
  PhaseName,
  StepProviderInfo,
  PhasePromptParts,
  JudgeStageEntry,
  RuntimeStepResolution,
} from '../types.js';
import type { ProviderResolutionSource } from '../provider-options-trace.js';
import { buildSessionKey } from '../session-key.js';
import { getWorkflowStepKind } from '../step-kind.js';
import { resolveStepProviderModel } from '../provider-resolution.js';
import { resolveDeterministicAutoRoutingProviderInfo, toAutoRoutingStepMetadata } from '../auto-routing/resolver.js';
import { buildPhase1WorkflowMeta } from './workflow-meta.js';

type ResolvedRunAgentOptions = RunAgentOptions & {
  resolvedProviderOptions?: StepProviderOptions;
};

function isAutoProviderOptionsSource(
  source: ProviderResolutionSource | undefined,
): source is 'auto.rules' | 'auto.dynamic' | 'auto.fallback' {
  return source === 'auto.rules'
    || source === 'auto.dynamic'
    || source === 'auto.fallback';
}

function mergeRuntimeAndDirectStepProviderOptions(
  runtime: RuntimeStepResolution,
  runtimeProviderOptions: StepProviderOptions | undefined,
  directStepProviderOptions: StepProviderOptions | undefined,
): StepProviderOptions | undefined {
  if (runtime.providerInfo?.providerSource === 'promotion') {
    return mergeProviderOptions(directStepProviderOptions, runtimeProviderOptions);
  }
  return mergeProviderOptions(runtimeProviderOptions, directStepProviderOptions);
}

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
    private readonly getTask?: () => string,
    private readonly getReviewScope?: () => TaskReviewScope,
    private readonly getFailureDir?: () => string,
    private readonly getAbortSignal: () => AbortSignal | undefined = () => this.engineOptions.abortSignal,
  ) {}

  private resolveAbortSignal(): AbortSignal | undefined {
    return this.getAbortSignal();
  }

  /**
   * 実行に使う provider/model の解決。構成レイヤー（step / persona / routing /
   * config）で provider が決まらない agent ステップは、auto_routing の
   * rules → strategy デフォルトへ決定的に補完する。実行ループの AI ルーターを
   * 通るステップは runtime.providerInfo が優先されるため補完は発動せず、
   * ルーターを通らない合成ステップもこの共通経路で
   * デフォルトまで落ちる。
   */
  resolveStepProviderModel(step: WorkflowStep, runtime?: RuntimeStepResolution): StepProviderInfo {
    const resolved = this.resolveStepProviderModelBeforeAutoRouting(step, runtime);
    const autoRouting = this.engineOptions.autoRouting;
    if (
      autoRouting === undefined
      || runtime?.providerInfo !== undefined
      || getWorkflowStepKind(step) !== 'agent'
    ) {
      return resolved;
    }
    const providerInfo = resolveDeterministicAutoRoutingProviderInfo({
      autoRouting,
      step: toAutoRoutingStepMetadata(step),
      currentProviderInfo: resolved,
    });
    return providerInfo === undefined
      ? resolved
      : this.resolveStepProviderModelBeforeAutoRouting(step, { ...runtime, providerInfo });
  }

  /**
   * auto-routing ルーターへの入力専用の解決。auto_routing 有効時、構成レイヤーで
   * 決まらない provider は undefined のまま返す（= ルーターが決める余地を残す）。
   * 実行に使う値が欲しい場合は resolveStepProviderModel を使うこと — こちらを
   * 実行経路で使うと auto_routing 有効時に provider 未解決のまま進んでしまう。
   */
  resolveStepProviderModelBeforeAutoRouting(step: WorkflowStep, runtime?: RuntimeStepResolution): StepProviderInfo {
    if (runtime?.providerInfo) {
      if (runtime.providerInfoResolution === 'fully_resolved') {
        return runtime.providerInfo;
      }
      const providerOptions = this.resolveMergedProviderOptions(step, runtime.providerInfo, runtime);
      const providerOptionsSources = this.resolveProviderOptionsSourcesForRuntime(step, runtime)
        ?? runtime.providerInfo.providerOptionsSources
        ?? this.resolveProviderOptionsSourcesForStep(step, runtime.providerInfo);
      return {
        ...runtime.providerInfo,
        ...(providerOptions !== undefined ? { providerOptions } : {}),
        ...(providerOptionsSources !== undefined ? { providerOptionsSources } : {}),
      };
    }

    const resolved = resolveStepProviderModel({
      step,
      provider: this.engineOptions.provider,
      providerSource: this.engineOptions.providerSource,
      model: this.engineOptions.model,
      modelSource: this.engineOptions.modelSource,
      autoRouting: this.engineOptions.autoRouting,
      providerRouting: this.engineOptions.providerRouting,
      tagConflictPolicy: this.engineOptions.providerRoutingTagConflictPolicy,
      personaProviders: this.engineOptions.personaProviders,
      escalation: this.engineOptions.providerEscalation,
      permissionMode: this.engineOptions.providerPermissionMode,
    });
    const providerOptions = this.resolveMergedProviderOptions(step, resolved, runtime);
    const providerOptionsSources = this.resolveProviderOptionsSourcesForStep(step, resolved);
    const permissionMode = this.isInternalProviderIdentity(step, resolved)
      ? step.internalPermissionMode ?? resolved.permissionMode
      : resolved.permissionMode;
    return {
      provider: resolved.provider,
      providerSource: resolved.providerSource,
      model: resolved.model,
      modelSource: resolved.modelSource,
      providerOptions,
      providerOptionsSources,
      ...(resolved.escalation !== undefined ? { escalation: resolved.escalation } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
    };
  }

  buildProviderStream(
    step: WorkflowStep,
    provider: ProviderType | undefined,
    providerModel: string | undefined,
    output: StreamCallback | undefined,
  ): StreamCallback | undefined {
    const onProviderStream = this.engineOptions.onProviderStream;
    if (!onProviderStream) {
      return output;
    }
    if (!provider) {
      throw new Error(`Step "${step.name}" has no resolved provider for provider event logging`);
    }
    return (event): void => {
      onProviderStream({
        step: step.name,
        provider,
        providerModel: providerModel ?? '(default)',
      }, event);
      output?.(event);
    };
  }

  private resolveProviderOptionsSourcesForStep(
    step: WorkflowStep,
    resolvedProviderInfo: Pick<StepProviderInfo, 'provider' | 'model' | 'providerSource'>,
  ) {
    const resolvedProviderSource = resolvedProviderInfo.providerSource;
    const baseProviderOptions = this.resolveProfileScopedBaseProviderOptions(resolvedProviderSource);
    const profileLayers = this.resolveProfileScopedProviderOptionLayers(step, resolvedProviderSource);
    const tracedLayers = [
      ...profileLayers,
      ...(this.engineOptions.workflowCallProviderOptions === undefined
        ? []
        : [{ source: 'workflow_call' as const, options: this.engineOptions.workflowCallProviderOptions }]),
    ];
    const providerOptionsSources = resolveProviderOptionsSources(
      this.resolveIdentityAwareDirectStepProviderOptions(step, resolvedProviderInfo),
      tracedLayers,
      baseProviderOptions,
      this.engineOptions.providerOptionsOriginResolver,
      this.engineOptions.providerOptionsSource,
    );
    return Object.keys(providerOptionsSources).length > 0
      ? providerOptionsSources
      : undefined;
  }

  private resolveProviderOptionsSourcesForRuntime(
    step: WorkflowStep,
    runtime: RuntimeStepResolution,
  ): StepProviderInfo['providerOptionsSources'] {
    const runtimeSource = runtime.providerInfo?.providerSource;
    if (!runtime.providerInfo?.providerOptions || !isAutoProviderOptionsSource(runtimeSource)) {
      return undefined;
    }
    const baseProviderOptions = this.resolveProfileScopedBaseProviderOptions(runtimeSource);
    const profileLayers = this.resolveProfileScopedProviderOptionLayers(step, runtimeSource);
    const providerOptionsSources = resolveProviderOptionsSources(
      this.resolveIdentityAwareDirectStepProviderOptions(step, runtime.providerInfo),
      [
        { source: runtimeSource, options: runtime.providerInfo.providerOptions } satisfies ProviderOptionsLayer,
        ...profileLayers,
        ...(this.engineOptions.workflowCallProviderOptions === undefined
          ? []
          : [{ source: 'workflow_call' as const, options: this.engineOptions.workflowCallProviderOptions }]),
      ],
      baseProviderOptions,
      this.engineOptions.providerOptionsOriginResolver,
      this.engineOptions.providerOptionsSource,
    );
    return Object.keys(providerOptionsSources).length > 0
      ? providerOptionsSources
      : undefined;
  }

  private resolveMergedProviderOptions(
    step: WorkflowStep,
    resolvedProviderInfo: Pick<StepProviderInfo, 'provider' | 'model' | 'providerSource'>,
    runtime?: RuntimeStepResolution,
  ): StepProviderOptions | undefined {
    if (runtime?.providerInfoResolution === 'fully_resolved') {
      return runtime.providerInfo?.providerOptions;
    }
    const middleProviderOptions = mergeProviderOptions(
      ...this.resolveProfileScopedProviderOptionLayers(
        step,
        resolvedProviderInfo.providerSource,
      ).map((layer) => layer.options),
      this.engineOptions.workflowCallProviderOptions,
    );
    const directStepProviderOptions = this.resolveIdentityAwareDirectStepProviderOptions(
      step,
      resolvedProviderInfo,
    );
    const runtimeProviderOptions = runtime?.providerInfo?.providerOptions;
    const baseProviderOptions = this.resolveProfileScopedBaseProviderOptions(
      resolvedProviderInfo.providerSource,
    );

    if (runtimeProviderOptions && !runtime.teamLeaderPart) {
      if (runtime.providerInfo?.providerSource !== 'promotion') {
        return resolveEffectiveProviderOptions(
          this.engineOptions.providerOptionsSource,
          this.engineOptions.providerOptionsOriginResolver,
          baseProviderOptions,
          directStepProviderOptions,
          mergeProviderOptions(runtimeProviderOptions, middleProviderOptions),
        );
      }
      const stepProviderOptions = mergeRuntimeAndDirectStepProviderOptions(
        runtime,
        runtimeProviderOptions,
        directStepProviderOptions,
      );
      return resolveEffectiveProviderOptions(
        this.engineOptions.providerOptionsSource,
        this.engineOptions.providerOptionsOriginResolver,
        baseProviderOptions,
        stepProviderOptions,
        middleProviderOptions,
      );
    }

    if (runtime?.teamLeaderPart) {
      const stepProviderOptions = mergeRuntimeAndDirectStepProviderOptions(
        runtime,
        runtimeProviderOptions,
        directStepProviderOptions,
      );
      return resolveEffectiveTeamLeaderPartProviderOptions(
        this.engineOptions.providerOptionsSource,
        this.engineOptions.providerOptionsOriginResolver,
        baseProviderOptions,
        stepProviderOptions,
        resolvedProviderInfo.provider,
        runtime.teamLeaderPart.partAllowedTools,
        middleProviderOptions,
      );
    }

    return resolveEffectiveProviderOptions(
      this.engineOptions.providerOptionsSource,
      this.engineOptions.providerOptionsOriginResolver,
      baseProviderOptions,
      directStepProviderOptions,
      middleProviderOptions,
    );
  }

  private resolveProfileScopedBaseProviderOptions(
    resolvedProviderSource: StepProviderInfo['providerSource'],
  ): StepProviderOptions | undefined {
    const profileSource = this.engineOptions.providerOptionsProviderSource;
    return profileSource === undefined || profileSource === resolvedProviderSource
      ? this.engineOptions.providerOptions
      : undefined;
  }

  private resolveProfileScopedProviderOptionLayers(
    step: WorkflowStep,
    resolvedProviderSource: StepProviderInfo['providerSource'],
  ): ProviderOptionsLayer[] {
    const context = {
      providerRouting: this.engineOptions.providerRouting,
      personaProviders: this.engineOptions.personaProviders,
    };
    return resolveProfileScopedProviderOptionsLayers(
      step,
      context,
      resolvedProviderSource,
      this.engineOptions.providerOptionsProviderSource !== undefined,
    );
  }

  private resolveIdentityAwareDirectStepProviderOptions(
    step: WorkflowStep,
    resolvedProviderInfo: Pick<StepProviderInfo, 'provider' | 'model' | 'providerSource'>,
  ): StepProviderOptions | undefined {
    return mergeProviderOptions(
      resolveDirectStepProviderOptions(step),
      this.isInternalProviderIdentity(step, resolvedProviderInfo)
        ? step.internalProviderOptions
        : undefined,
    );
  }

  private isInternalProviderIdentity(
    step: WorkflowStep,
    providerInfo: Pick<StepProviderInfo, 'provider' | 'model' | 'providerSource'>,
  ): boolean {
    return providerInfo.providerSource === 'step'
      && providerInfo.provider === step.provider;
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
    const providerInfo = this.resolveStepProviderModel(step, runtime);
    const { provider: resolvedProvider, model: resolvedModel } = providerInfo;

    const providerOptions = mergedProviderOptions
      ?? this.resolveMergedProviderOptions(step, providerInfo, runtime);
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
      abortSignal: this.resolveAbortSignal(),
      personaPath: step.personaPath,
      workflowBundleResourceRoot: this.engineOptions.workflowBundleResourceRoot,
      resolvedProvider,
      resolvedModel,
      ...(providerInfo.permissionMode !== undefined
          ? { permissionMode: providerInfo.permissionMode }
          : {
            permissionResolution: {
              stepName: step.name,
              requiredPermissionMode: step.requiredPermissionMode
                ?? (step.edit === true ? 'edit' : undefined),
              providerProfiles: this.engineOptions.providerProfiles,
            },
          }),
      providerOptions,
      resolvedProviderOptions: providerOptions,
      language: this.getLanguage(),
      onStream: this.buildProviderStream(step, resolvedProvider, resolvedModel, this.engineOptions.onStream),
      onPermissionRequest: this.engineOptions.onPermissionRequest,
      onAskUserQuestion: this.engineOptions.onAskUserQuestion,
      bypassPermissions: this.engineOptions.bypassPermissions,
      workflowMeta,
      childProcessEnv: this.engineOptions.childProcessEnv,
      ...(this.getFailureDir === undefined ? {} : { failureDir: this.getFailureDir() }),
    };
    return baseOptions;
  }

  /**
   * report / status phase 用の base options。capability に依存する値（outputSchema、
   * allowedTools、mcpServers）を一切載せないので、provider が未解決のままでも安全に
   * 組み立てられる。capability 検査は Phase 1 の buildAgentOptions と
   * StepExecutor の structured output 実行判定に残る。
   */
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
      workflowBundleResourceRoot: baseOptions.workflowBundleResourceRoot,
      resolvedProvider: baseOptions.resolvedProvider,
      resolvedModel: baseOptions.resolvedModel,
      providerOptions: baseOptions.providerOptions,
      resolvedProviderOptions: baseOptions.resolvedProviderOptions,
      language: baseOptions.language,
      onStream: baseOptions.onStream,
      onPermissionRequest: baseOptions.onPermissionRequest,
      onAskUserQuestion: baseOptions.onAskUserQuestion,
      workflowMeta: baseOptions.workflowMeta,
      failureDir: baseOptions.failureDir,
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
    const providerInfo = this.resolveStepProviderModel(step, runtime);
    const {
      provider: resolvedProvider,
      model: resolvedModel,
    } = providerInfo;
    const mergedProviderOptions = this.resolveMergedProviderOptions(step, providerInfo, runtime);

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
      sessionId: shouldResumeSession
        ? this.getSessionId(buildSessionKey(step, { provider: resolvedProvider, model: resolvedModel }))
        : undefined,
      allowedTools,
      mcpServers: this.resolveMcpServersForStep(step, resolvedProvider),
      outputSchema: supportsStructuredOutput === false ? undefined : step.structuredOutput?.schema,
    };
  }

  /**
   * Build RunAgentOptions for session-resume phases (Phase 2, Phase 3).
   *
   * step の `structured_output` は Phase 1 の遷移判定用であって、report phase の
   * 成果物ではない。ここで outputSchema を渡すと provider が Phase 2 でもスキーマ
   * どおりの JSON を返し、その本文がそのまま report file になる。
   */
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
    step: WorkflowStep,
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
    onProviderAttempt?: ReportPhaseRunnerContext['onProviderAttempt'],
  ): ReportPhaseRunnerContext & StatusJudgmentPhaseContext {
    const stepProvider = this.resolveStepProviderModel(step, runtime);
    return {
      cwd: this.getCwd(),
      task: this.getTask?.(),
      reviewScope: this.getReviewScope?.(),
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
      abortSignal: this.resolveAbortSignal(),
      ...(this.getFailureDir === undefined ? {} : { failureDir: this.getFailureDir() }),
      onStream: this.buildProviderStream(
        step,
        stepProvider.provider,
        stepProvider.model,
        this.engineOptions.onStream,
      ),
      structuredCaller: this.requireStructuredCaller(),
      resolveStepProviderModel: (step) => this.resolveStepProviderModel(step, runtime),
      getSessionId: (persona: string) => state.personaSessions.get(persona),
      resolveSessionKey: (step) => {
        const providerInfo = this.resolveStepProviderModel(step, runtime);
        return buildSessionKey(step, { provider: providerInfo.provider, model: providerInfo.model });
      },
      buildResumeOptions: (step, sessionId, overrides) => this.buildResumeOptions(step, sessionId, overrides, runtime),
      buildNewSessionReportOptions: (step, overrides) => this.buildNewSessionReportOptions(step, overrides, runtime),
      buildFallbackReportOptions: (step, failedPrimaryOptions, overrides) =>
        this.buildFallbackReportOptions(step, failedPrimaryOptions, overrides),
      resolveReportFallbackProviderModel: () => this.engineOptions.reportFallbackProvider,
      updatePersonaSession,
      onPhaseStart,
      onPhaseComplete,
      onJudgeStage,
      onProviderAttempt,
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
