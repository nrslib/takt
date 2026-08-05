/**
 * Mock provider implementation
 */

import { callMock, callMockCustom, type MockCallOptions } from '../mock/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import { keepsAllowedToolWithoutEdit as keepsClaudeAllowedToolWithoutEdit } from './allowed-tool-edit-policy.js';
import { createLogger } from '../../shared/utils/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';
import { assertOutputSchema } from './types.js';

const log = createLogger('mock-provider');

function toMockOptions(options: ProviderCallOptions): MockCallOptions {
  if (options.imageAttachments && options.imageAttachments.length > 0) {
    log.info('Mock provider does not support imageAttachments; ignoring');
  }

  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    onStream: options.onStream,
    allowedTools: options.allowedTools,
  };
}

/** Mock provider — deterministic responses for testing */
export class MockProvider implements Provider {
  readonly supportsStructuredOutput = true;
  readonly supportsIsolatedStructuredExecution = true;
  readonly supportsNativeImageInput = false;
  readonly supportsStrictInternalAgentIsolation = true;

  getRuntimeInstructions(_allowedTools?: string[]): string | null {
    return null;
  }

  keepsAllowedToolWithoutEdit(tool: string): boolean {
    return keepsClaudeAllowedToolWithoutEdit(tool);
  }

  setup(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    if (systemPrompt) {
      return {
        call: (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> =>
          callMockCustom(name, prompt, systemPrompt, toMockOptions(options)),
      };
    }

    return {
      call: (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> =>
        callMock(name, prompt, toMockOptions(options)),
    };
  }

  setupIsolatedStructured(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    const call = (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
      const isolatedOptions: ProviderCallOptions = {
        ...options,
        sessionId: undefined,
        internalAgentIsolation: 'strict-readonly',
        permissionMode: 'readonly',
        allowedTools: [],
        mcpServers: undefined,
        imageAttachments: undefined,
        outputSchema: assertOutputSchema(options.outputSchema, 'mock'),
      };
      const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
      return callMockCustom(name, fullPrompt, '', toMockOptions(isolatedOptions));
    };
    return { call };
  }
}
