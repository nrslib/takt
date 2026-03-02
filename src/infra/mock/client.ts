/**
 * Mock agent client for testing
 *
 * Returns immediate fixed responses without any API calls.
 * Useful for testing pieces without incurring costs or latency.
 */

import { randomUUID } from 'node:crypto';
import type { StreamEvent } from '../claude/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import { getScenarioQueue } from './scenario.js';
import type { MockCallOptions } from './types.js';

export type { MockCallOptions };

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
  personaName: string,
  prompt: string,
  options: MockCallOptions
): Promise<AgentResponse> {
  const sessionId = options.sessionId ?? generateMockSessionId();

  // Scenario queue takes priority over explicit options
  const scenarioEntry = getScenarioQueue()?.consume(personaName);

  const status = scenarioEntry?.status ?? options.mockStatus ?? 'done';
  const statusMarker = `[MOCK:${status.toUpperCase()}]`;
  const content = scenarioEntry?.content ?? options.mockResponse ??
    `${statusMarker}\n\nMock response for persona "${personaName}".\nPrompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}`;

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
    persona: personaName,
    status,
    content,
    timestamp: new Date(),
    sessionId,
    structuredOutput: scenarioEntry?.structuredOutput ?? options.structuredOutput,
  };
}

/**
 * Call mock agent with custom system prompt (same as callMock for mock provider)
 */
export async function callMockCustom(
  personaName: string,
  prompt: string,
  _systemPrompt: string,
  options: MockCallOptions
): Promise<AgentResponse> {
  // For mock, system prompt is ignored - just return fixed response
  return callMock(personaName, prompt, options);
}
