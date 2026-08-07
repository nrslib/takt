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
  resolveStepProviderOptionsLayers,
  mergeStepProviderOptionsLayers,
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
import { resolveMcpAssignment, type AgentExecutionContext } from '../../../infra/config/runtime-provider/mcp-assignment.js';
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
import type {
  FindingContractInstructionContext,
  FindingContractReviewerOutputStrategy,
} from '../instruction/instruction-context.js';

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
    private readonly getFindingContractInstructionContext?: (
      step: WorkflowStep,
      reviewerOutputStrategy: FindingContractReviewerOutputStrategy | undefined,
      reviewScopeSnapshotId?: string,
      findingContractFreezeKey?: string,
    ) => FindingContractInstructionContext | undefined,
    private readonly getTask?: () => string,
    private readonly getFindingEscalationInstructionContext?: (input: {
      ownerStepNames: readonly string[];
      reviewScopeSnapshotId: string;
      findingContractFreezeKey: string;
    }) => FindingContractInstructionContext | undefined,
    private readonly getReviewScope?: () => TaskReviewScope,
  ) {}

  /**
   * 実行に使う provider/model の解決。構成レイヤー（step / persona / routing /
   * config）で provider が決まらない agent ステップは、auto_routing の
   * rules → strategy デフォルトへ決定的に補完する。実行ループの AI ルーターを
   * 通るステップは runtime.providerInfo が優先されるため補完は発動せず、
   * ルーターを通らない合成ステップ（findings-manager 等）もこの共通経路で
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
      const providerOptions = this.resolveMergedProviderOptions(step, runtime.providerInfo.provider, runtime);
      const providerOptionsSources = this.resolveProviderOptionsSourcesForRuntime(step, runtime)
        ?? runtime.providerInfo.providerOptionsSources
        ?? this.resolveProviderOptionsSourcesForStep(step);
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
    });
    const providerOptions = this.resolveMergedProviderOptions(step, resolved.provider, runtime);
    const providerOptionsSources = this.resolveProviderOptionsSourcesForStep(step);
    return {
      provider: resolved.provider,
      providerSource: resolved.providerSource,
      model: resolved.model,
      modelSource: resolved.modelSource,
      providerOptions,
      providerOptionsSources,
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

  private resolveProviderOptionsSourcesForRuntime(
    step: WorkflowStep,
    runtime: RuntimeStepResolution,
  ): StepProviderInfo['providerOptionsSources'] {
    const runtimeSource = runtime.providerInfo?.providerSource;
    if (!runtime.providerInfo?.providerOptions || !isAutoProviderOptionsSource(runtimeSource)) {
      return undefined;
    }
    const providerOptionsSources = resolveProviderOptionsSources(
      resolveDirectStepProviderOptions(step),
      [
        ...resolveStepProviderOptionsLayers(step, {
          providerRouting: this.engineOptions.providerRouting,
          personaProviders: this.engineOptions.personaProviders,
        }),
        { source: runtimeSource, options: runtime.providerInfo.providerOptions } satisfies ProviderOptionsLayer,
      ],
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
    if (runtime?.providerInfoResolution === 'fully_resolved') {
      return runtime.providerInfo?.providerOptions;
    }
    const middleProviderOptions = mergeStepProviderOptionsLayers(step, {
      providerRouting: this.engineOptions.providerRouting,
      personaProviders: this.engineOptions.personaProviders,
    });
    const directStepProviderOptions = resolveDirectStepProviderOptions(step);
    const runtimeProviderOptions = runtime?.providerInfo?.providerOptions;

    if (runtimeProviderOptions && !runtime.teamLeaderPart) {
      const stepProviderOptions = mergeRuntimeAndDirectStepProviderOptions(
        runtime,
        runtimeProviderOptions,
        directStepProviderOptions,
      );
      return resolveEffectiveProviderOptions(
        this.engineOptions.providerOptionsSource,
        this.engineOptions.providerOptionsOriginResolver,
        this.engineOptions.providerOptions,
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
        this.engineOptions.providerOptions,
        stepProviderOptions,
        resolvedProvider,
        runtime.teamLeaderPart.partAllowedTools,
        middleProviderOptions,
      );
    }

    return resolveEffectiveProviderOptions(
      this.engineOptions.providerOptionsSource,
      this.engineOptions.providerOptionsOriginResolver,
      this.engineOptions.providerOptions,
      directStepProviderOptions,
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
      workflowBundleResourceRoot: this.engineOptions.workflowBundleResourceRoot,
      resolvedProvider,
      resolvedModel,
      permissionResolution: {
        stepName: step.name,
        // edit: true はステップが編集する宣言。プロファイル解決の結果が
        // readonly でも、下限として edit を要求する（書けないのに書けと
        // 指示される構成矛盾を防ぐ）。
        requiredPermissionMode: step.requiredPermissionMode
          ?? (step.edit === true ? 'edit' : undefined),
        providerProfiles: this.engineOptions.providerProfiles,
      },
      providerOptions,
      resolvedProviderOptions: providerOptions,
      language: this.getLanguage(),
      onStream: this.buildProviderStream(step, resolvedProvider, resolvedModel, this.engineOptions.onStream),
      onPermissionRequest: this.engineOptions.onPermissionRequest,
      onAskUserQuestion: this.engineOptions.onAskUserQuestion,
      bypassPermissions: this.engineOptions.bypassPermissions,
      workflowMeta,
      childProcessEnv: this.engineOptions.childProcessEnv,
      mcpAssignment: this.engineOptions.mcpAssignment,
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
      childProcessEnv: baseOptions.childProcessEnv,
      mcpAssignment: baseOptions.mcpAssignment,
    };
  }

  private resolveReportPhaseOutputSchema(
    step: WorkflowStep,
    provider: ProviderType | undefined,
  ): RunAgentOptions['outputSchema'] {
    assertProviderResolvedForCapabilitySensitiveOptions(provider, {
      stepName: step.name,
      usesStructuredOutput: step.structuredOutput !== undefined,
    });
    return providerSupportsStructuredOutput(provider) === false
      ? undefined
      : step.structuredOutput?.schema;
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
    reviewerOutputStrategy: FindingContractReviewerOutputStrategy | undefined,
    reviewScopeSnapshotId?: string,
    findingContractFreezeKey?: string,
  ): FindingContractInstructionContext | undefined {
    return this.getFindingContractInstructionContext?.(
      step,
      reviewerOutputStrategy,
      reviewScopeSnapshotId,
      findingContractFreezeKey,
    );
  }

  /**
   * escalation slot（提示予算の最終1回）用の reviewer context。escalation reviewer が
   * 未設定、または今ラウンドに格上げ対象の anomaly が無い場合は undefined。
   */
  buildFindingEscalationInstructionContext(input: {
    ownerStepNames: readonly string[];
    reviewScopeSnapshotId: string;
    findingContractFreezeKey: string;
  }): FindingContractInstructionContext | undefined {
    return this.getFindingEscalationInstructionContext?.(input);
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
    // runtime MCP mode forbids workflow-sourced `step.mcpServers` (order.md:118,120).
    // The root-workflow bootstrap gate catches top-level steps, but sub-workflow
    // engines are constructed via `new WorkflowEngine(...)` and bypass bootstrap,
    // so this guard runs for every engine level (root + nested). Empty `mcpServers`
    // is a no-op and allowed; session-boundary `engineOptions.mcpServers` (CLI/ACP)
    // is not workflow-sourced and remains permitted.
    if (this.engineOptions.mcpAssignment !== undefined) {
      const stepMcpServers = step.mcpServers as Record<string, McpServerConfig> | undefined;
      if (stepMcpServers !== undefined && Object.keys(stepMcpServers).length > 0) {
        const workflowStack = this.getCurrentWorkflowStack();
        const workflowName = workflowStack !== undefined && workflowStack.length > 0
          ? workflowStack[workflowStack.length - 1]?.workflow_ref
          : this.getWorkflowName();
        const workflowLabel = workflowName !== undefined ? `"${workflowName}"` : '(unknown workflow)';
        throw new Error(
          `Mixed MCP configuration detected: runtime MCP mode is active, but step "${step.name}" of workflow ${workflowLabel} declares workflow-sourced mcp_servers. Remove the step mcp_servers or migrate them to mcp.targets.steps.`,
        );
      }
    }
    const runtimeServers = this.resolveRuntimeMcpServersForStep(step);
    const sessionServers = resolveSessionMcpServersForProvider(
      this.engineOptions.mcpServers,
      provider,
      step.name,
    );
    const stepServers = resolveMcpServersForProvider(step.mcpServers, provider);
    return mergeMcpServerMaps(runtimeServers, sessionServers, stepServers, step.name);
  }

  /**
   * Resolve runtime MCP assignment (runtime-v1 only) for a step. Returns
   * `undefined` when no `mcpAssignment` is configured or the resolved set is
   * empty (MCP disabled). Fail-fast on unknown server names is handled inside
   * `resolveMcpAssignment`.
   */
  private resolveRuntimeMcpServersForStep(
    step: WorkflowStep,
  ): Record<string, McpServerConfig> | undefined {
    const section = this.engineOptions.mcpAssignment;
    if (section === undefined) {
      return undefined;
    }
    const context = this.buildMcpAgentExecutionContext(step);
    const resolved = resolveMcpAssignment(section, context);
    if (!resolved.enabled) {
      return undefined;
    }
    return resolved.servers;
  }

  private buildMcpAgentExecutionContext(step: WorkflowStep): AgentExecutionContext {
    const workflowStack = this.getCurrentWorkflowStack();
    const leafWorkflowName = workflowStack !== undefined && workflowStack.length > 0
      ? workflowStack[workflowStack.length - 1]?.workflow_ref
      : this.getWorkflowName();
    const stepQualifiedName = leafWorkflowName !== undefined
      ? `${leafWorkflowName}/${step.name}`
      : step.name;
    return {
      persona: step.persona,
      tags: step.tags ?? [],
      stepQualifiedName,
      isWorkflowCallNode: getWorkflowStepKind(step) === 'workflow_call',
      isInternalAgent: false,
    };
  }

  /**
   * Compute the MCP server set identity for session key isolation. Returns
   * `undefined` when runtime MCP assignment is not configured or yields an
   * empty set; the session key then falls back to the legacy form.
   */
  private resolveMcpServerIdentityForSession(step: WorkflowStep): string | undefined {
    const section = this.engineOptions.mcpAssignment;
    if (section === undefined) {
      return undefined;
    }
    const context = this.buildMcpAgentExecutionContext(step);
    const resolved = resolveMcpAssignment(section, context);
    return resolved.enabled ? resolved.identity : undefined;
  }

  /** Build RunAgentOptions for Phase 1 (main execution) */
  buildAgentOptions(step: WorkflowStep, runtime?: RuntimeStepResolution): RunAgentOptions {
    const {
      provider: resolvedProvider,
      model: resolvedModel,
    } = this.resolveStepProviderModel(step, runtime);
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

    const mcpServers = this.resolveMcpServersForStep(step, resolvedProvider);
    const mcpServerIdentity = this.resolveMcpServerIdentityForSession(step);

    return {
      ...baseOptions,
      workflowMeta: this.buildPhase1WorkflowMeta(baseOptions.workflowMeta, runtime),
      sessionId: shouldResumeSession
        ? this.getSessionId(buildSessionKey(step, { provider: resolvedProvider, model: resolvedModel, mcpServerIdentity }))
        : undefined,
      allowedTools,
      mcpServers,
      mcpServerIdentity,
      mcpAssignment: this.engineOptions.mcpAssignment,
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
    const baseOptions = this.buildReadonlyPhaseBaseOptions(step, undefined, runtime);
    return {
      ...baseOptions,
      // Report/status phases are read-only regardless of step settings.
      permissionMode: 'readonly',
      sessionId,
      allowedTools: [],
      outputSchema: this.resolveReportPhaseOutputSchema(step, baseOptions.resolvedProvider),
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
    const baseOptions = this.buildReadonlyPhaseBaseOptions(step, undefined, runtime);
    return {
      ...baseOptions,
      permissionMode: 'readonly',
      allowedTools: overrides.allowedTools,
      outputSchema: this.resolveReportPhaseOutputSchema(step, baseOptions.resolvedProvider),
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
    const baseOptions = this.buildReadonlyPhaseBaseOptions(step, undefined, fallbackRuntime);
    const options: RunAgentOptions = {
      ...baseOptions,
      permissionMode: 'readonly',
      sessionId: undefined,
      allowedTools: overrides.allowedTools,
      outputSchema: this.resolveReportPhaseOutputSchema(step, baseOptions.resolvedProvider),
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
      abortSignal: this.engineOptions.abortSignal,
      onStream: this.buildProviderStream(
        step,
        stepProvider.provider,
        stepProvider.model,
        this.engineOptions.onStream,
      ),
      structuredCaller: this.requireStructuredCaller(),
      resolveStepProviderModel: (step) => this.resolveStepProviderModel(step, runtime),
      buildFindingContractInstructionContext: (step, reviewerOutputStrategy) =>
        this.buildFindingContractInstructionContext(
          step,
          reviewerOutputStrategy,
        ),
      getSessionId: (persona: string) => state.personaSessions.get(persona),
      resolveSessionKey: (step) => {
        const providerInfo = this.resolveStepProviderModel(step, runtime);
        return buildSessionKey(step, {
          provider: providerInfo.provider,
          model: providerInfo.model,
          mcpServerIdentity: this.resolveMcpServerIdentityForSession(step),
        });
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

/**
 * Merge runtime, session, and step MCP server maps. Conflicts between any two
 * layers fail fast so the user sees a deterministic error instead of a silent
 * override (order.md:115-118). `undefined` layers are skipped.
 */
function mergeMcpServerMaps(
  runtime: Record<string, McpServerConfig> | undefined,
  session: Record<string, McpServerConfig> | undefined,
  step: Record<string, McpServerConfig> | undefined,
  stepName: string,
): Record<string, McpServerConfig> | undefined {
  if (runtime === undefined && session === undefined && step === undefined) {
    return undefined;
  }
  const merged: Record<string, McpServerConfig> = {};
  for (const [label, map] of [
    ['runtime', runtime],
    ['session', session],
    ['step', step],
  ] as const) {
    if (map === undefined) {
      continue;
    }
    for (const serverName of Object.keys(map)) {
      if (Object.prototype.hasOwnProperty.call(merged, serverName)) {
        throw new Error(`MCP server "${serverName}" is defined by both ${label} and another source for step "${stepName}"`);
      }
      const server = map[serverName];
      if (server !== undefined) {
        merged[serverName] = server;
      }
    }
  }
  return merged;
}
