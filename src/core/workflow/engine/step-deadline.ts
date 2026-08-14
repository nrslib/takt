import { AsyncLocalStorage } from 'node:async_hooks';
import type { StepProviderOptions } from '../../models/workflow-types.js';
import type {
  ProviderActivityCallback,
  ProviderType,
  StreamEvent,
} from '../../../shared/types/provider.js';
import { resolveProviderCallTimeoutMs } from '../../../shared/types/provider-deadline.js';
import { buildInactivityAbortSignal } from './abort-signal.js';

export interface WorkflowStepAbortSignalContext {
  getAbortSignal(): AbortSignal | undefined;
  recordActivity: ProviderActivityCallback;
  runWith<T>(deadline: WorkflowStepInactivityDeadline, operation: () => Promise<T>): Promise<T>;
}

export interface WorkflowStepInactivityDeadline {
  readonly signal: AbortSignal;
  readonly recordActivity: ProviderActivityCallback;
  readonly dispose: () => void;
  readonly inactivityTimeoutMs: number;
}

export function recordWorkflowStepProviderEventActivity(
  recordActivity: ProviderActivityCallback,
  executionUnitKey: string,
  event: StreamEvent,
): void {
  if (event.type === 'tool_use') {
    recordActivity({
      kind: 'tool_started',
      executionUnitKey,
      toolCallKey: JSON.stringify([executionUnitKey, event.data.id]),
    });
    return;
  }
  if (event.type === 'tool_result' && event.data.id !== undefined) {
    recordActivity({
      kind: 'tool_finished',
      executionUnitKey,
      toolCallKey: JSON.stringify([executionUnitKey, event.data.id]),
    });
    return;
  }
  recordActivity();
}

export function recordWorkflowStepProviderActivity(
  recordActivity: ProviderActivityCallback,
  executionUnitKey: string,
  activity?: Parameters<ProviderActivityCallback>[0],
): void {
  if (activity?.kind === 'attempt_started') {
    recordActivity({ ...activity, executionUnitKey });
    return;
  }
  recordActivity(activity);
}

export function createWorkflowStepAbortSignalContext(
  parentSignal: AbortSignal | undefined,
): WorkflowStepAbortSignalContext {
  const deadlineStorage = new AsyncLocalStorage<WorkflowStepInactivityDeadline>();
  return {
    getAbortSignal: () => deadlineStorage.getStore()?.signal ?? parentSignal,
    recordActivity: (activity) => deadlineStorage.getStore()?.recordActivity(activity),
    runWith: async <T>(deadline: WorkflowStepInactivityDeadline, operation: () => Promise<T>): Promise<T> => {
      return deadlineStorage.run(deadline, operation);
    },
  };
}

function resolveConfiguredWorkflowStepCallTimeoutMs(
  provider: ProviderType | undefined,
  providerOptions: StepProviderOptions | undefined,
): number | undefined {
  return provider === 'claude-terminal'
    ? providerOptions?.claudeTerminal?.guards?.callTimeoutMs
    : provider === 'opencode'
    ? providerOptions?.opencode?.guards?.callTimeoutMs
    : provider === 'claude' || provider === 'claude-sdk'
      ? providerOptions?.claude?.guards?.callTimeoutMs
      : provider === 'codex'
        ? providerOptions?.codex?.guards?.callTimeoutMs
        : provider === 'cursor'
          ? providerOptions?.cursor?.guards?.callTimeoutMs
          : provider === 'copilot'
            ? providerOptions?.copilot?.guards?.callTimeoutMs
            : provider === 'kiro'
              ? providerOptions?.kiro?.guards?.callTimeoutMs
              : provider === 'pi'
                ? providerOptions?.pi?.guards?.callTimeoutMs
                : undefined;
}

export function resolveWorkflowStepCallTimeoutMs(
  provider: ProviderType | undefined,
  providerOptions: StepProviderOptions | undefined,
): number {
  const configured = resolveConfiguredWorkflowStepCallTimeoutMs(provider, providerOptions);
  if (configured !== undefined) {
    return resolveProviderCallTimeoutMs(configured);
  }
  // timeoutMs is a legacy Claude Terminal setting. Preserve its historical
  // range when the new guards.callTimeoutMs setting is absent.
  if (provider === 'claude-terminal' && providerOptions?.claudeTerminal?.timeoutMs !== undefined) {
    return providerOptions.claudeTerminal.timeoutMs;
  }
  return resolveProviderCallTimeoutMs(configured);
}

export interface WorkflowStepDeadlineProviderInfo {
  readonly provider: ProviderType | undefined;
  readonly providerOptions?: StepProviderOptions;
}

export function hasWorkflowStepCallTimeoutGuard(
  provider: ProviderType | undefined,
  providerOptions: StepProviderOptions | undefined,
): boolean {
  return resolveConfiguredWorkflowStepCallTimeoutMs(provider, providerOptions) !== undefined;
}

export interface WorkflowStepExecutionDeadlineContext {
  begin(
    executionUnitKey: string,
    providerInfo: WorkflowStepDeadlineProviderInfo,
  ): WorkflowStepInactivityDeadline;
  runWith<T>(deadline: WorkflowStepInactivityDeadline, operation: () => Promise<T>): Promise<T>;
}

export function resolveWorkflowStepCompositeCallTimeoutMs(
  providerInfos: readonly WorkflowStepDeadlineProviderInfo[],
): number {
  if (providerInfos.length === 0) {
    throw new Error('At least one provider is required to resolve a workflow step deadline');
  }
  return Math.max(
    ...providerInfos.map(({ provider, providerOptions }) =>
      resolveWorkflowStepCallTimeoutMs(provider, providerOptions)),
  );
}

export function createWorkflowStepDeadline(
  provider: ProviderType | undefined,
  providerOptions: StepProviderOptions | undefined,
  parentSignal: AbortSignal | undefined,
): WorkflowStepInactivityDeadline {
  const inactivityTimeoutMs = resolveWorkflowStepCallTimeoutMs(provider, providerOptions);
  const deadline = buildInactivityAbortSignal(inactivityTimeoutMs, parentSignal);
  return { ...deadline, inactivityTimeoutMs };
}

export function createWorkflowStepCompositeDeadline(
  providerInfos: readonly WorkflowStepDeadlineProviderInfo[],
  parentSignal: AbortSignal | undefined,
): WorkflowStepInactivityDeadline {
  const inactivityTimeoutMs = resolveWorkflowStepCompositeCallTimeoutMs(providerInfos);
  const deadline = buildInactivityAbortSignal(inactivityTimeoutMs, parentSignal);
  return { ...deadline, inactivityTimeoutMs };
}
