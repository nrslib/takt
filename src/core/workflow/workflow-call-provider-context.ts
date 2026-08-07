import type {
  PersonaProviderEntry,
  ProviderRoutingConfig,
  ProviderRoutingEntry,
} from '../models/config-types.js';
import type { WorkflowConfig, WorkflowCallStep } from '../models/types.js';
import { resolveEffectiveAutoRouting } from './auto-routing/effective-auto-routing.js';
import {
  applyProviderModelOverride,
  resolveWorkflowCallProviderModel,
} from './provider-resolution.js';
import { getProviderValidationErrorSource } from './provider-validation-error.js';
import type { WorkflowEngineOptions } from './types.js';

export type WorkflowCallProviderContext = Pick<
  WorkflowEngineOptions,
  | 'provider'
  | 'providerSource'
  | 'model'
  | 'modelSource'
  | 'providerEscalation'
  | 'autoRouting'
  | 'personaProviders'
  | 'providerRouting'
  | 'intakeNormalizerProvider'
>;

export type WorkflowCallProviderModel = {
  provider: WorkflowEngineOptions['provider'];
  providerSource: WorkflowEngineOptions['providerSource'];
  model: WorkflowEngineOptions['model'];
  modelSource: WorkflowEngineOptions['modelSource'];
  providerEscalation: WorkflowEngineOptions['providerEscalation'];
};

export function getWorkflowCallOverrideErrorPath(
  step: WorkflowCallStep,
  error: unknown,
): readonly PropertyKey[] | undefined {
  if (!step.overrides) {
    return undefined;
  }
  const validationSource = getProviderValidationErrorSource(error);
  if (validationSource?.source !== 'workflow_call') {
    return undefined;
  }
  if (validationSource.field === 'model' && step.overrides.model !== undefined) {
    return ['overrides', 'model'];
  }
  if (validationSource.field === 'provider' && step.overrides.provider !== undefined) {
    return ['overrides', 'provider'];
  }
  return undefined;
}

function applyWorkflowCallOverridesToProviderEntries<T extends PersonaProviderEntry>(
  entries: Record<string, T> | undefined,
  overrides: WorkflowCallStep['overrides'],
): Record<string, T> | undefined {
  if (!entries) {
    return undefined;
  }
  if (overrides?.provider === undefined && overrides?.model === undefined) {
    return entries;
  }

  const overrideProvider = overrides.provider;
  return Object.fromEntries(
    Object.entries(entries).map(([key, entry]) => {
      const nextEntry: T = {
        ...(overrideProvider !== undefined
          ? { provider: overrideProvider }
          : entry.provider !== undefined
            ? { provider: entry.provider }
            : {}),
      } as T;

      if (overrides.model !== undefined) {
        nextEntry.model = overrides.model;
      } else if (overrideProvider === undefined && entry.model !== undefined) {
        nextEntry.model = entry.model;
      }
      if (entry.providerOptions !== undefined) {
        nextEntry.providerOptions = entry.providerOptions;
      }
      // escalate 先は provider を供給した profile のもの。provider を上書きしたら
      // その entry はもう元の profile ではないので落とし、model だけの上書きなら
      // provider は profile 由来のままなので維持する。
      if (overrideProvider === undefined && entry.escalation !== undefined) {
        nextEntry.escalation = entry.escalation;
      }

      return [key, nextEntry];
    }),
  );
}

export function applyWorkflowCallOverridesToPersonaProviders(
  personaProviders: Record<string, PersonaProviderEntry> | undefined,
  overrides: WorkflowCallStep['overrides'],
): Record<string, PersonaProviderEntry> | undefined {
  return applyWorkflowCallOverridesToProviderEntries(personaProviders, overrides);
}

export function applyWorkflowCallOverridesToProviderRouting(
  providerRouting: ProviderRoutingConfig | undefined,
  overrides: WorkflowCallStep['overrides'],
): ProviderRoutingConfig | undefined {
  if (!providerRouting) {
    return undefined;
  }
  if (overrides?.provider === undefined && overrides?.model === undefined) {
    return providerRouting;
  }

  return {
    personas: applyWorkflowCallOverridesToProviderEntries<ProviderRoutingEntry>(providerRouting.personas, overrides),
    tags: applyWorkflowCallOverridesToProviderEntries<ProviderRoutingEntry>(providerRouting.tags, overrides),
    steps: applyWorkflowCallOverridesToProviderEntries<ProviderRoutingEntry>(providerRouting.steps, overrides),
  };
}

export function resolveWorkflowCallChildProviderModel(
  childWorkflow: WorkflowConfig,
  overrides: WorkflowCallStep['overrides'],
  parentContext: Pick<
    WorkflowCallProviderContext,
    'provider' | 'providerSource' | 'model' | 'modelSource' | 'providerEscalation'
  >,
): WorkflowCallProviderModel {
  const childProviderInfo = resolveWorkflowCallProviderModel({
    workflow: childWorkflow,
    provider: parentContext.provider,
    providerSource: parentContext.providerSource,
    model: parentContext.model,
    modelSource: parentContext.modelSource,
  });
  const resolved = applyProviderModelOverride(childProviderInfo, {
    provider: overrides?.provider,
    providerSpecified: overrides?.provider !== undefined,
    model: overrides?.model,
    modelSpecified: overrides?.model !== undefined,
    source: 'workflow_call',
  });
  // 親の escalate 先は「親の provider を供給した profile」のもの。子の
  // workflow provider 宣言や overrides.provider で provider の出所が変われば
  // その profile ではなくなるので落とす。model だけの上書きは provider の出所を
  // 変えないので維持する。
  const providerEscalation = resolved.providerSource === parentContext.providerSource
    ? parentContext.providerEscalation
    : undefined;
  return {
    provider: resolved.provider,
    providerSource: resolved.providerSource,
    model: resolved.model,
    modelSource: resolved.modelSource,
    providerEscalation,
  };
}

export function resolveWorkflowCallChildAutoRouting(
  childWorkflow: WorkflowConfig,
  inheritedAutoRouting: WorkflowCallProviderContext['autoRouting'],
): WorkflowCallProviderContext['autoRouting'] {
  return resolveEffectiveAutoRouting(childWorkflow, inheritedAutoRouting);
}

export function resolveWorkflowCallChildProviderContext(
  childWorkflow: WorkflowConfig,
  step: WorkflowCallStep,
  parentContext: WorkflowCallProviderContext,
): WorkflowCallProviderContext {
  return {
    ...resolveWorkflowCallChildProviderModel(childWorkflow, step.overrides, parentContext),
    autoRouting: resolveWorkflowCallChildAutoRouting(childWorkflow, parentContext.autoRouting),
    personaProviders: applyWorkflowCallOverridesToPersonaProviders(
      parentContext.personaProviders,
      step.overrides,
    ),
    providerRouting: applyWorkflowCallOverridesToProviderRouting(
      parentContext.providerRouting,
      step.overrides,
    ),
    // 正規化係の seat は runtime.yaml の internal_agents 割り当てで、
    // workflow_call の provider/model override の対象ではない（実行時も
    // WorkflowEngineSetup が engine option をそのまま渡す）。子へ素通しする。
    intakeNormalizerProvider: parentContext.intakeNormalizerProvider,
  };
}
