import { AsyncLocalStorage } from 'node:async_hooks';
import type { StepProviderOptions } from '../../models/workflow-types.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import { resolveProviderCallTimeoutMs } from '../../../shared/types/provider-deadline.js';
import { buildAbortSignal } from './abort-signal.js';

export interface WorkflowStepAbortSignalContext {
  getAbortSignal(): AbortSignal | undefined;
  runWith<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T>;
}

export interface WorkflowStepDeadline {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
  readonly startedAt: number;
  readonly timeoutMs: number;
}

export function createWorkflowStepAbortSignalContext(
  parentSignal: AbortSignal | undefined,
): WorkflowStepAbortSignalContext {
  const signalStorage = new AsyncLocalStorage<AbortSignal>();
  return {
    getAbortSignal: () => signalStorage.getStore() ?? parentSignal,
    runWith: async <T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> => {
      return signalStorage.run(signal, operation);
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
  ): WorkflowStepDeadline;
  runWith<T>(deadline: WorkflowStepDeadline, operation: () => Promise<T>): Promise<T>;
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
): WorkflowStepDeadline {
  const timeoutMs = resolveWorkflowStepCallTimeoutMs(provider, providerOptions);
  const startedAt = Date.now();
  const deadline = buildAbortSignal(timeoutMs, parentSignal, startedAt + timeoutMs);
  return { ...deadline, startedAt, timeoutMs };
}

export function createWorkflowStepCompositeDeadline(
  providerInfos: readonly WorkflowStepDeadlineProviderInfo[],
  parentSignal: AbortSignal | undefined,
  startedAt = Date.now(),
): WorkflowStepDeadline {
  const timeoutMs = resolveWorkflowStepCompositeCallTimeoutMs(providerInfos);
  const deadline = buildAbortSignal(timeoutMs, parentSignal, startedAt + timeoutMs);
  return { ...deadline, startedAt, timeoutMs };
}
