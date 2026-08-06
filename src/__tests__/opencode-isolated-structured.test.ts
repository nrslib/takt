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

  it('accepts a structured payload delivered outside the message body', async () => {
    const structuredOutput = { rawFindings: [{ rawExcerpt: 'claim', candidate: null }] };
    const response = await callIsolated({
      persona: 'finding-intake-normalizer',
      status: 'done',
      // OpenCode の native structured output はモデルが本文を出さないことがあり、
      // 構造化ペイロードだけが assistant message の structured で返る。
      content: '',
      structuredOutput,
      timestamp: new Date(),
    });

    expect(response.status).toBe('done');
    expect(response.structuredOutput).toEqual(structuredOutput);
    expect(response.error).toBeUndefined();
    expect(response.failureCategory).toBeUndefined();
  });

  it('turns a fully empty response into a provider error instead of a success', async () => {
    const response = await callIsolated({
      persona: 'finding-intake-normalizer',
      status: 'done',
      content: '',
      timestamp: new Date(),
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('provider_error');
    expect(response.error).toContain('empty response');
    expect(response.structuredOutput).toBeUndefined();
  });

  it('turns an unparsable non-empty response into a provider error', async () => {
    const response = await callIsolated({
      persona: 'finding-intake-normalizer',
      status: 'done',
      content: 'I could not extract anything from this report.',
      timestamp: new Date(),
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('provider_error');
    expect(response.error).toContain('no structured output');
    expect(response.error).toContain('I could not extract anything');
  });

  it('passes a provider-side failure through untouched', async () => {
    const response = await callIsolated({
      persona: 'finding-intake-normalizer',
      status: 'error',
      content: 'upstream request failed',
      error: 'upstream request failed',
      failureCategory: 'provider_error',
      timestamp: new Date(),
    });

    expect(response.status).toBe('error');
    expect(response.error).toBe('upstream request failed');
  });
});
