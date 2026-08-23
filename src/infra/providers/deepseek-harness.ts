import type { AgentResponse } from '../../core/models/index.js';
import { createLogger } from '../../shared/utils/index.js';
import type {
  AgentSetup,
  Provider,
  ProviderAgent,
  ProviderCallOptions,
} from './types.js';
import type { DeepSeekHarnessCallOptions } from '../deepseek-harness/types.js';

const log = createLogger('deepseek-harness-provider');

async function callDeepSeekHarnessLazy(
  agentType: string,
  prompt: string,
  options: DeepSeekHarnessCallOptions,
): Promise<AgentResponse> {
  const { callDeepSeekHarness } = await import('../deepseek-harness/index.js');
  return callDeepSeekHarness(agentType, prompt, options);
}

function unsupportedConstraintResponse(
  agentType: string,
  options: ProviderCallOptions,
): AgentResponse | undefined {
  const constraint = options.permissionMode !== undefined || options.bypassPermissions === true
    ? 'permission controls'
    : options.allowedTools !== undefined
      ? 'allowedTools'
      : undefined;
  if (constraint === undefined) {
    return undefined;
  }
  const content = `DeepSeek Harness cannot honor ${constraint}; configure the constraint in Cordis or use a compatible provider`;
  return {
    persona: agentType,
    status: 'error',
    content,
    error: content,
    failureCategory: 'provider_error',
    timestamp: new Date(),
  };
}

function toDeepSeekHarnessOptions(
  options: ProviderCallOptions,
  systemPrompt: string | undefined,
): DeepSeekHarnessCallOptions {
  if (systemPrompt !== undefined) {
    log.warn('DeepSeek Harness does not support per-run system prompts; configure system prompt in Cordis');
  }
  if (options.onPermissionRequest !== undefined || options.onAskUserQuestion !== undefined) {
    log.warn('DeepSeek Harness does not expose TAKT permission callbacks through the Python SDK; ignoring');
  }
  if (options.mcpServers !== undefined && Object.keys(options.mcpServers).length > 0) {
    log.warn('DeepSeek Harness does not support TAKT mcpServers; configure tools in Cordis');
  }
  if (options.maxTurns !== undefined) {
    log.warn('DeepSeek Harness does not support maxTurns; ignoring');
  }
  if (options.outputSchema !== undefined) {
    log.warn('DeepSeek Harness does not support TAKT structured output; ignoring');
  }
  if (options.imageAttachments !== undefined && options.imageAttachments.length > 0) {
    log.warn('DeepSeek Harness does not support imageAttachments; ignoring');
  }

  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    systemPrompt,
    providerOptions: options.providerOptions?.deepseekHarness,
    onStream: options.onStream,
    childProcessEnv: options.childProcessEnv,
  };
}

export class DeepSeekHarnessProvider implements Provider {
  readonly supportsStructuredOutput = false;
  readonly supportsNativeImageInput = false;
  readonly supportedMcpTransports: ReadonlySet<'stdio' | 'sse' | 'http'> = new Set();

  getRuntimeInstructions(_allowedTools?: string[]): string | null {
    return null;
  }

  supportsPermissionControls(): boolean {
    return false;
  }

  keepsAllowedToolWithoutEdit(_tool: string): boolean {
    return true;
  }

  setup(config: AgentSetup): ProviderAgent {
    return {
      call: (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
        const unsupported = unsupportedConstraintResponse(config.name, options);
        if (unsupported !== undefined) {
          return Promise.resolve(unsupported);
        }
        return callDeepSeekHarnessLazy(
          config.name,
          prompt,
          toDeepSeekHarnessOptions(options, config.systemPrompt),
        );
      },
    };
  }
}
