import type { WorkflowConfig } from '../../../core/models/index.js';
import type {
  ProviderPermissionProfile,
  ProviderPermissionProfiles,
  ProviderProfileName,
} from '../../../core/models/provider-profiles.js';
import {
  loadGlobalConfig,
  loadProjectConfig,
  loadWorkflowByIdentifier,
  isWorkflowPath,
  resolveWorkflowConfigValues,
} from '../../../infra/config/index.js';
import { resolveWorkflowSelector } from '../../../infra/config/workflowSelectorResolution.js';
import { resolveProviderOptionsWithTrace } from '../../../infra/config/resolveConfigValue.js';
import {
  resolveAssistantScopedProviderModelFromConfig,
} from '../../../core/config/provider-resolution.js';
import type {
  SelectorProviderInfo,
  StepProviderInfo,
  WorkflowTraceTaskMetadata,
} from '../../../core/workflow/types.js';
import { info, error } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import type { ExecuteTaskOptions, WorkflowExecutionOptions, WorkflowExecutionResult } from './types.js';
import { buildTraceTaskMetadata } from './traceTaskMetadata.js';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import type { WorkflowCallResolver } from '../../../core/workflow/types.js';
import { loadWorkflowExecutionBundle } from './workflowExecutionBundle.js';

const log = createLogger('task');

type WorkflowExecutor = (
  workflowConfig: WorkflowConfig,
  task: string,
  cwd: string,
  options: WorkflowExecutionOptions,
) => Promise<WorkflowExecutionResult>;

function cloneProviderProfile(profile: ProviderPermissionProfile): ProviderPermissionProfile {
  return {
    defaultPermissionMode: profile.defaultPermissionMode,
    ...(profile.stepPermissionOverrides
      ? { stepPermissionOverrides: { ...profile.stepPermissionOverrides } }
      : {}),
  };
}

function mergeProviderProfileOverrides(
  base: ProviderPermissionProfiles | undefined,
  overrides: ProviderPermissionProfiles | undefined,
): ProviderPermissionProfiles | undefined {
  if (!overrides) {
    return base;
  }

  const providers = new Set([
    ...Object.keys(base ?? {}),
    ...Object.keys(overrides),
  ] as ProviderProfileName[]);
  const merged: ProviderPermissionProfiles = {};

  for (const provider of providers) {
    const baseProfile = base?.[provider];
    const overrideProfile = overrides[provider];
    if (!baseProfile && overrideProfile) {
      merged[provider] = cloneProviderProfile(overrideProfile);
      continue;
    }
    if (baseProfile && !overrideProfile) {
      merged[provider] = cloneProviderProfile(baseProfile);
      continue;
    }
    if (baseProfile && overrideProfile) {
      merged[provider] = {
        defaultPermissionMode: overrideProfile.defaultPermissionMode,
        stepPermissionOverrides: {
          ...baseProfile.stepPermissionOverrides,
          ...overrideProfile.stepPermissionOverrides,
        },
      };
    }
  }

  return merged;
}

function emitMissingWorkflowFile(outputMode: ExecuteTaskOptions['outputMode'], safeWorkflowIdentifier: string): void {
  if (outputMode === 'silent') {
    return;
  }
  error(`Workflow file not found: ${safeWorkflowIdentifier}`);
}

function emitMissingWorkflow(outputMode: ExecuteTaskOptions['outputMode'], safeWorkflowIdentifier: string): void {
  if (outputMode === 'silent') {
    return;
  }
  error(`Workflow "${safeWorkflowIdentifier}" not found.`);
  info('Available workflows are searched in .takt/workflows/ and ~/.takt/workflows/.');
  info('If the same workflow name exists in multiple locations, project workflows/ take priority over user workflows/.');
  info('Specify a valid workflow when creating tasks (e.g., via "takt add").');
}

async function dispatchMissingWorkflowFailure(
  eventSink: ExecuteTaskOptions['eventSink'],
  reason: string,
): Promise<WorkflowExecutionResult> {
  await eventSink?.({
    type: 'completed',
    success: false,
    reason,
  });
  return { success: false, reason };
}

export async function executeTaskWorkflow(
  options: ExecuteTaskOptions,
  workflowExecutor: WorkflowExecutor,
): Promise<WorkflowExecutionResult> {
  const {
    task,
    cwd,
    workflowIdentifier,
    projectCwd,
    agentOverrides,
    outputMode,
    eventSink,
    onAskUserQuestion,
    mcpServers,
    interactiveUserInput,
    interactiveMetadata,
    startStep,
    retryNote,
    resumePoint,
    resumeSource,
    reportDirName,
    taskSpec,
    abortSignal,
    taskPrefix,
    taskColorIndex,
    taskDisplayLabel,
    maxStepsOverride,
    initialIterationOverride,
    currentTaskIssueNumber,
    prContext,
  } = options;
  const traceTaskMetadata = resolveTraceTaskMetadata(options);
  if (resumeSource !== undefined && resumeSource.sourceRunSlug === undefined) {
    throw new Error('Workflow resume requires a source run slug with an execution bundle');
  }
  const sourceBundle = resumeSource?.sourceRunSlug === undefined
    ? undefined
    : loadWorkflowExecutionBundle(buildRunPaths(cwd, resumeSource.sourceRunSlug));
  const workflowConfig = sourceBundle?.rootWorkflow
    ?? loadWorkflowByIdentifier(workflowIdentifier, projectCwd, { lookupCwd: cwd });
  const safeWorkflowIdentifier = sanitizeTerminalText(workflowIdentifier);

  if (!workflowConfig) {
    if (isWorkflowPath(workflowIdentifier)) {
      emitMissingWorkflowFile(outputMode, safeWorkflowIdentifier);
      return dispatchMissingWorkflowFailure(
        eventSink,
        `Workflow file not found: ${safeWorkflowIdentifier}`,
      );
    }

    emitMissingWorkflow(outputMode, safeWorkflowIdentifier);
    return dispatchMissingWorkflowFailure(
      eventSink,
      `Workflow "${safeWorkflowIdentifier}" not found.`,
    );
  }
  log.debug('Running workflow', {
    name: workflowConfig.name,
    steps: workflowConfig.steps.map((s: { name: string }) => s.name),
  });

  const config = resolveWorkflowConfigValues(projectCwd, ['language', 'personaProviders', 'providerRouting', 'providerProfiles']);
  const providerOptions = resolveProviderOptionsWithTrace(projectCwd);
  return workflowExecutor(workflowConfig, task, cwd, {
    projectCwd,
    language: config.language,
    provider: agentOverrides?.provider,
    providerSource: agentOverrides?.providerSource,
    model: agentOverrides?.model,
    modelSource: agentOverrides?.modelSource,
    autoStrategy: agentOverrides?.autoStrategy,
    reportFallbackProvider: resolveReportFallbackProviderModel(projectCwd),
    selectorProvider: resolveSelectorProvider(
      workflowConfig,
      projectCwd,
      cwd,
      agentOverrides,
      sourceBundle?.workflowCallResolver,
    ),
    outputMode,
    eventSink,
    onAskUserQuestion,
    mcpServers,
    providerOptions: providerOptions.value,
    providerOptionsSource: providerOptions.source,
    providerOptionsOriginResolver: providerOptions.originResolver,
    personaProviders: config.personaProviders,
    providerRouting: config.providerRouting,
    providerProfiles: mergeProviderProfileOverrides(config.providerProfiles, options.providerProfileOverrides),
    interactiveUserInput,
    interactiveMetadata,
    startStep,
    retryNote,
    resumePoint,
    resumeSource,
    reportDirName,
    taskSpec,
    abortSignal,
    taskPrefix,
    taskColorIndex,
    taskDisplayLabel,
    maxStepsOverride,
    initialIterationOverride,
    currentTaskIssueNumber,
    traceTaskMetadata,
    ...(prContext ? { prContext } : {}),
  });
}

function resolveReportFallbackProviderModel(projectCwd: string): StepProviderInfo | undefined {
  const project = loadProjectConfig(projectCwd);
  const global = loadGlobalConfig();
  const resolved = resolveAssistantScopedProviderModelFromConfig({
    local: {
      provider: project.provider,
      model: project.model,
      taktProviders: project.taktProviders,
    },
    global: {
      provider: global.provider,
      model: global.model,
      taktProviders: global.taktProviders,
    },
  });

  if (resolved.provider === undefined) {
    return undefined;
  }

  return {
    provider: resolved.provider,
    model: resolved.model,
  };
}

function resolveSelectorProvider(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd: string,
  overrides: ExecuteTaskOptions['agentOverrides'],
  workflowCallResolver?: WorkflowCallResolver,
): SelectorProviderInfo | undefined {
  const resolution = resolveWorkflowSelector(workflow, {
    projectCwd,
    lookupCwd,
    overrides,
    ...(workflowCallResolver === undefined ? {} : { workflowCallResolver }),
  });
  if (!resolution.applies) {
    return undefined;
  }
  const resolved = resolution.selectorProvider;
  return {
    provider: resolved.provider,
    model: resolved.model,
    providerSource: resolved.providerSource,
    modelSource: resolved.modelSource,
    providerOptions: resolved.providerOptions,
    nativeTools: resolved.nativeTools,
  };
}

function resolveTraceTaskMetadata(options: ExecuteTaskOptions): WorkflowTraceTaskMetadata | undefined {
  if (options.traceTaskMetadata && options.traceTaskContext) {
    throw new Error('Use either traceTaskMetadata or traceTaskContext, not both');
  }
  if (options.traceTaskMetadata) {
    return options.traceTaskMetadata;
  }
  if (!options.traceTaskContext) {
    return undefined;
  }
  return buildTraceTaskMetadata({
    taskContent: options.task,
    ...options.traceTaskContext,
  });
}
