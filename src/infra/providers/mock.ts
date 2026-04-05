/**
 * Mock provider implementation
 */

import { callMock, callMockCustom, type MockCallOptions } from '../mock/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

function toMockOptions(options: ProviderCallOptions): MockCallOptions {
  return {
    cwd: options.cwd,
    sessionId: options.sessionId,
    onStream: options.onStream,
  };
}

/** Mock provider — deterministic responses for testing */
export class MockProvider implements Provider {
  readonly supportsStructuredOutput = true;

  setup(config: AgentSetup): ProviderAgent {
    if (config.claudeAgent) {
      throw new Error('Claude Code agent calls are not supported by the Mock provider');
    }
    if (config.claudeSkill) {
      throw new Error('Claude Code skill calls are not supported by the Mock provider');
    }

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
}
