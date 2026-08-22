import type { AgentResponse } from '../../core/models/index.js';
import {
  OpenCodeAttemptRunner,
} from './attempt-runner.js';
import type {
  OpenCodeCallOptions,
  OpenCodeCompactSessionOptions,
} from './types.js';

export type { OpenCodeCallOptions } from './types.js';
export {
  getOpenCodeSessionMessages,
  getOpenCodeSessionSnapshot,
  resetSharedServer,
  type OpenCodeSessionMessages,
} from './attempt-runner.js';

export class OpenCodeClient {
  private readonly runner = new OpenCodeAttemptRunner();

  call(agentType: string, prompt: string, options: OpenCodeCallOptions): Promise<AgentResponse> {
    return this.runner.call(agentType, prompt, options);
  }

  callCustom(
    agentName: string,
    prompt: string,
    systemPrompt: string,
    options: OpenCodeCallOptions,
  ): Promise<AgentResponse> {
    return this.runner.callCustom(agentName, prompt, systemPrompt, options);
  }

  compactSession(options: OpenCodeCompactSessionOptions): Promise<void> {
    return this.runner.compactSession(options);
  }
}

const defaultClient = new OpenCodeClient();

export function callOpenCode(
  agentType: string,
  prompt: string,
  options: OpenCodeCallOptions,
): Promise<AgentResponse> {
  return defaultClient.call(agentType, prompt, options);
}

export function callOpenCodeCustom(
  agentName: string,
  prompt: string,
  systemPrompt: string,
  options: OpenCodeCallOptions,
): Promise<AgentResponse> {
  return defaultClient.callCustom(agentName, prompt, systemPrompt, options);
}

export function compactOpenCodeSession(options: OpenCodeCompactSessionOptions): Promise<void> {
  return defaultClient.compactSession(options);
}
