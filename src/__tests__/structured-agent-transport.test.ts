import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeStructuredAgent,
  requireStructuredAgentProvider,
} from '../agents/structured-caller/transport.js';
import { executeAgent } from '../agents/agent-usecases.js';

vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: vi.fn() }));

const schema = {
  type: 'object',
  properties: { complete: { type: 'boolean' } },
  required: ['complete'],
  additionalProperties: false,
};

describe('executeStructuredAgent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uses a fresh session without injecting permissions or capabilities when omitted', async () => {
    vi.mocked(executeAgent).mockResolvedValue({
      persona: 'judge',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { complete: true },
    });

    await expect(executeStructuredAgent<{ complete: boolean }>('review', schema, {
      name: 'judge',
      cwd: '/repo',
      systemPrompt: 'judge system',
      resolution: { provider: 'mock' },
    })).resolves.toMatchObject({ structuredOutput: { complete: true } });

    expect(vi.mocked(executeAgent).mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      cwd: '/repo',
      sessionId: undefined,
      resolvedExecution: {
        provider: 'mock',
        model: undefined,
        providerOptions: undefined,
        permissionMode: undefined,
      },
      outputSchema: schema,
    }));
    const options = vi.mocked(executeAgent).mock.calls[0]?.[2];
    expect(options).not.toHaveProperty('permissionMode');
    expect(options).not.toHaveProperty('allowedTools');
    expect(options).not.toHaveProperty('mcpServers');
    expect(options).not.toHaveProperty('bypassPermissions');
  });

  it('passes explicitly resolved provider options and permission mode unchanged', async () => {
    vi.mocked(executeAgent).mockResolvedValue({
      persona: 'judge',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { complete: true },
    });
    const providerOptions = {
      claude: {
        allowedTools: ['Read', 'Grep'],
        skills: { enabled: false },
      },
    } as const;

    await executeStructuredAgent('review', schema, {
      name: 'judge',
      cwd: '/repo',
      resolution: {
        provider: 'claude',
        model: 'claude-review',
        providerOptions,
        permissionMode: 'readonly',
      },
    });

    expect(vi.mocked(executeAgent).mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      resolvedExecution: {
        provider: 'claude',
        model: 'claude-review',
        providerOptions,
        permissionMode: 'readonly',
      },
      allowedTools: ['Read', 'Grep'],
    }));
  });

  it('preserves omitted provider options as explicit undefined in resolved execution', async () => {
    vi.mocked(executeAgent).mockResolvedValue({
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { complete: true },
    });

    await executeStructuredAgent('select', schema, {
      name: 'selector',
      cwd: '/repo',
      resolution: { provider: 'mock', providerOptions: undefined },
    });

    expect(vi.mocked(executeAgent).mock.calls[0]?.[2]?.resolvedExecution?.providerOptions)
      .toBeUndefined();
  });

  it('fails fast when the caller has not resolved a provider', () => {
    expect(() => requireStructuredAgentProvider(undefined, 'judge'))
      .toThrow('requires a resolved provider');
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('uses the prompt JSON fallback and validates providers without native structured output', async () => {
    vi.mocked(executeAgent).mockResolvedValue({
      persona: 'judge',
      status: 'done',
      content: '```json\n{"complete":true}\n```',
      timestamp: new Date(),
    });

    const response = await executeStructuredAgent<{ complete: boolean }>('review evidence', schema, {
      name: 'judge',
      cwd: '/repo',
      language: 'en',
      resolution: { provider: 'cursor' },
    });

    expect(response.structuredOutput).toEqual({ complete: true });
    const [, instruction, options] = vi.mocked(executeAgent).mock.calls[0]!;
    expect(instruction).toContain('review evidence');
    expect(instruction).toContain('"complete"');
    expect(options).not.toHaveProperty('outputSchema');
  });

  it('rejects fallback output that violates the requested schema', async () => {
    vi.mocked(executeAgent).mockResolvedValue({
      persona: 'judge',
      status: 'done',
      content: '{"complete":"yes"}',
      timestamp: new Date(),
    });

    await expect(executeStructuredAgent('review', schema, {
      name: 'judge',
      cwd: '/repo',
      resolution: { provider: 'cursor' },
    })).rejects.toThrow(/complete.*boolean/i);
  });
});
