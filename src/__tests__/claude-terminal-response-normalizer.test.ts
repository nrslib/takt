import { describe, expect, it, vi } from 'vitest';
import { USAGE_MISSING_REASONS } from '../core/logging/contracts.js';
import { normalizeClaudeTerminalResponse } from '../infra/claude-terminal/response-normalizer.js';

const SCHEMA = {
  type: 'object',
  properties: { decision: { type: 'string' } },
  required: ['decision'],
  additionalProperties: false,
};

describe('Claude terminal response normalizer', () => {
  it('Given assistant text with JSON output, When normalizing with outputSchema, Then AgentResponse includes structuredOutput', () => {
    const onStream = vi.fn();
    const result = normalizeClaudeTerminalResponse({
      agentName: 'coder',
      sessionId: 'claude-session-1',
      assistantText: 'Done.\n{"decision":"approved"}',
      outputSchema: SCHEMA,
      onStream,
    });

    expect(result).toMatchObject({
      persona: 'coder',
      status: 'done',
      content: 'Done.\n{"decision":"approved"}',
      sessionId: 'claude-session-1',
      structuredOutput: { decision: 'approved' },
      providerUsage: {
        usageMissing: true,
        reason: USAGE_MISSING_REASONS.NOT_SUPPORTED_BY_PROVIDER,
      },
    });
    expect(result.timestamp).toBeInstanceOf(Date);
    expect(onStream).toHaveBeenCalledWith({
      type: 'text',
      data: { text: 'Done.\n{"decision":"approved"}' },
    });
    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: {
        result: 'Done.\n{"decision":"approved"}',
        sessionId: 'claude-session-1',
        success: true,
      },
    });
  });

  it('Given outputSchema but no parseable structured output, When normalizing, Then provider error is explicit', () => {
    const result = normalizeClaudeTerminalResponse({
      agentName: 'coder',
      sessionId: 'claude-session-1',
      assistantText: 'plain text only',
      outputSchema: SCHEMA,
    });

    expect(result).toMatchObject({
      persona: 'coder',
      status: 'error',
      content: 'plain text only',
      sessionId: 'claude-session-1',
      failureCategory: 'provider_error',
    });
    expect(result.error).toMatch(/structured output/i);
    expect(result.structuredOutput).toBeUndefined();
  });

  it('Given tool use events, When normalizing, Then equivalent stream tool events are emitted', () => {
    const onStream = vi.fn();

    normalizeClaudeTerminalResponse({
      agentName: 'coder',
      sessionId: 'claude-session-1',
      assistantText: 'Read package.json',
      events: [
        {
          type: 'tool_use',
          id: 'tool-1',
          tool: 'Read',
          input: { file_path: 'package.json' },
        },
      ],
      onStream,
    });

    expect(onStream).toHaveBeenCalledWith({
      type: 'tool_use',
      data: {
        id: 'tool-1',
        tool: 'Read',
        input: { file_path: 'package.json' },
      },
    });
  });

  it('Given assistant text contains a rate limit marker, When normalizing, Then rate_limited response is returned', () => {
    const result = normalizeClaudeTerminalResponse({
      agentName: 'coder',
      sessionId: 'claude-session-1',
      assistantText: 'usage_limit_exceeded: resets 12:30pm',
    });

    expect(result).toMatchObject({
      persona: 'coder',
      status: 'rate_limited',
      content: '',
      errorKind: 'rate_limit',
      sessionId: 'claude-session-1',
      providerUsage: {
        usageMissing: true,
        reason: USAGE_MISSING_REASONS.NOT_SUPPORTED_BY_PROVIDER,
      },
    });
    expect(result.rateLimitInfo).toMatchObject({
      provider: 'claude-terminal',
      source: 'stream_marker',
      resetAtRaw: '12:30pm',
    });
  });

  it('Given assistant text starts with an HTTP 429 description, When normalizing, Then response remains done', () => {
    const assistantText = 'HTTP 429: Too many requests';

    const result = normalizeClaudeTerminalResponse({
      agentName: 'coder',
      sessionId: 'claude-session-1',
      assistantText,
    });

    expect(result).toMatchObject({
      persona: 'coder',
      status: 'done',
      content: assistantText,
      sessionId: 'claude-session-1',
    });
    expect(result.error).toBeUndefined();
    expect(result.rateLimitInfo).toBeUndefined();
  });

  it('Given assistant text references a line range ending in 429, When normalizing, Then response remains done', () => {
    const assistantText = '| 42 | issue unresolved | `hoge_spec.rb:418-429` |';

    const result = normalizeClaudeTerminalResponse({
      agentName: 'coder',
      sessionId: 'claude-session-1',
      assistantText,
    });

    expect(result).toMatchObject({
      persona: 'coder',
      status: 'done',
      content: assistantText,
      sessionId: 'claude-session-1',
    });
    expect(result.error).toBeUndefined();
    expect(result.rateLimitInfo).toBeUndefined();
  });

  it('Given assistant text documents rate limit fallback for issue 429, When normalizing, Then response remains done', () => {
    const assistantText = 'Documented rate limit fallback behavior for issue 429.';

    const result = normalizeClaudeTerminalResponse({
      agentName: 'coder',
      sessionId: 'claude-session-1',
      assistantText,
    });

    expect(result).toMatchObject({
      persona: 'coder',
      status: 'done',
      content: assistantText,
      sessionId: 'claude-session-1',
    });
    expect(result.error).toBeUndefined();
    expect(result.rateLimitInfo).toBeUndefined();
  });

  it.each([
    'Documented HTTP 429 Too Many Requests response handling.',
    'HTTP 429 means Too Many Requests in the docs.',
    'Status code 429 is Too Many Requests.',
    'The reviewed code handles HTTP status code 429 with retry fallback.',
    'The report says too many requests should trigger fallback only on provider errors.',
  ])('Given assistant text explains %s, When normalizing, Then response remains done', (assistantText) => {
    const result = normalizeClaudeTerminalResponse({
      agentName: 'coder',
      sessionId: 'claude-session-1',
      assistantText,
    });

    expect(result).toMatchObject({
      persona: 'coder',
      status: 'done',
      content: assistantText,
      sessionId: 'claude-session-1',
    });
    expect(result.error).toBeUndefined();
    expect(result.rateLimitInfo).toBeUndefined();
  });

  it('Given assistant text contains only a reset time phrase, When normalizing, Then response remains done', () => {
    const assistantText = 'The cache resets 5:00 after the scheduled maintenance window.';

    const result = normalizeClaudeTerminalResponse({
      agentName: 'coder',
      sessionId: 'claude-session-1',
      assistantText,
    });

    expect(result).toMatchObject({
      persona: 'coder',
      status: 'done',
      content: assistantText,
      sessionId: 'claude-session-1',
    });
    expect(result.error).toBeUndefined();
    expect(result.rateLimitInfo).toBeUndefined();
  });

  it('Given bridged permission request event, When normalizing final response, Then event does not force provider error', () => {
    const result = normalizeClaudeTerminalResponse({
      agentName: 'coder',
      sessionId: 'claude-session-1',
      assistantText: 'done',
      events: [
        {
          type: 'permission_request',
          tool: 'Bash',
          input: { command: 'npm test' },
        },
      ],
    });

    expect(result).toMatchObject({
      persona: 'coder',
      status: 'done',
      content: 'done',
      sessionId: 'claude-session-1',
    });
    expect(result.error).toBeUndefined();
  });

  it('Given bridged ask-user question event, When normalizing final response, Then event does not force provider error', () => {
    const result = normalizeClaudeTerminalResponse({
      agentName: 'coder',
      sessionId: 'claude-session-1',
      assistantText: 'done',
      events: [
        {
          type: 'ask_user_question',
          questions: [{ question: 'Which option should I use?' }],
        },
      ],
    });

    expect(result).toMatchObject({
      persona: 'coder',
      status: 'done',
      content: 'done',
      sessionId: 'claude-session-1',
    });
    expect(result.error).toBeUndefined();
  });
});
