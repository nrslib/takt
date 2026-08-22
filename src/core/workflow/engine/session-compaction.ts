import type { RunAgentOptions } from '../../../agents/runner.js';
import { getProvider } from '../../../infra/providers/index.js';
import type { Provider, ProviderType } from '../../../infra/providers/types.js';
import type { WorkflowStep } from '../../models/types.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';

const log = createLogger('session-compaction');

type SessionCompactionDeps = {
  getProvider: (type: ProviderType) => Provider;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

const defaultDeps: SessionCompactionDeps = {
  getProvider,
  warn: (message, meta) => log.warn(message, meta),
};

export type SessionCompactionOutcome = 'reused' | 'fresh';

export async function compactSessionBeforePhase1(
  step: WorkflowStep,
  agentOptions: RunAgentOptions,
  deps: SessionCompactionDeps = defaultDeps,
): Promise<SessionCompactionOutcome> {
  if (step.session !== 'compact' || agentOptions.sessionId === undefined) {
    return 'reused';
  }

  if (agentOptions.resolvedProvider === undefined) {
    deps.warn('Session compaction skipped because provider is not resolved', {
      step: step.name,
      sessionId: agentOptions.sessionId,
    });
    return 'reused';
  }

  const provider = deps.getProvider(agentOptions.resolvedProvider);
  if (provider.compactSession === undefined) {
    return 'reused';
  }

  try {
    await provider.compactSession({
      cwd: agentOptions.cwd,
      sessionId: agentOptions.sessionId,
      model: agentOptions.resolvedModel,
      abortSignal: agentOptions.abortSignal,
      childProcessEnv: agentOptions.childProcessEnv,
    });
    return 'reused';
  } catch (error) {
    if (agentOptions.abortSignal?.aborted === true) {
      throw error;
    }
    deps.warn('Session compaction failed; switching to a fresh session', {
      step: step.name,
      provider: agentOptions.resolvedProvider,
      sessionId: agentOptions.sessionId,
      error: sanitizeSensitiveText(getErrorMessage(error)),
    });
    return 'fresh';
  }
}
