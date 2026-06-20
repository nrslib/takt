import { callKiro, type KiroCallOptions } from '../kiro/index.js';
import { resolveKiroApiKey, resolveKiroCliPath } from '../config/index.js';
import { createLogger } from '../../shared/utils/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

const log = createLogger('kiro-provider');

function toKiroOptions(options: ProviderCallOptions, systemPrompt?: string): KiroCallOptions {
  if (options.allowedTools && options.allowedTools.length > 0) {
    log.info('Kiro provider does not support allowedTools; ignoring');
  }
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    log.info('Kiro provider does not support mcpServers; ignoring');
  }
  if (options.maxTurns !== undefined) {
    log.info('Kiro provider does not support maxTurns; ignoring');
  }
  if (options.outputSchema) {
    log.info('Kiro provider does not support outputSchema; ignoring');
  }
  if (options.model) {
    log.info('Kiro provider does not support model CLI flag; ignoring');
  }
  if (options.imageAttachments && options.imageAttachments.length > 0) {
    log.info('Kiro provider does not support imageAttachments; ignoring');
  }

  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    systemPrompt,
    permissionMode: options.permissionMode,
    onStream: options.onStream,
    kiroApiKey: options.kiroApiKey ?? resolveKiroApiKey(),
    kiroCliPath: resolveKiroCliPath(),
    agent: options.providerOptions?.kiro?.agent,
    childProcessEnv: options.childProcessEnv,
  };
}

export class KiroProvider implements Provider {
  readonly supportsStructuredOutput = false;
  readonly supportsNativeImageInput = false;

  getRuntimeInstructions(): string | null {
    return null;
  }

  keepsAllowedToolWithoutEdit(_tool: string): boolean {
    return true;
  }

  setup(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;

    return {
      call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
        return callKiro(name, prompt, toKiroOptions(options, systemPrompt));
      },
    };
  }
}
