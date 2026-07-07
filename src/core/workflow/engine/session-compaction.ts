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

export async function compactSessionBeforePhase1(
  step: WorkflowStep,
  agentOptions: RunAgentOptions,
  deps: SessionCompactionDeps = defaultDeps,
): Promise<void> {
  if (step.session !== 'compact' || agentOptions.sessionId === undefined) {
    return;
  }

  if (agentOptions.resolvedProvider === undefined) {
    deps.warn('Session compaction skipped because provider is not resolved', {
      step: step.name,
      sessionId: agentOptions.sessionId,
    });
    return;
  }

  const provider = deps.getProvider(agentOptions.resolvedProvider);
  if (provider.compactSession === undefined) {
    return;
  }

  try {
    await provider.compactSession({
      cwd: agentOptions.cwd,
      sessionId: agentOptions.sessionId,
      model: agentOptions.resolvedModel,
      abortSignal: agentOptions.abortSignal,
      childProcessEnv: agentOptions.childProcessEnv,
    });
  } catch (error) {
    deps.warn('Session compaction failed; continuing with the existing session', {
      step: step.name,
      provider: agentOptions.resolvedProvider,
      sessionId: agentOptions.sessionId,
      error: sanitizeSensitiveText(getErrorMessage(error)),
    });
  }
}
