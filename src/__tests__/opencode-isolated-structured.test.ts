import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse } from '../core/models/index.js';
import type { ProviderCallOptions } from '../infra/providers/types.js';

const openCodeMocks = vi.hoisted(() => ({
  callOpenCode: vi.fn(),
  callOpenCodeCustom: vi.fn(),
  compactOpenCodeSession: vi.fn(),
}));

vi.mock('../infra/opencode/index.js', () => ({
  callOpenCode: openCodeMocks.callOpenCode,
  callOpenCodeCustom: openCodeMocks.callOpenCodeCustom,
  compactOpenCodeSession: openCodeMocks.compactOpenCodeSession,
}));

const callOptions: ProviderCallOptions = {
  cwd: '/tmp/takt-isolated-structured',
  model: 'ollama-cloud/glm-5.2',
  permissionMode: 'readonly',
  allowedTools: [],
  outputSchema: {
    type: 'object',
    required: ['rawFindings'],
    properties: { rawFindings: { type: 'array' } },
  },
};

const providerTimestamp = new Date('2026-08-06T00:00:00.000Z');

async function callIsolated(response: AgentResponse): Promise<AgentResponse> {
  openCodeMocks.callOpenCodeCustom.mockResolvedValue(response);
  const { OpenCodeProvider } = await import('../infra/providers/opencode.js');
  const agent = new OpenCodeProvider().setupIsolatedStructured({
    name: 'finding-intake-normalizer',
    systemPrompt: '',
  });
  return agent.call('extract raw findings', callOptions);
}

describe('OpenCodeProvider.setupIsolatedStructured response contract', () => {
  beforeEach(() => {
    openCodeMocks.callOpenCodeCustom.mockReset();
  });

  it('should keep the response successful when the structured payload arrives outside the message body', async () => {
    const structuredOutput = { rawFindings: [{ rawExcerpt: 'claim', candidate: null }] };
    const response = await callIsolated({
      persona: 'finding-intake-normalizer',
      status: 'done',
      // OpenCode の native structured output はモデルが本文を出さないことがあり、
      // 構造化ペイロードだけが assistant message の structured で返る。
      content: '',
      structuredOutput,
      sessionId: 'isolated-session',
      timestamp: providerTimestamp,
    });

    expect(response).toEqual({
      persona: 'finding-intake-normalizer',
      status: 'done',
      content: '',
      structuredOutput,
      sessionId: 'isolated-session',
      timestamp: providerTimestamp,
    });
  });

  it('should report a provider error when the response is fully empty', async () => {
    const response = await callIsolated({
      persona: 'finding-intake-normalizer',
      status: 'done',
      content: '',
      sessionId: 'isolated-session',
      timestamp: providerTimestamp,
    });

    const expectedError =
      'OpenCode isolated structured execution returned an empty response with no structured output';
    expect(response).toEqual({
      persona: 'finding-intake-normalizer',
      status: 'error',
      content: expectedError,
      error: expectedError,
      failureCategory: 'provider_error',
      sessionId: 'isolated-session',
      timestamp: providerTimestamp,
    });
  });

  it('should report a provider error when the response body is not parsable structured output', async () => {
    const response = await callIsolated({
      persona: 'finding-intake-normalizer',
      status: 'done',
      content: '  I could not extract anything from this report.  ',
      sessionId: 'isolated-session',
      timestamp: providerTimestamp,
    });

    const expectedError = 'OpenCode isolated structured execution returned no structured output: '
      + 'I could not extract anything from this report.';
    expect(response).toEqual({
      persona: 'finding-intake-normalizer',
      status: 'error',
      content: expectedError,
      error: expectedError,
      failureCategory: 'provider_error',
      sessionId: 'isolated-session',
      timestamp: providerTimestamp,
    });
  });

  it('should pass the response through unchanged when the provider already reported a failure', async () => {
    const response = await callIsolated({
      persona: 'finding-intake-normalizer',
      status: 'error',
      content: 'upstream request failed',
      error: 'upstream request failed',
      failureCategory: 'provider_error',
      sessionId: 'isolated-session',
      timestamp: providerTimestamp,
    });

    expect(response).toEqual({
      persona: 'finding-intake-normalizer',
      status: 'error',
      content: 'upstream request failed',
      error: 'upstream request failed',
      failureCategory: 'provider_error',
      sessionId: 'isolated-session',
      timestamp: providerTimestamp,
    });
  });
});
