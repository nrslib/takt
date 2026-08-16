import { resolveWorkflowCallProviderModel } from './provider-resolution.js';
import type { WorkflowEngineOptions } from './types.js';

export type WorkflowCallProviderContext = Pick<
  WorkflowEngineOptions,
  | 'provider'
  | 'providerSource'
  | 'model'
  | 'modelSource'
  | 'providerPermissionMode'
  | 'autoRouting'
  | 'personaProviders'
  | 'providerRouting'
  | 'internalAgentSeats'
>;

export type WorkflowCallProviderModel = {
  provider: WorkflowEngineOptions['provider'];
  providerSource: WorkflowEngineOptions['providerSource'];
  model: WorkflowEngineOptions['model'];
  modelSource: WorkflowEngineOptions['modelSource'];
  permissionMode?: WorkflowEngineOptions['providerPermissionMode'];
};

/** Child workflows inherit the already-resolved runtime provider context. */
export function resolveWorkflowCallChildProviderModel(
  parentContext: Pick<
    WorkflowCallProviderContext,
    | 'provider'
    | 'providerSource'
    | 'model'
    | 'modelSource'
    | 'providerPermissionMode'
  >,
): WorkflowCallProviderModel {
  const providerInfo = resolveWorkflowCallProviderModel({
    provider: parentContext.provider,
    providerSource: parentContext.providerSource,
    model: parentContext.model,
    modelSource: parentContext.modelSource,
    permissionMode: parentContext.providerPermissionMode,
  });
  return {
    provider: providerInfo.provider,
    providerSource: providerInfo.providerSource,
    model: providerInfo.model,
    modelSource: providerInfo.modelSource,
    permissionMode: providerInfo.permissionMode,
  };
}

/** A child cannot redefine runtime routing from workflow YAML. */
export function resolveWorkflowCallChildAutoRouting(
  inheritedAutoRouting: WorkflowCallProviderContext['autoRouting'],
): WorkflowCallProviderContext['autoRouting'] {
  return inheritedAutoRouting;
}
