import type { AgentResponse } from '../../core/models/index.js';
import type {
  AgentSetup,
  Provider,
  ProviderAgent,
  ProviderCallOptions,
} from './types.js';
import type { DeepSeekHarnessCallOptions } from '../deepseek-harness/types.js';
import type { DeepSeekReasoningEffort } from '../../core/models/workflow-types.js';

const SUPPORTED_REASONING_EFFORTS: readonly DeepSeekReasoningEffort[] = ['off', 'low', 'high', 'max'];

/** Accept only reasoning effort values supported by the pinned DeepSeek SDK contract. */
function isDeepSeekReasoningEffort(value: string): value is DeepSeekReasoningEffort {
  return SUPPORTED_REASONING_EFFORTS.includes(value as DeepSeekReasoningEffort);
}

async function callDeepSeekHarnessLazy(
  agentType: string,
  prompt: string,
  options: DeepSeekHarnessCallOptions,
): Promise<AgentResponse> {
  const { callDeepSeekHarness } = await import('../deepseek-harness/index.js');
  return callDeepSeekHarness(agentType, prompt, options);
}

/** Fail closed before calling the client when an explicit option cannot be honored. */
function unsupportedConstraintResponse(
  agentType: string,
  options: ProviderCallOptions,
): AgentResponse | undefined {
  let constraint: string | undefined;
  if (options.maxTurns !== undefined) {
    constraint = 'maxTurns';
  } else if (options.outputSchema !== undefined) {
    constraint = 'structured output';
  } else if (options.imageAttachments !== undefined && options.imageAttachments.length > 0) {
    constraint = 'imageAttachments';
  } else if (
    options.allowReadonlyFileRead === true
    || options.internalAgentIsolation !== undefined
    || options.readonlyFileReadPaths !== undefined
  ) {
    constraint = 'read-only file access';
  } else if (options.permissionMode !== undefined || options.bypassPermissions === true) {
    constraint = 'permission controls';
  } else if (options.onPermissionRequest !== undefined || options.onAskUserQuestion !== undefined) {
    constraint = 'permission callbacks';
  } else if (options.allowedTools !== undefined) {
    constraint = 'allowedTools';
  } else if (
    (options.mcpServers !== undefined && Object.keys(options.mcpServers).length > 0)
    || options.preparedMcp !== undefined
  ) {
    constraint = 'mcpServers';
  }
  if (constraint === undefined) {
    return undefined;
  }
  const content = `DeepSeek Harness cannot honor ${constraint}; no supported configuration is exposed by the current SDK; use a compatible provider`;
  return {
    persona: agentType,
    status: 'error',
    content,
    error: content,
    failureCategory: 'provider_error',
    timestamp: new Date(),
  };
}

/** Return a provider error before execution when a requested reasoning effort cannot be honored. */
function unsupportedReasoningEffortResponse(
  agentType: string,
): AgentResponse {
  const content = 'DeepSeek Harness cannot honor this reasoning effort; supported values are off, low, high, and max.';
  return {
    persona: agentType,
    status: 'error',
    content,
    error: content,
    failureCategory: 'provider_error',
    timestamp: new Date(),
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

  /** Create the provider adapter, validate constraints before startup, and forward supported options to the lazy client. */
  setup(config: AgentSetup): ProviderAgent {
    return {
      call: (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
        const unsupported = unsupportedConstraintResponse(config.name, options);
        if (unsupported !== undefined) {
          return Promise.resolve(unsupported);
        }
        const effort = options.effort;
        if (effort !== undefined && !isDeepSeekReasoningEffort(effort)) {
          return Promise.resolve(unsupportedReasoningEffortResponse(config.name));
        }
        const providerOptions = options.providerOptions?.deepseekHarness;
        const callOptions: DeepSeekHarnessCallOptions = {
          cwd: options.cwd,
          ...(config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt }),
          abortSignal: options.abortSignal,
          sessionId: options.sessionId,
          model: options.model,
          providerOptions: effort === undefined
            ? providerOptions
            : { ...providerOptions, reasoningEffort: effort },
          onStream: options.onStream,
          childProcessEnv: options.childProcessEnv,
        };
        return callDeepSeekHarnessLazy(config.name, prompt, callOptions);
      },
    };
  }
}
