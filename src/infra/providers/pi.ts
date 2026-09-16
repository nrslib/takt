import type { PiCallOptions } from '../pi/types.js';
import type { AgentResponse } from '../../core/models/index.js';
import { createLogger } from '../../shared/utils/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';
import { keepsPiToolWithoutEdit, PI_READONLY_TOOLS } from './pi-tool-policy.js';

const log = createLogger('pi-provider');

async function callPiLazy(
  agentType: string,
  prompt: string,
  options: PiCallOptions,
): Promise<AgentResponse> {
  const { callPi } = await import('../pi/index.js');
  return callPi(agentType, prompt, options);
}

function toPiOptions(options: ProviderCallOptions, systemPrompt?: string): PiCallOptions {
  if (options.allowedTools && options.allowedTools.length > 0) {
    log.info('Pi provider maps allowedTools to Pi SDK tool names');
  }
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    log.warn('Pi provider does not support mcpServers; configure integrations through Pi extensions when supported');
  }
  if (options.maxTurns !== undefined) {
    log.warn('Pi provider does not support maxTurns; ignoring');
  }
  if (options.outputSchema) {
    log.warn('Pi provider does not support outputSchema; ignoring');
  }
  if (options.imageAttachments && options.imageAttachments.length > 0) {
    log.info('Pi provider passes imageAttachments to the Pi SDK as native images');
  }

  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    systemPrompt,
    permissionMode: options.permissionMode,
    allowedTools: options.allowedTools,
    imageAttachments: options.imageAttachments,
    providerOptions: options.providerOptions?.pi,
    onStream: options.onStream,
    onActivity: options.onActivity,
    childProcessEnv: options.childProcessEnv,
  };
}

export class PiProvider implements Provider {
  readonly supportsStructuredOutput = false;
  readonly supportsNativeImageInput = true;
  readonly supportedMcpTransports: ReadonlySet<'stdio' | 'sse' | 'http'> = new Set();

  getRuntimeInstructions(_allowedTools?: string[]): string | null {
    return null;
  }

  keepsAllowedToolWithoutEdit(tool: string): boolean {
    return keepsPiToolWithoutEdit(tool);
  }

  getDefaultAllowedToolsWithoutEdit(): readonly string[] {
    return PI_READONLY_TOOLS;
  }

  setup(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    return {
      call: (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> =>
        callPiLazy(name, prompt, toPiOptions(options, systemPrompt)),
    };
  }

}
