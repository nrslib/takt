import type { AgentResponse } from '../../core/models/index.js';
import { loadManagedSdk } from '../managed-providers/loader.js';
import { managedFailureResponse, managedFailureStream, withUpdateAdvice } from '../managed-providers/messages.js';
import { createProviderErrorFailure, formatAgentFailure } from '../../shared/types/agent-failure.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { OpenCodeExecutionContext } from './execution-context.js';
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
    return this.callManaged(agentType, options, (prepared, context) => this.runner.call(agentType, prompt, prepared, context));
  }

  private async callManaged(agentType: string, options: OpenCodeCallOptions, operation: (prepared: OpenCodeCallOptions, context: OpenCodeExecutionContext) => Promise<AgentResponse>): Promise<AgentResponse> {
    let context: OpenCodeExecutionContext | undefined;
    try {
      const loaded = await loadManagedSdk('opencode');
      const executionContext = new OpenCodeExecutionContext(loaded);
      context = executionContext;
      const onStream: OpenCodeCallOptions['onStream'] = options.onStream === undefined ? undefined : (event) => {
        managedFailureStream(options.onStream, executionContext.stale, 'opencode')?.(event);
      };
      const response = await operation({ ...options, onStream }, executionContext);
      return managedFailureResponse(response, executionContext.stale, 'opencode');
    } catch (error) {
      const failure = createProviderErrorFailure(getErrorMessage(error));
      const message = context?.stale === true ? withUpdateAdvice(formatAgentFailure(failure), 'opencode') : formatAgentFailure(failure);
      options.onStream?.({ type: 'result', data: { result: message, error: message, success: false, sessionId: options.sessionId ?? 'unknown', failureCategory: failure.category } });
      return { persona: agentType, status: 'error', content: message, error: message, failureCategory: failure.category, sessionId: options.sessionId, timestamp: new Date() };
    }
  }

  callCustom(
    agentName: string,
    prompt: string,
    systemPrompt: string,
    options: OpenCodeCallOptions,
  ): Promise<AgentResponse> {
    return this.callManaged(agentName, options, (prepared, context) => this.runner.callCustom(agentName, prompt, systemPrompt, prepared, context));
  }

  async compactSession(options: OpenCodeCompactSessionOptions): Promise<void> {
    const loaded = await loadManagedSdk('opencode');
    const context = new OpenCodeExecutionContext(loaded);
    try { await this.runner.compactSession(options, context); }
    catch (error) {
      if (!context.stale) throw error;
      throw new Error(withUpdateAdvice(getErrorMessage(error), 'opencode'), { cause: error });
    }
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
