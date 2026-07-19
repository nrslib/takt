import type { ProviderUsageSnapshot } from '../../models/response.js';
import type { StepProviderInfo, WorkflowEngineOptions } from '../types.js';

export function recordDelegatedAgentUsage(
  options: WorkflowEngineOptions,
  step: string,
  stepType: 'parallel' | 'team_leader',
  providerInfo: StepProviderInfo,
  success: boolean,
  usage: ProviderUsageSnapshot | undefined,
): void {
  const onDelegatedAgentUsage = options.onDelegatedAgentUsage;
  if (!onDelegatedAgentUsage) {
    return;
  }
  if (!providerInfo.provider) {
    throw new Error(`Step "${step}" has no resolved provider for usage event logging`);
  }
  onDelegatedAgentUsage(
    {
      step,
      stepType,
      provider: providerInfo.provider,
      providerModel: providerInfo.model ?? '(default)',
    },
    {
      success,
      ...(usage !== undefined ? { usage } : {}),
    },
  );
}
