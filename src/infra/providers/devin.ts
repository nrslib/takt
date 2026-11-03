import { callDevin, type DevinCallOptions } from '../devin/index.js';
import { resolveDevinCliPath } from '../config/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

const log = createLogger('devin-provider');

function toDevinOptions(options: ProviderCallOptions, systemPrompt?: string): DevinCallOptions {
  if (options.allowedTools && options.allowedTools.length > 0) {
    log.info('Devin provider does not support allowedTools; ignoring');
  }
  if (options.maxTurns !== undefined) {
    log.info('Devin provider does not support maxTurns; ignoring');
  }
  if (options.outputSchema) {
    log.info('Devin provider does not support outputSchema; ignoring');
  }
  if (options.imageAttachments && options.imageAttachments.length > 0) {
    log.info('Devin provider does not support imageAttachments; ignoring');
  }

  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    systemPrompt,
    permissionMode: options.permissionMode,
    internalAgentIsolation: options.internalAgentIsolation,
    onStream: options.onStream,
    onActivity: options.onActivity,
    devinCliPath: resolveDevinCliPath(),
    childProcessEnv: options.childProcessEnv,
    preparedMcp: options.preparedMcp,
  };
}

export class DevinProvider implements Provider {
  readonly supportsStructuredOutput = false;
  readonly supportsNativeImageInput = false;
  // Devin CLI has no per-invocation MCP config flag; MCP servers only come
  // from `devin mcp` / mcp_config.json. Declare no runtime MCP transports so
  // workflow MCP assignments fail fast instead of being silently dropped.
  readonly supportedMcpTransports: ReadonlySet<'stdio' | 'sse' | 'http'> = new Set();

  getRuntimeInstructions(_allowedTools?: string[]): string | null {
    return null;
  }

  keepsAllowedToolWithoutEdit(_tool: string): boolean {
    return true;
  }

  setup(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;

    return {
      call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
        // resolveDevinCliPath() throws for a configured-but-invalid path; a
        // thrown exception bypasses AgentResponse entirely, so surface it as
        // a standard provider error response instead.
        try {
          return await callDevin(name, prompt, toDevinOptions(options, systemPrompt));
        } catch (error) {
          const message = `Devin provider call failed: ${getErrorMessage(error)}`;
          return {
            persona: name,
            status: 'error',
            content: message,
            error: message,
            timestamp: new Date(),
          };
        }
      },
    };
  }

}
