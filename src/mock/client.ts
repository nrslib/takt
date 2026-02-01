/**
 * Mock agent client for testing
 *
 * Returns immediate fixed responses without any API calls.
 * Useful for testing workflows without incurring costs or latency.
 */

import { randomUUID } from 'node:crypto';
import type { StreamCallback, StreamEvent } from '../claude/process.js';
import type { AgentResponse } from '../models/types.js';
import { getScenarioQueue } from './scenario.js';

/** Options for mock calls */
export interface MockCallOptions {
  cwd: string;
  sessionId?: string;
  onStream?: StreamCallback;
  /** Fixed response content (optional, defaults to generic mock response) */
  mockResponse?: string;
  /** Fixed status to return (optional, defaults to 'done') */
  mockStatus?: 'done' | 'blocked' | 'approved' | 'rejected' | 'improve';
}

/**
 * Generate a mock session ID
 */
function generateMockSessionId(): string {
  return `mock-session-${randomUUID()}`;
}

/**
 * Call mock agent - returns immediate fixed response
 */
export async function callMock(
  agentName: string,
  prompt: string,
  options: MockCallOptions
): Promise<AgentResponse> {
  const sessionId = options.sessionId ?? generateMockSessionId();

  // Scenario queue takes priority over explicit options
  const scenarioEntry = getScenarioQueue()?.consume(agentName);

  const status = scenarioEntry?.status ?? options.mockStatus ?? 'done';
  const statusMarker = `[MOCK:${status.toUpperCase()}]`;
  const content = scenarioEntry?.content ?? options.mockResponse ??
    `${statusMarker}\n\nMock response for agent "${agentName}".\nPrompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}`;

  // Emit stream events if callback is provided
  if (options.onStream) {
    const initEvent: StreamEvent = {
      type: 'init',
      data: { model: 'mock-model', sessionId },
    };
    options.onStream(initEvent);

    const textEvent: StreamEvent = {
      type: 'text',
      data: { text: content },
    };
    options.onStream(textEvent);

    const resultEvent: StreamEvent = {
      type: 'result',
      data: { success: true, result: content, sessionId },
    };
    options.onStream(resultEvent);
  }

  return {
    agent: agentName,
    status,
    content,
    timestamp: new Date(),
    sessionId,
  };
}

/**
 * Call mock agent with custom system prompt (same as callMock for mock provider)
 */
export async function callMockCustom(
  agentName: string,
  prompt: string,
  _systemPrompt: string,
  options: MockCallOptions
): Promise<AgentResponse> {
  // For mock, system prompt is ignored - just return fixed response
  return callMock(agentName, prompt, options);
}
