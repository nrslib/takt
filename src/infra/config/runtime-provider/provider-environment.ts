/**
 * Bootstrap seam that compiles the effective provider environment (issue #1136).
 *
 * Reads the fixed `runtime.yaml` locations, decides legacy vs runtime-v1 mode (failing fast on
 * a mixed configuration), and compiles the matching configuration format into the shared
 * engine-options bundle. This is the single place the bootstrap consults; the engine, runners
 * and provider SDK stay format-agnostic.
 *
 * Lives in `infra/config/runtime-provider` (not `features`) so that infra entry points such as
 * `workflowPreview` can consult it without an `infra → features` upward dependency.
 */

import { getGlobalConfigDir, getProjectConfigDir } from '../paths.js';
import {
  compileProviderEnvironment,
  type CompiledProviderEnvironment,
  type LegacyProviderEnvironmentInput,
} from './environment.js';
import { applyRuntimeProviderOverride } from './override.js';
import { resolveRuntimeProviderFileWithOrigins } from './loader.js';
import {
  determineProviderConfigMode,
  hasActiveMcpSection,
  hasActiveProviderSection,
  type ProviderConfigMode,
  type LegacyProviderSignal,
} from './mode.js';
import {
  collectLegacyProviderSignals,
  selectConfigTaktProviders,
} from './legacy-signals.js';
import {
  loadGlobalConfig,
  loadProjectConfig,
  resolveConfigValueWithSource,
  resolveProviderOptionsWithTrace,
  resolveWorkflowConfigValues,
  toProviderResolutionSource,
} from '../index.js';
import { resolveEffectiveAutoRouting } from '../../../core/workflow/auto-routing/effective-auto-routing.js';
import {
  getAllParallelSubSteps,
  type AgentWorkflowStep,
  type WorkflowConfig,
  type WorkflowStep,
} from '../../../core/models/index.js';
import type { WorkflowCallResolver, StepProviderInfo } from '../../../core/workflow/types.js';
import { getWorkflowStepKind } from '../../../core/workflow/step-kind.js';
import { countMatchedLadderStages } from '../../../core/workflow/promotion/PromotionEvaluator.js';
import {
  resolveGoverningLadder,
  resolvePromotionLadderStage,
  resolvePromotionProviderOptions,
} from '../../../core/workflow/promotion/promotion-runtime.js';
import { collectReachableWorkflowCallSteps } from '../loaders/workflowParallelTraversal.js';
import { getWorkflowSourcePath } from '../loaders/workflowSourceMetadata.js';
import { resolveStepProviderModel } from '../../../core/workflow/provider-resolution.js';
import {
  hasAutoRoutingPoolAssignment,
  resolveExecutableRoutingCandidates,
} from '../../../core/workflow/auto-routing/selector.js';
import {
  LOOP_JUDGE_ROUTING_KEY,
  loopJudgeProviderFields,
  loopJudgeStepName,
} from '../../../core/workflow/loop-judge-step.js';
import { buildCompletionRetryJudgeStep } from '../../../core/workflow/completion-retry-judge-step.js';
import {
  DEFAULT_COMPANION_FIX_POLICY,
  DEFAULT_COMPANION_REVIEW_MODE,
  type CompanionFixPolicy,
  type CompanionReviewMode,
} from '../../../core/models/companion-types.js';
import type { StepProviderOptions } from '../../../core/models/workflow-types.js';
import {
  mergeProviderOptions,
  resolveDirectStepProviderOptions,
  resolveProviderOptionsSources,
  resolveProfileScopedProviderOptionsLayers,
} from '../providerOptions.js';
import type {
  ProviderOptionsOriginResolver,
  ProviderOptionsSource,
  ProviderResolutionSource,
} from '../../../core/workflow/provider-options-trace.js';
import { getEffectiveRuntimeProviderFile } from './schema.js';
import { createRuntimeProviderResolutionContext } from './resolution-context.js';
import { DEFAULT_COMPANION_ENABLED } from '../../../shared/constants.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { resolveRuntimeProviderOptions } from './provider-options.js';
import { applyDeepSeekEnvironmentOptions } from './environment-options.js';

export interface ResolvedRuntimeEnvironment {
  providerEnvironment: CompiledProviderEnvironment;
  /** Provider options resolved from config.yaml and environment variables. */
  configProviderOptions?: StepProviderOptions;
  companionEnabled: boolean;
  companionReviewMode: CompanionReviewMode;
  companionFixPolicy: CompanionFixPolicy;
  providerConfigMode: ProviderConfigMode;
}

export interface ResolveProviderEnvironmentInput {
  /** Project root; its `.takt/runtime.yaml` overrides the global one. */
  projectCwd: string;
  /** Execution directory used for trusted relative paths from global runtime profiles. */
  executionCwd?: string;
  /** Provider engine-options the legacy path already resolved (used verbatim in legacy mode). */
  legacy: LegacyProviderEnvironmentInput;
  /** Legacy provider settings detected in the current run (for mixed-config fail-fast). */
  legacySignals: LegacyProviderSignal[];
  /** Workflow whose runtime targets may be selected during this execution. */
  workflow?: WorkflowConfig;
  /** Resolver for child workflows in the execution bundle. */
  workflowCallResolver?: WorkflowCallResolver;
  /** Resolved legacy provider options used as the runtime-mode config layer. */
  providerOptionsSource?: ProviderOptionsSource;
  /** Origin resolver for the resolved legacy provider options. */
  providerOptionsOriginResolver?: ProviderOptionsOriginResolver;
}

function collectWorkflowAgentSteps(workflow: WorkflowConfig): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  for (const step of workflow.steps) {
    if (getWorkflowStepKind(step) === 'agent') {
      steps.push(step);
    }
    if (step.parallel !== undefined) {
      for (const subStep of getAllParallelSubSteps(step.parallel)) {
        if (getWorkflowStepKind(subStep) === 'agent') {
          steps.push(subStep);
        }
      }
    }
  }
  return steps;
}

function createTeamLeaderPlanningValidationStep(step: WorkflowStep): WorkflowStep {
  const teamLeader = step.teamLeader;
  if (teamLeader === undefined) {
    throw new Error(`Step "${step.name}" has no teamLeader configuration`);
  }

  return {
    ...step,
    persona: teamLeader.persona ?? step.persona,
    personaPath: teamLeader.personaPath ?? step.personaPath,
    personaDisplayName: teamLeader.personaDisplayName ?? step.personaDisplayName,
    providerRoutingPersonaKey: teamLeader.providerRoutingPersonaKey ?? step.providerRoutingPersonaKey,
  };
}

function createTeamLeaderPartValidationStep(
  step: WorkflowStep,
  partName: string,
  partId: string,
): WorkflowStep {
  const teamLeader = step.teamLeader;
  if (teamLeader === undefined) {
    throw new Error(`Step "${step.name}" has no teamLeader configuration`);
  }

  const partPersona = teamLeader.partPersona ?? step.persona;
  return {
    ...step,
    name: partName,
    engineSynthesized: true,
    persona: partPersona,
    personaPath: teamLeader.partPersonaPath ?? step.personaPath,
    personaDisplayName: partPersona ?? step.personaDisplayName ?? `${step.name}:${partId}`,
    providerRoutingPersonaKey: teamLeader.partPersona
      ? teamLeader.partPersona
      : step.providerRoutingPersonaKey,
    tags: teamLeader.partTags ?? step.tags,
    // createPartStep does not carry the internal-only options of its parent.
    internalProviderOptions: undefined,
    internalPermissionMode: undefined,
  };
}

function collectTeamLeaderValidationSteps(
  workflow: WorkflowConfig,
  environment: CompiledProviderEnvironment,
): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  const providerRoutingStepNames = Object.keys(environment.providerRouting?.steps ?? {});
  const autoRoutingStepNames = [
    ...Object.keys(environment.autoRouting?.rules?.steps ?? {}),
    ...Object.keys(environment.autoRouting?.poolRules?.steps ?? {}),
  ];

  for (const step of collectWorkflowAgentSteps(workflow)) {
    if (step.teamLeader === undefined) {
      steps.push(step);
      continue;
    }

    // The leader dispatch uses this transformed step, not the raw Team Leader parent.
    steps.push(createTeamLeaderPlanningValidationStep(step));

    steps.push(createTeamLeaderPartValidationStep(
      step,
      `${step.name}.__takt_preflight_part__`,
      '__takt_preflight_part__',
    ));

    const partPrefix = `${step.name}.`;
    const qualifiedPartPrefix = `${workflow.name}/${partPrefix}`;
    const partNames = new Set<string>();
    for (const targetName of [...providerRoutingStepNames, ...autoRoutingStepNames]) {
      const partName = targetName.startsWith(qualifiedPartPrefix)
        ? targetName.slice(workflow.name.length + 1)
        : targetName.startsWith(partPrefix)
          ? targetName
          : undefined;
      if (partName !== undefined && partName.length > partPrefix.length) {
        partNames.add(partName);
      }
    }
    for (const partName of partNames) {
      steps.push(createTeamLeaderPartValidationStep(
        step,
        partName,
        partName.slice(partPrefix.length),
      ));
    }
  }
  return steps;
}

function workflowTargetContext(
  environment: CompiledProviderEnvironment,
  workflowName: string,
): Pick<CompiledProviderEnvironment, 'providerRouting' | 'autoRouting' | 'providerLadders'> {
  return {
    providerRouting: environment.providerRouting === undefined
      ? undefined
      : { ...environment.providerRouting, workflowName },
    autoRouting: environment.autoRouting === undefined
      ? undefined
      : { ...environment.autoRouting, workflowName },
    providerLadders: environment.providerLadders === undefined
      ? undefined
      : { ...environment.providerLadders, workflowName },
  };
}

function runtimeStepProviderOptions(
  step: WorkflowStep,
  providerSource: ProviderResolutionSource | undefined,
  environment: CompiledProviderEnvironment,
  workflowName: string,
  configProviderOptions: StepProviderOptions | undefined,
  configProviderOptionsSource: ProviderOptionsSource | undefined,
  configProviderOptionsOriginResolver: ProviderOptionsOriginResolver | undefined,
): Pick<StepProviderInfo, 'providerOptions' | 'providerOptionsSources'> {
  const { providerRouting } = workflowTargetContext(environment, workflowName);
  const profileLayers = resolveProfileScopedProviderOptionsLayers(
    step,
    {
      providerRouting,
      personaProviders: environment.personaProviders,
    },
    providerSource,
    true,
  );
  const runtimeProfileOptions = providerSource === 'runtime-v1'
    ? environment.providerOptions
    : undefined;
  const profileProviderOptions = mergeProviderOptions(
    runtimeProfileOptions,
    ...profileLayers.map((layer) => layer.options),
  );
  const directStepProviderOptions = mergeProviderOptions(
    resolveDirectStepProviderOptions(step),
    step.engineSynthesized === true && providerSource === 'step'
      ? step.internalProviderOptions
      : undefined,
  );
  const layers = runtimeProfileOptions === undefined || providerSource !== 'runtime-v1'
    ? profileLayers
    : [
        { source: 'runtime-v1' as const, options: runtimeProfileOptions },
        ...profileLayers,
      ];
  const providerOptions = mergeProviderOptions(profileProviderOptions, directStepProviderOptions);
  const providerOptionsSources = resolveProviderOptionsSources(
    directStepProviderOptions,
    layers,
    configProviderOptions,
    configProviderOptionsOriginResolver,
    configProviderOptionsSource,
  );
  return {
    ...(providerOptions === undefined ? {} : { providerOptions }),
    ...(Object.keys(providerOptionsSources).length === 0 ? {} : { providerOptionsSources }),
  };
}

interface RuntimeProviderOptionsValidationContext {
  providerOptions: StepProviderOptions | undefined;
  providerOptionsSource: ProviderOptionsSource | undefined;
  providerOptionsOriginResolver: ProviderOptionsOriginResolver | undefined;
}

function validateRuntimeStepProviderOptions(
  projectCwd: string,
  step: WorkflowStep,
  environment: CompiledProviderEnvironment,
  workflowName: string,
  config: RuntimeProviderOptionsValidationContext,
): void {
  const { providerRouting, autoRouting, providerLadders } = workflowTargetContext(
    environment,
    workflowName,
  );
  const providerInfo = resolveStepProviderModel({
    step,
    provider: environment.provider,
    providerSource: environment.providerSource,
    model: environment.model,
    modelSource: environment.modelSource,
    autoRouting,
    providerRouting,
    tagConflictPolicy: environment.tagConflictPolicy,
    personaProviders: environment.personaProviders,
  });

  if (
    providerInfo.provider === undefined
    && autoRouting !== undefined
    && hasAutoRoutingPoolAssignment(autoRouting, {
      name: step.name,
      tags: step.tags,
      personaKey: step.providerRoutingPersonaKey,
    })
  ) {
    for (const candidate of resolveExecutableRoutingCandidates(autoRouting, {
      name: step.name,
      tags: step.tags,
      personaKey: step.providerRoutingPersonaKey,
    }).candidates) {
      if (candidate.providerOptions !== undefined) {
        resolveRuntimeProviderOptions(projectCwd, candidate.providerOptions);
      }
    }
    if (autoRouting.router.providerOptions !== undefined) {
      resolveRuntimeProviderOptions(projectCwd, autoRouting.router.providerOptions);
    }
    return;
  }

  const baseProviderInfo = runtimeStepProviderOptions(
    step,
    providerInfo.providerSource,
    environment,
    workflowName,
    config.providerOptions,
    config.providerOptionsSource,
    config.providerOptionsOriginResolver,
  );
  if (baseProviderInfo.providerOptions !== undefined) {
    resolveRuntimeProviderOptions(projectCwd, baseProviderInfo.providerOptions);
  }

  const agentStep = getWorkflowStepKind(step) === 'agent'
    ? step as AgentWorkflowStep
    : undefined;
  if (agentStep?.promotion === undefined || agentStep.promotion.length === 0) {
    return;
  }
  const ladder = resolveGoverningLadder(
    providerLadders,
    agentStep,
    providerInfo.providerSource,
    environment.tagConflictPolicy,
  );
  if (ladder === undefined) {
    return;
  }

  // Every positive `at` can eventually match. Validate only stages that a configured promotion
  // can consume; if it runs past the ladder end, execution reuses the terminal stage, which is
  // already included by this bound.
  const maximumStageIndex = Math.min(
    countMatchedLadderStages(agentStep, Number.MAX_SAFE_INTEGER),
    ladder.length - 1,
  );
  for (let stageIndex = 1; stageIndex <= maximumStageIndex; stageIndex++) {
    const ladderStage = resolvePromotionLadderStage(ladder, stageIndex);
    if (ladderStage === undefined) {
      continue;
    }
    const promotedProviderOptions = resolvePromotionProviderOptions(
      baseProviderInfo,
      ladderStage.entry.providerOptions,
    );
    if (promotedProviderOptions.providerOptions !== undefined) {
      resolveRuntimeProviderOptions(projectCwd, promotedProviderOptions.providerOptions);
    }
  }
}

function validateRuntimeWorkflowProviderOptions(
  projectCwd: string,
  environment: CompiledProviderEnvironment,
  workflow: WorkflowConfig,
  workflowCallResolver: WorkflowCallResolver | undefined,
  lookupCwd: string,
  config: RuntimeProviderOptionsValidationContext,
  traversal: RuntimeWorkflowProviderOptionsTraversal = {
    active: new Set<string>(),
    completed: new Set<string>(),
  },
  invocationIdentity = canonicalJson({ root: true }),
): void {
  const validationKey = runtimeWorkflowProviderOptionsValidationKey(
    workflow,
    lookupCwd,
    invocationIdentity,
  );
  if (traversal.completed.has(validationKey)) {
    return;
  }
  if (traversal.active.has(validationKey)) {
    throw new Error(
      `Configuration error: recursive workflow_call cycle detected at workflow "${workflow.name}"`,
    );
  }
  traversal.active.add(validationKey);

  try {
    // Validate only assignments that this workflow can consume. Unselected runtime profiles stay
    // inert until a workflow target or an auxiliary seam actually chooses them.
    for (const step of collectTeamLeaderValidationSteps(workflow, environment)) {
      validateRuntimeStepProviderOptions(
        projectCwd,
        step,
        environment,
        workflow.name,
        config,
      );
      if (step.completionRetry !== undefined) {
        const judgeStep = buildCompletionRetryJudgeStep({
          reviewerStepName: step.name,
          internalAgentSeats: environment.internalAgents,
        });
        validateRuntimeStepProviderOptions(
          projectCwd,
          judgeStep,
          environment,
          workflow.name,
          config,
        );
      }
    }

    for (const monitor of workflow.loopMonitors ?? []) {
      const judgeStep = {
        name: loopJudgeStepName(monitor.cycle),
        engineSynthesized: true,
        personaDisplayName: LOOP_JUDGE_ROUTING_KEY,
        providerRoutingPersonaKey: LOOP_JUDGE_ROUTING_KEY,
        instruction: '',
        ...loopJudgeProviderFields(environment.internalAgents),
      } as WorkflowStep;
      validateRuntimeStepProviderOptions(
        projectCwd,
        judgeStep,
        environment,
        workflow.name,
        config,
      );
    }

    if (workflowCallResolver !== undefined) {
      for (const step of collectReachableWorkflowCallSteps(workflow)) {
        const childWorkflow = workflowCallResolver({
          parentWorkflow: workflow,
          step,
          projectCwd,
          lookupCwd,
        });
        if (childWorkflow === null) {
          continue;
        }
        validateRuntimeWorkflowProviderOptions(
          projectCwd,
          environment,
          childWorkflow,
          workflowCallResolver,
          lookupCwd,
          config,
          traversal,
          canonicalJson({ call: step.call, args: step.args ?? {} }),
        );
      }
    }
    traversal.completed.add(validationKey);
  } finally {
    traversal.active.delete(validationKey);
  }
}

interface RuntimeWorkflowProviderOptionsTraversal {
  active: Set<string>;
  completed: Set<string>;
}

function runtimeWorkflowProviderOptionsValidationKey(
  workflow: WorkflowConfig,
  lookupCwd: string,
  invocationIdentity: string,
): string {
  return canonicalJson({
    workflow: getWorkflowSourcePath(workflow) ?? `${lookupCwd}:${workflow.name}`,
    invocation: invocationIdentity,
  });
}

export function resolveCompiledProviderEnvironment(
  input: ResolveProviderEnvironmentInput,
): CompiledProviderEnvironment {
  return resolveRuntimeEnvironment(input).providerEnvironment;
}

export function resolveRuntimeEnvironment(
  input: ResolveProviderEnvironmentInput,
): ResolvedRuntimeEnvironment {
  const resolvedRuntimeFile = resolveRuntimeProviderFileWithOrigins({
    globalConfigDir: getGlobalConfigDir(),
    projectConfigDir: getProjectConfigDir(input.projectCwd),
  });
  const runtimeFile = resolvedRuntimeFile.runtimeFile;
  const companionEnabled = runtimeFile?.companion?.enabled ?? DEFAULT_COMPANION_ENABLED;
  const companionReviewMode = runtimeFile?.companion?.review_mode ?? DEFAULT_COMPANION_REVIEW_MODE;
  const companionFixPolicy = runtimeFile?.companion?.fix_policy ?? DEFAULT_COMPANION_FIX_POLICY;
  const runtimeFileForProviderResolution = getEffectiveRuntimeProviderFile(runtimeFile);
  const { mode } = determineProviderConfigMode({
    runtimeFile: runtimeFileForProviderResolution,
    legacyProviderSignals: input.legacySignals,
  });
  if (mode === 'legacy') {
    return {
      providerEnvironment: compileProviderEnvironment({ kind: 'legacy', legacy: input.legacy }),
      companionEnabled,
      companionReviewMode,
      companionFixPolicy,
      providerConfigMode: mode,
    };
  }
  const section = hasActiveProviderSection(runtimeFileForProviderResolution)
    ? runtimeFileForProviderResolution?.provider
    : undefined;
  const activeMcp = hasActiveMcpSection(runtimeFileForProviderResolution)
    ? runtimeFileForProviderResolution?.mcp
    : undefined;
  // Runtime-v1 mode may be entered by an active `mcp` section alone (order.md:36:
  // `mcp` is independent from `provider`). When no active `provider` section is present
  // the provider bundle carries no runtime provider/model/options, but the mcp
  // assignment still flows through `mcpAssignment` so the engine resolves
  // effective servers per agent execution.
  if (section === undefined) {
    const legacyEnvironment = compileProviderEnvironment({ kind: 'legacy', legacy: input.legacy });
    return {
      // MCP-only mode keeps the complete legacy provider environment and adds
      // only the active runtime MCP assignment (docs/configuration.md).
      providerEnvironment: { ...legacyEnvironment, mcpAssignment: activeMcp },
      configProviderOptions: input.legacy.providerOptions,
      companionEnabled,
      companionReviewMode,
      companionFixPolicy,
      providerConfigMode: mode,
    };
  }
  // The runtime-v1 bundle carries only the runtime.yaml `profiles.default`; re-apply the CLI/env
  // provider/model override the bootstrap already resolved so the main execution path honors an
  // explicit `--provider`/`--model` the same way the selector seam does.
  const providerEnvironment = applyDeepSeekEnvironmentOptions(input.projectCwd, applyRuntimeProviderOverride(
    compileProviderEnvironment({
      kind: 'runtime-v1',
      section,
      mcp: activeMcp,
      resolutionContext: createRuntimeProviderResolutionContext(
        input.projectCwd,
        resolvedRuntimeFile.profileOrigins,
        input.executionCwd,
      ),
    }),
    {
      provider: input.legacy.provider,
      providerSource: input.legacy.providerSource,
      model: input.legacy.model,
      modelSource: input.legacy.modelSource,
    },
  ));
  // Validate the runtime default profile together with explicit provider-options environment
  // overrides before workflow execution. Keep the resolved environment bundle separate from
  // configProviderOptions; the execution seam still applies that split per step.
  resolveRuntimeProviderOptions(input.projectCwd, providerEnvironment.providerOptions);
  if (input.workflow !== undefined) {
    const providerOptionsConfig: RuntimeProviderOptionsValidationContext = {
      providerOptions: input.legacy.providerOptions,
      providerOptionsSource: input.providerOptionsSource,
      providerOptionsOriginResolver: input.providerOptionsOriginResolver,
    };
    validateRuntimeWorkflowProviderOptions(
      input.projectCwd,
      providerEnvironment,
      input.workflow,
      input.workflowCallResolver,
      input.executionCwd ?? input.projectCwd,
      providerOptionsConfig,
    );
  }
  return {
    providerEnvironment,
    configProviderOptions: input.legacy.providerOptions,
    companionEnabled,
    companionReviewMode,
    companionFixPolicy,
    providerConfigMode: mode,
  };
}

/**
 * Resolve the compiled provider environment for auxiliary entry points (preview / doctor) that
 * carry no CLI or task overrides. Display and validation must resolve
 * provider/model/personaProviders/providerRouting/autoRouting through the same compiled bundle as
 * execution, so a runtime-v1 environment surfaces the runtime.yaml `profiles.default` values
 * instead of legacy defaults, and a mixed configuration fails fast at these entries too.
 */
export function resolveAuxiliaryProviderEnvironment(
  projectCwd: string,
  workflow: Pick<WorkflowConfig, 'name'>
    & Partial<Pick<WorkflowConfig, 'steps'>>,
): CompiledProviderEnvironment {
  return resolveAuxiliaryRuntimeEnvironment(projectCwd, workflow).providerEnvironment;
}

export function resolveAuxiliaryRuntimeEnvironment(
  projectCwd: string,
  _workflow: Pick<WorkflowConfig, 'name'>
    & Partial<Pick<WorkflowConfig, 'steps'>>,
): ResolvedRuntimeEnvironment {
  const resolved = resolveWorkflowConfigValues(projectCwd, [
    'personaProviders',
    'providerRouting',
    'autoRouting',
  ]);
  const provider = resolveConfigValueWithSource(projectCwd, 'provider');
  const model = resolveConfigValueWithSource(projectCwd, 'model');
  const providerOptions = resolveProviderOptionsWithTrace(projectCwd);
  const legacy: LegacyProviderEnvironmentInput = {
    provider: provider.value,
    providerSource: toProviderResolutionSource(provider.source),
    model: model.value,
    modelSource: toProviderResolutionSource(model.source),
    personaProviders: resolved.personaProviders,
    providerRouting: resolved.providerRouting,
    autoRouting: resolveEffectiveAutoRouting(resolved.autoRouting),
    providerOptions: providerOptions.value,
    taktProviders: selectConfigTaktProviders(
      loadProjectConfig(projectCwd).taktProviders,
      loadGlobalConfig().taktProviders,
    ),
  };
  return resolveRuntimeEnvironment({
    projectCwd,
    providerOptionsSource: providerOptions.source,
    providerOptionsOriginResolver: providerOptions.originResolver,
    legacy,
    legacySignals: collectLegacyProviderSignals(
      legacy,
      providerOptions.source,
      providerOptions.originResolver,
    ),
  });
}
