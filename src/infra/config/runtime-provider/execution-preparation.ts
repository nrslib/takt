import type { WorkflowConfig } from '../../../core/models/index.js';
import type { LegacyProviderEnvironmentInput } from './environment.js';
import type { ProviderOptionsOriginResolver, ProviderOptionsSource, ProviderResolutionSource } from '../../../core/workflow/provider-options-trace.js';
import type { WorkflowCallResolver } from '../../../core/workflow/types.js';
import type { SelectorProviderInfo, StepProviderInfo } from '../../../core/workflow/types.js';
import type { SelectorProviderOverrides } from '../selectorProviderResolution.js';
import { loadGlobalConfig, loadProjectConfig, resolveProviderOptionsWithTrace, resolveWorkflowConfigValues } from '../index.js';
import { resolveConfigValueWithSource, toProviderResolutionSource } from '../resolveConfigValue.js';
import { resolveEffectiveAutoRouting } from '../../../core/workflow/auto-routing/effective-auto-routing.js';
import { collectLegacyProviderSignals, selectConfigTaktProviders } from './legacy-signals.js';
import { resolveRuntimeEnvironment, type ResolvedRuntimeEnvironment } from './provider-environment.js';
import { collectWorkflowExecutionProviders } from './provider-environment.js';
import { resolveWorkflowSelector } from '../workflowSelectorResolution.js';
import { resolveWorkflowCompanions } from '../workflowCompanionResolution.js';
import { resolveWorkflowCallTarget } from '../loaders/workflowCallResolver.js';
import { resolveAssistantScopedProviderModelFromConfig } from '../../../core/config/provider-resolution.js';
import { checkManagedProviders, type ConfirmManagedProvider } from '../../managed-providers/preflight.js';

export interface WorkflowProviderPreparationOptions {
  provider?: LegacyProviderEnvironmentInput['provider'];
  providerSource?: ProviderResolutionSource;
  model?: string;
  modelSource?: ProviderResolutionSource;
  personaProviders?: LegacyProviderEnvironmentInput['personaProviders'];
  providerRouting?: LegacyProviderEnvironmentInput['providerRouting'];
  providerOptions?: LegacyProviderEnvironmentInput['providerOptions'];
  providerOptionsSource?: ProviderOptionsSource;
  providerOptionsOriginResolver?: ProviderOptionsOriginResolver;
  workflowCallResolver?: WorkflowCallResolver;
  reportFallbackProvider?: StepProviderInfo;
  selectorProvider?: SelectorProviderInfo;
  selectorProviderOverrides?: SelectorProviderOverrides;
}

export async function checkWorkflowProviders(projectCwd: string, executionCwd: string, workflow: WorkflowConfig, options: WorkflowProviderPreparationOptions, confirm: ConfirmManagedProvider | undefined, signal?: AbortSignal): Promise<ResolvedRuntimeEnvironment> {
  const resolver: WorkflowCallResolver = options.workflowCallResolver ?? ((input) => resolveWorkflowCallTarget(input.parentWorkflow, input.step, input.projectCwd, input.lookupCwd));
  const preparationOptions = { ...options, workflowCallResolver: resolver };
  const resolved = prepareWorkflowProviderEnvironment(projectCwd, executionCwd, workflow, preparationOptions);
  await checkResolvedWorkflowProviders(projectCwd, executionCwd, workflow, resolved, preparationOptions, confirm, signal);
  return resolved;
}

export async function checkResolvedWorkflowProviders(projectCwd: string, executionCwd: string, workflow: WorkflowConfig, resolved: ResolvedRuntimeEnvironment, options: WorkflowProviderPreparationOptions, confirm: ConfirmManagedProvider | undefined, signal?: AbortSignal): Promise<void> {
  const fallback = options.reportFallbackProvider ?? resolveAssistantScopedProviderModelFromConfig({ local: loadProjectConfig(projectCwd), global: loadGlobalConfig() });
  const config = resolveWorkflowConfigValues(projectCwd, ['rateLimitFallback']);
  const providers = collectWorkflowExecutionProviders(projectCwd, executionCwd, workflow, resolved, {
    ...options, reportFallbackProvider: fallback.provider,
    rateLimitFallbackProviders: config.rateLimitFallback?.switchChain.map((candidate) => candidate.provider),
  });
  const selector = resolveWorkflowSelector(workflow, {
    projectCwd, lookupCwd: executionCwd, workflowCallResolver: options.workflowCallResolver,
    selectorProvider: options.selectorProvider, overrides: options.selectorProviderOverrides,
    companionEnabled: resolved.companionEnabled,
    providerEnvironment: resolved.providerEnvironment, providerConfigMode: resolved.providerConfigMode,
  });
  if (selector.applies) providers.add(selector.selectorProvider.provider);
  if (resolved.companionEnabled) {
    for (const [, companion] of resolveWorkflowCompanions(workflow, resolved.providerEnvironment, { projectCwd, lookupCwd: executionCwd, workflowCallResolver: options.workflowCallResolver })) {
      if (companion.provider !== undefined) providers.add(companion.provider);
    }
  }
  await checkManagedProviders(providers, confirm, signal);
}

export function prepareWorkflowProviderEnvironment(projectCwd: string, executionCwd: string, workflow: WorkflowConfig, options: WorkflowProviderPreparationOptions): ResolvedRuntimeEnvironment {
  const configuredProvider = resolveConfigValueWithSource(projectCwd, 'provider');
  const configuredModel = resolveConfigValueWithSource(projectCwd, 'model');
  const config = resolveWorkflowConfigValues(projectCwd, ['autoRouting', 'personaProviders', 'providerRouting']);
  const providerOptions = options.providerOptionsSource !== undefined || options.providerOptions !== undefined
    ? { value: options.providerOptions, source: options.providerOptionsSource, originResolver: options.providerOptionsOriginResolver }
    : resolveProviderOptionsWithTrace(projectCwd);
  const legacy: LegacyProviderEnvironmentInput = {
    provider: options.provider ?? configuredProvider.value,
    providerSource: options.provider !== undefined ? options.providerSource ?? 'cli' : toProviderResolutionSource(configuredProvider.source),
    model: options.model ?? configuredModel.value,
    modelSource: options.model !== undefined ? options.modelSource ?? 'cli' : toProviderResolutionSource(configuredModel.source),
    ...(options.model === undefined && configuredModel.modelProvider !== undefined ? { modelProvider: configuredModel.modelProvider } : {}),
    personaProviders: options.personaProviders ?? config.personaProviders,
    providerRouting: options.providerRouting ?? config.providerRouting,
    autoRouting: resolveEffectiveAutoRouting(config.autoRouting),
    providerOptions: providerOptions.value,
    taktProviders: selectConfigTaktProviders(loadProjectConfig(projectCwd).taktProviders, loadGlobalConfig().taktProviders),
  };
  return resolveRuntimeEnvironment({
    projectCwd, executionCwd, workflow, legacy,
    workflowCallResolver: options.workflowCallResolver,
    providerOptionsSource: providerOptions.source,
    providerOptionsOriginResolver: providerOptions.originResolver,
    legacySignals: collectLegacyProviderSignals(legacy, providerOptions.source, providerOptions.originResolver),
  });
}
