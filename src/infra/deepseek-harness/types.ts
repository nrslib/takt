import type { AgentResponse } from '../../core/models/index.js';
import type { DeepSeekHarnessProviderOptions } from '../../core/models/workflow-types.js';
import type { StreamCallback } from '../../shared/types/provider.js';

export interface DeepSeekHarnessCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  providerOptions?: DeepSeekHarnessProviderOptions;
  onStream?: StreamCallback;
  childProcessEnv?: Readonly<Record<string, string>>;
}

export type DeepSeekHarnessCall = (
  agentType: string,
  prompt: string,
  options: DeepSeekHarnessCallOptions,
) => Promise<AgentResponse>;
