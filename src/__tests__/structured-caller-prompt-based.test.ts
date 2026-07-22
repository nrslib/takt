import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunAgent, infoMock, createLoggerMock } = vi.hoisted(() => {
  const infoMock = vi.fn();
  const createLoggerMock = vi.fn(() => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: infoMock,
    error: vi.fn(),
    enter: vi.fn(),
    exit: vi.fn(),
  }));
  return {
    mockRunAgent: vi.fn(),
    infoMock,
    createLoggerMock,
  };
});

vi.mock('../shared/utils/debug.js', () => ({
  createLogger: createLoggerMock,
}));

vi.mock('../agents/runner.js', () => ({
  runAgent: mockRunAgent,
}));

import { PromptBasedStructuredCaller } from '../agents/structured-caller.js';
import { RETRY_DELAY_MS } from '../agents/structured-caller/prompt-based-structured-caller.js';
import { resolveStructuredStep } from '../agents/structured-caller/shared.js';

describe('PromptBasedStructuredCaller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    mockRunAgent.mockReset();
  });

  it('should evaluate conditions from [JUDGE:N] tags without outputSchema', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'default',
      status: 'done',
      content: '[JUDGE:6]',
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.evaluateCondition(
      'agent output',
      [
        { index: 2, text: 'approved' },
        { index: 5, text: 'needs_fix' },
      ],
      { cwd: '/tmp/project', provider: 'cursor' },
    );

    expect(result).toBe(5);
    expect(mockRunAgent).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('Output ONLY the tag `[JUDGE:N]`'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'cursor',
      }),
    );
  });

  it('should pass resolvedProvider and resolvedModel through evaluateCondition to runAgent (#556)', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'default',
      status: 'done',
      content: '[JUDGE:1]',
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.evaluateCondition(
      'agent output',
      [{ index: 0, text: 'approved' }],
      {
        cwd: '/tmp/project',
        provider: 'claude',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      },
    );

    expect(mockRunAgent).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('[JUDGE:N]'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'claude',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      }),
    );
  });

  it('should pass childProcessEnv through evaluateCondition to runAgent', async () => {
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };
    mockRunAgent.mockResolvedValue({
      persona: 'default',
      status: 'done',
      content: '[JUDGE:1]',
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.evaluateCondition(
      'agent output',
      [{ index: 0, text: 'approved' }],
      {
        cwd: '/tmp/project',
        provider: 'cursor',
        childProcessEnv,
      },
    );

    expect(mockRunAgent).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('[JUDGE:N]'),
      expect.objectContaining({ childProcessEnv }),
    );
  });

  it('should omit maxTurns for prompt-based evaluateCondition when resolved provider does not support it', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'default',
      status: 'done',
      content: '[JUDGE:1]',
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.evaluateCondition(
      'agent output',
      [{ index: 0, text: 'approved' }],
      {
        cwd: '/tmp/project',
        resolvedProvider: 'claude-terminal',
      },
    );

    expect(mockRunAgent).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('[JUDGE:N]'),
      expect.not.objectContaining({ maxTurns: expect.anything() }),
    );
  });

  it('should parse decomposed parts from fenced JSON without outputSchema', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify([
          { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
          { id: 'p2', title: 'Second task', instruction: 'Do the second thing' },
        ]),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'cursor',
      model: 'cursor-fast',
      persona: 'team-leader',
      personaPath: '/tmp/personas/team-leader.md',
    });

    expect(result.parts).toEqual([
      { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
      { id: 'p2', title: 'Second task', instruction: 'Do the second thing' },
    ]);
    expect(mockRunAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.stringContaining('```json'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'cursor',
        model: 'cursor-fast',
        personaPath: '/tmp/personas/team-leader.md',
      }),
    );
    const [, , callOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(callOptions).not.toHaveProperty('maxTurns');
    const [, , runOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(runOptions).not.toHaveProperty('outputSchema');
  });

  it('Given inspectTools, When prompt-based decomposeTask runs, Then it passes them to runAgent without outputSchema', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify([
          { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
        ]),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'cursor',
      persona: 'team-leader',
      inspectTools: ['Read', 'Glob', 'Grep'],
    });

    const [, , runOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(runOptions).toEqual(expect.objectContaining({
      allowedTools: ['Read', 'Glob', 'Grep'],
      permissionMode: 'readonly',
    }));
    expect(runOptions).not.toHaveProperty('outputSchema');
  });

  it('should pass resolvedProvider and resolvedModel through decomposeTask to runAgent', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify([
          { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
        ]),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'claude',
      resolvedProvider: 'cursor',
      model: 'sonnet',
      resolvedModel: 'cursor-fast',
      persona: 'team-leader',
    });

    expect(mockRunAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.stringContaining('```json'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'claude',
        resolvedProvider: 'cursor',
        model: 'sonnet',
        resolvedModel: 'cursor-fast',
      }),
    );
  });

  it('should pass mcpServers through decomposeTask to runAgent', async () => {
    const mcpServers = {
      docs: {
        type: 'stdio' as const,
        command: 'node',
        args: ['docs-server.js'],
      },
    };
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify([
          { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
        ]),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'cursor',
      persona: 'team-leader',
      mcpServers,
    });

    expect(mockRunAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.stringContaining('```json'),
      expect.objectContaining({ mcpServers }),
    );
  });

  it('should omit maxTurns for prompt-based decomposeTask when resolved provider does not support it', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify([
          { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
        ]),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      resolvedProvider: 'claude-terminal',
      persona: 'team-leader',
    });

    expect(mockRunAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.stringContaining('```json'),
      expect.not.objectContaining({ maxTurns: expect.anything() }),
    );
  });

  it('should pass workflowMeta through decomposeTask to runAgent', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify([
          { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
        ]),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });
    const workflowMeta = {
      workflowName: 'takt-default',
      currentStep: 'implement',
      stepsList: [{ name: 'plan' }, { name: 'implement' }],
      currentPosition: '2/2',
      processSafety: {
        protectedParentRunPid: 4242,
      },
    };

    const caller = new PromptBasedStructuredCaller();
    await caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'claude',
      persona: 'team-leader',
      workflowMeta,
    } as Parameters<PromptBasedStructuredCaller['decomposeTask']>[2] & { workflowMeta: typeof workflowMeta });

    expect(mockRunAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.stringContaining('```json'),
      expect.objectContaining({
        cwd: '/tmp/project',
        workflowMeta,
      }),
    );
  });

  it('should pass childProcessEnv through decomposeTask to runAgent', async () => {
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify([
          { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
        ]),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'cursor',
      persona: 'team-leader',
      childProcessEnv,
    });

    expect(mockRunAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.stringContaining('```json'),
      expect.objectContaining({ childProcessEnv }),
    );
  });

  it('should retry decomposeTask when first response has no JSON block and succeed on second attempt', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'done',
        content: 'no json here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'done',
        content: [
          '```json',
          JSON.stringify([
            { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
          ]),
          '```',
        ].join('\n'),
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const promise = caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'cursor',
      persona: 'team-leader',
    });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    const result = await promise;

    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(result.parts).toEqual([
      { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
    ]);
  });

  it('should retry decomposeTask when first response is an empty array and succeed on second attempt', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'done',
        content: '```json\n[]\n```',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'done',
        content: [
          '```json',
          JSON.stringify([
            { id: 'p1', title: 'Recovered', instruction: 'Do it' },
          ]),
          '```',
        ].join('\n'),
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const promise = caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'cursor',
      persona: 'team-leader',
    });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    const result = await promise;

    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(result.parts).toEqual([
      { id: 'p1', title: 'Recovered', instruction: 'Do it' },
    ]);
  });

  it('should throw decomposeTask after three consecutive failures', async () => {
    const failingResponse = {
      persona: 'leader',
      status: 'done',
      content: 'never any json',
      timestamp: new Date(),
    };
    mockRunAgent
      .mockResolvedValueOnce(failingResponse)
      .mockResolvedValueOnce(failingResponse)
      .mockResolvedValueOnce(failingResponse);

    const caller = new PromptBasedStructuredCaller();
    const promise = caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'cursor',
      persona: 'team-leader',
    });
    const assertion = expect(promise).rejects.toThrow(/```json \.\.\. ``` block/);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 2);
    await assertion;

    expect(mockRunAgent).toHaveBeenCalledTimes(3);
  });

  it('should retry decomposeTask when first response status is error and succeed on second attempt', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'error',
        content: '',
        error: 'provider failed',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'done',
        content: [
          '```json',
          JSON.stringify([
            { id: 'p1', title: 'Recovered', instruction: 'Do it' },
          ]),
          '```',
        ].join('\n'),
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const promise = caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'cursor',
      persona: 'team-leader',
    });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    const result = await promise;

    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(result.parts).toEqual([
      { id: 'p1', title: 'Recovered', instruction: 'Do it' },
    ]);
  });

  it('should report every decomposition provider response and rejection at attempt boundaries', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'error',
        content: '',
        error: 'first failed',
        timestamp: new Date(),
      })
      .mockRejectedValueOnce(new Error('second rejected'))
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'done',
        content: [
          '```json',
          JSON.stringify([
            { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
          ]),
          '```',
        ].join('\n'),
        timestamp: new Date(),
      });
    const onAgentResponse = vi.fn();
    const onAgentError = vi.fn();
    const caller = new PromptBasedStructuredCaller();

    const promise = caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'cursor',
      onAgentResponse,
      onAgentError,
    });
    const result = expect(promise).resolves.toMatchObject({ parts: [{ id: 'p1' }] });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 2);

    await result;
    expect(mockRunAgent).toHaveBeenCalledTimes(3);
    expect(onAgentResponse).toHaveBeenCalledTimes(2);
    expect(onAgentError).toHaveBeenCalledTimes(1);
    expect(onAgentError).toHaveBeenCalledWith(expect.objectContaining({ message: 'second rejected' }));
  });

  it('should throw decomposeTask after three consecutive status:error responses with original detail', async () => {
    const failingResponse = {
      persona: 'leader',
      status: 'error',
      content: '',
      error: 'provider blew up',
      timestamp: new Date(),
    };
    mockRunAgent
      .mockResolvedValueOnce(failingResponse)
      .mockResolvedValueOnce(failingResponse)
      .mockResolvedValueOnce(failingResponse);

    const caller = new PromptBasedStructuredCaller();
    const promise = caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'cursor',
      persona: 'team-leader',
    });
    const assertion = expect(promise).rejects.toThrow(/Team leader failed: provider blew up/);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 2);
    await assertion;

    expect(mockRunAgent).toHaveBeenCalledTimes(3);
  });

  it('should stop decomposeTask retries immediately after cancellation', async () => {
    const abortController = new AbortController();
    mockRunAgent.mockImplementationOnce(async () => {
      abortController.abort();
      return {
        persona: 'leader',
        status: 'error',
        content: '',
        error: 'cancelled',
        timestamp: new Date(),
      };
    });
    const caller = new PromptBasedStructuredCaller();

    await expect(caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'cursor',
      persona: 'team-leader',
      abortSignal: abortController.signal,
    })).rejects.toThrow('Structured call aborted');

    expect(mockRunAgent).toHaveBeenCalledOnce();
    expect(infoMock).not.toHaveBeenCalled();
  });

  it('should succeed decomposeTask on the third attempt (boundary case)', async () => {
    const failingResponse = {
      persona: 'leader',
      status: 'done',
      content: 'no json here',
      timestamp: new Date(),
    };
    mockRunAgent
      .mockResolvedValueOnce(failingResponse)
      .mockResolvedValueOnce(failingResponse)
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'done',
        content: [
          '```json',
          JSON.stringify([
            { id: 'p1', title: 'Late success', instruction: 'Done' },
          ]),
          '```',
        ].join('\n'),
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const promise = caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'cursor',
      persona: 'team-leader',
    });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 2);
    const result = await promise;

    expect(mockRunAgent).toHaveBeenCalledTimes(3);
    expect(result.parts).toEqual([
      { id: 'p1', title: 'Late success', instruction: 'Done' },
    ]);
  });

  it('should log one retry attempt when decomposeTask succeeds on second attempt', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'done',
        content: 'no json here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'done',
        content: [
          '```json',
          JSON.stringify([{ id: 'p1', title: 'Recovered', instruction: 'Do it' }]),
          '```',
        ].join('\n'),
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const promise = caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'cursor',
      persona: 'team-leader',
    });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    await promise;

    expect(infoMock).toHaveBeenCalledTimes(1);
    expect(infoMock).toHaveBeenCalledWith(
      'Structured call failed, retrying',
      expect.objectContaining({
        attempt: 1,
        maxAttempts: 3,
        error: expect.stringContaining('```json ... ``` block'),
      }),
    );
  });

  it('should parse additional parts from fenced JSON without outputSchema', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify({
          done: false,
          reasoning: 'Need one more pass',
          parts: [
            { id: 'p2', title: 'Follow up', instruction: 'Handle remaining gap' },
          ],
        }),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      { cwd: '/tmp/project', provider: 'cursor' },
    );

    expect(result).toEqual({
      done: false,
      reasoning: 'Need one more pass',
      parts: [
        { id: 'p2', title: 'Follow up', instruction: 'Handle remaining gap' },
      ],
    });
    expect(mockRunAgent).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('```json ... ```'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'cursor',
      }),
    );
  });

  it('prompt-based requestMoreParts は inspect tools を渡さず outputSchema も渡さない', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify({ done: true, reasoning: 'Enough', parts: [] }),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      {
        cwd: '/tmp/project',
        provider: 'cursor',
        inspectTools: ['Read', 'Glob', 'Grep'],
      } as Parameters<PromptBasedStructuredCaller['requestMoreParts']>[4] & { inspectTools: string[] },
    );

    const [, , runOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(runOptions).toEqual(expect.objectContaining({
      allowedTools: [],
      permissionMode: 'readonly',
    }));
    expect(runOptions).not.toHaveProperty('outputSchema');
  });

  it('should pass resolvedProvider and resolvedModel through requestMoreParts to runAgent', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify({ done: true, reasoning: 'enough', parts: [] }),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      {
        cwd: '/tmp/project',
        provider: 'claude',
        resolvedProvider: 'cursor',
        model: 'sonnet',
        resolvedModel: 'cursor-fast',
      },
    );

    expect(mockRunAgent).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('```json ... ```'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'claude',
        resolvedProvider: 'cursor',
        model: 'sonnet',
        resolvedModel: 'cursor-fast',
      }),
    );
  });

  it('should pass mcpServers through requestMoreParts to runAgent', async () => {
    const mcpServers = {
      docs: {
        type: 'stdio' as const,
        command: 'node',
        args: ['docs-server.js'],
      },
    };
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify({ done: true, reasoning: 'enough', parts: [] }),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      {
        cwd: '/tmp/project',
        provider: 'cursor',
        persona: 'team-leader',
        mcpServers,
      },
    );

    expect(mockRunAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.stringContaining('```json ... ```'),
      expect.objectContaining({ mcpServers }),
    );
  });

  it('should omit maxTurns for prompt-based requestMoreParts when resolved provider does not support it', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify({ done: true, reasoning: 'enough', parts: [] }),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      {
        cwd: '/tmp/project',
        resolvedProvider: 'claude-terminal',
      },
    );

    expect(mockRunAgent).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('```json ... ```'),
      expect.not.objectContaining({ maxTurns: expect.anything() }),
    );
  });

  it('should pass workflowMeta through requestMoreParts to runAgent', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify({ done: true, reasoning: 'enough', parts: [] }),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });
    const workflowMeta = {
      workflowName: 'takt-default',
      currentStep: 'implement',
      stepsList: [{ name: 'plan' }, { name: 'implement' }],
      currentPosition: '2/2',
      processSafety: {
        protectedParentRunPid: 4242,
      },
    };

    const caller = new PromptBasedStructuredCaller();
    await caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      {
        cwd: '/tmp/project',
        persona: 'team-leader',
        workflowMeta,
      } as Parameters<PromptBasedStructuredCaller['requestMoreParts']>[4] & { workflowMeta: typeof workflowMeta },
    );

    expect(mockRunAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.stringContaining('```json ... ```'),
      expect.objectContaining({
        cwd: '/tmp/project',
        workflowMeta,
      }),
    );
  });

  it('should pass childProcessEnv through requestMoreParts to runAgent', async () => {
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify({ done: true, reasoning: 'enough', parts: [] }),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      {
        cwd: '/tmp/project',
        persona: 'team-leader',
        childProcessEnv,
      },
    );

    expect(mockRunAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.stringContaining('```json ... ```'),
      expect.objectContaining({ childProcessEnv }),
    );
  });

  it('should retry requestMoreParts when first response has no JSON block and succeed on second attempt', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'done',
        content: 'no json here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'done',
        content: [
          '```json',
          JSON.stringify({
            done: false,
            reasoning: 'retry succeeded',
            parts: [
              { id: 'p2', title: 'Follow up', instruction: 'Handle remaining gap' },
            ],
          }),
          '```',
        ].join('\n'),
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const promise = caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      { cwd: '/tmp/project', provider: 'cursor' },
    );
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    const result = await promise;

    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      done: false,
      reasoning: 'retry succeeded',
      parts: [
        { id: 'p2', title: 'Follow up', instruction: 'Handle remaining gap' },
      ],
    });
  });

  it('should retry requestMoreParts when first response fails structural validation and succeed on second attempt', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'done',
        content: [
          '```json',
          JSON.stringify({ done: 'not-bool', reasoning: 'x', parts: [] }),
          '```',
        ].join('\n'),
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'done',
        content: [
          '```json',
          JSON.stringify({
            done: true,
            reasoning: 'recovered',
            parts: [],
          }),
          '```',
        ].join('\n'),
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const promise = caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      { cwd: '/tmp/project', provider: 'cursor' },
    );
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    const result = await promise;

    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      done: true,
      reasoning: 'recovered',
      parts: [],
    });
  });

  it('should throw requestMoreParts after three consecutive failures', async () => {
    const failingResponse = {
      persona: 'leader',
      status: 'done',
      content: 'never any json',
      timestamp: new Date(),
    };
    mockRunAgent
      .mockResolvedValueOnce(failingResponse)
      .mockResolvedValueOnce(failingResponse)
      .mockResolvedValueOnce(failingResponse);

    const caller = new PromptBasedStructuredCaller();
    const promise = caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      { cwd: '/tmp/project', provider: 'cursor' },
    );
    const assertion = expect(promise).rejects.toThrow(/```json \.\.\. ``` block/);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 2);
    await assertion;

    expect(mockRunAgent).toHaveBeenCalledTimes(3);
  });

  it('should retry requestMoreParts when first response status is error and succeed on second attempt', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'error',
        content: '',
        error: 'provider failed',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'done',
        content: [
          '```json',
          JSON.stringify({ done: true, reasoning: 'recovered', parts: [] }),
          '```',
        ].join('\n'),
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const promise = caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      { cwd: '/tmp/project', provider: 'cursor' },
    );
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    const result = await promise;

    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ done: true, reasoning: 'recovered', parts: [] });
  });

  it('should throw requestMoreParts after three consecutive status:error responses with original detail', async () => {
    const failingResponse = {
      persona: 'leader',
      status: 'error',
      content: '',
      error: 'provider blew up',
      timestamp: new Date(),
    };
    mockRunAgent
      .mockResolvedValueOnce(failingResponse)
      .mockResolvedValueOnce(failingResponse)
      .mockResolvedValueOnce(failingResponse);

    const caller = new PromptBasedStructuredCaller();
    const promise = caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      { cwd: '/tmp/project', provider: 'cursor' },
    );
    const assertion = expect(promise).rejects.toThrow(/Team leader feedback failed: provider blew up/);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 2);
    await assertion;

    expect(mockRunAgent).toHaveBeenCalledTimes(3);
  });

  it('should stop requestMoreParts retries immediately after cancellation', async () => {
    const abortController = new AbortController();
    mockRunAgent.mockImplementationOnce(async () => {
      abortController.abort();
      return {
        persona: 'leader',
        status: 'error',
        content: '',
        error: 'cancelled',
        timestamp: new Date(),
      };
    });
    const caller = new PromptBasedStructuredCaller();

    await expect(caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      {
        cwd: '/tmp/project',
        provider: 'cursor',
        abortSignal: abortController.signal,
      },
    )).rejects.toThrow('Structured call aborted');

    expect(mockRunAgent).toHaveBeenCalledOnce();
    expect(infoMock).not.toHaveBeenCalled();
  });

  it('should succeed requestMoreParts on the third attempt (boundary case)', async () => {
    const failingResponse = {
      persona: 'leader',
      status: 'done',
      content: 'no json here',
      timestamp: new Date(),
    };
    mockRunAgent
      .mockResolvedValueOnce(failingResponse)
      .mockResolvedValueOnce(failingResponse)
      .mockResolvedValueOnce({
        persona: 'leader',
        status: 'done',
        content: [
          '```json',
          JSON.stringify({ done: true, reasoning: 'late ok', parts: [] }),
          '```',
        ].join('\n'),
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const promise = caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      { cwd: '/tmp/project', provider: 'cursor' },
    );
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 2);
    const result = await promise;

    expect(mockRunAgent).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ done: true, reasoning: 'late ok', parts: [] });
  });

  it('should log two retry attempts when requestMoreParts fails three times', async () => {
    const failingResponse = {
      persona: 'leader',
      status: 'done',
      content: 'never any json',
      timestamp: new Date(),
    };
    mockRunAgent
      .mockResolvedValueOnce(failingResponse)
      .mockResolvedValueOnce(failingResponse)
      .mockResolvedValueOnce(failingResponse);

    const caller = new PromptBasedStructuredCaller();
    const promise = caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      { cwd: '/tmp/project', provider: 'cursor' },
    );
    const assertion = expect(promise).rejects.toThrow(/```json \.\.\. ``` block/);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 2);
    await assertion;

    expect(infoMock).toHaveBeenCalledTimes(2);
    expect(infoMock).toHaveBeenNthCalledWith(
      1,
      'Structured call failed, retrying',
      expect.objectContaining({ attempt: 1, maxAttempts: 3 }),
    );
    expect(infoMock).toHaveBeenNthCalledWith(
      2,
      'Structured call failed, retrying',
      expect.objectContaining({ attempt: 2, maxAttempts: 3 }),
    );
  });

  it('should reject a single candidate because auto-selection belongs to the workflow boundary', async () => {
    const caller = new PromptBasedStructuredCaller();
    await expect(caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [{ label: 'approved' }],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor' },
    )).rejects.toThrow('judgeStatus requires at least two semantic candidates');

    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it('should return structured_output when Stage 1 JSON step is valid', async () => {
    mockRunAgent.mockResolvedValueOnce({
      persona: 'conductor',
      status: 'done',
      content: '```json\n{"step": 2}\n```',
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { label: 'approved' },
        { label: 'rejected' },
      ],
      {
        cwd: '/tmp/project',
        stepName: 'review',
        provider: 'claude',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      },
    );

    expect(result).toEqual({ candidateIndex: 1, method: 'structured_output' });
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    expect(mockRunAgent).toHaveBeenNthCalledWith(
      1,
      'conductor',
      expect.stringContaining('structured instruction'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'claude',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      }),
    );
  });

  it('should return phase3_tag when Stage 1 fails and Stage 2 tag matches', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no json block here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: '[REVIEW:1]',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { label: 'approved' },
        { label: 'rejected' },
      ],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor' },
    );

    expect(result).toEqual({ candidateIndex: 0, method: 'phase3_tag' });
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });

  it('should pass structured prompt resolution callback to Stage 2', async () => {
    const onStructuredPromptResolved = vi.fn();
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no json block here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: '[REVIEW:1]',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [{ label: 'approved' }, { label: 'needs_fix' }],
      {
        cwd: '/tmp/project',
        stepName: 'review',
        provider: 'cursor',
        onStructuredPromptResolved,
      },
    );

    expect(mockRunAgent.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      onPromptResolved: onStructuredPromptResolved,
    }));
  });

  it('should return ai_judge when Stage 1 and Stage 2 fail and evaluateCondition succeeds', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no json block here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no matching tag',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'default',
        status: 'done',
        content: '[JUDGE:2]',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { label: 'approved' },
        { label: 'rejected' },
      ],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor' },
    );

    expect(result).toEqual({ candidateIndex: 1, method: 'ai_judge' });
    expect(mockRunAgent).toHaveBeenCalledTimes(3);
  });

  it('should report a rejected tag judgment after a completed structured attempt', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'not-json',
        timestamp: new Date(),
      })
      .mockRejectedValueOnce(new Error('tag provider rejected'));
    const onJudgeStage = vi.fn();
    const caller = new PromptBasedStructuredCaller();

    await expect(caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { label: 'approved' },
        { label: 'needs_fix' },
      ],
      { cwd: '/tmp/project', stepName: 'review', onJudgeStage },
    )).rejects.toThrow('tag provider rejected');

    expect(onJudgeStage).toHaveBeenCalledTimes(2);
    expect(onJudgeStage.mock.calls.map(([entry]) => entry.status)).toEqual(['done', 'error']);
    expect(onJudgeStage).toHaveBeenLastCalledWith(expect.objectContaining({
      stage: 2,
      method: 'phase3_tag',
      status: 'error',
      response: 'tag provider rejected',
    }));
  });

  it('should omit maxTurns for prompt-based judgeStatus internal stages when resolved provider does not support it', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no json block here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no matching tag',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'default',
        status: 'done',
        content: '[JUDGE:2]',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { label: 'approved' },
        { label: 'rejected' },
      ],
      { cwd: '/tmp/project', stepName: 'review', resolvedProvider: 'claude-terminal' },
    );

    expect(result).toEqual({ candidateIndex: 1, method: 'ai_judge' });
    expect(mockRunAgent).toHaveBeenCalledTimes(3);
    for (const call of mockRunAgent.mock.calls) {
      expect(call[2]).not.toHaveProperty('maxTurns');
    }
  });

  it('should pass abortSignal to all prompt-based judgeStatus provider calls', async () => {
    const abortController = new AbortController();
    mockRunAgent
      .mockResolvedValueOnce({ persona: 'conductor', status: 'done', content: 'no json block here', timestamp: new Date() })
      .mockResolvedValueOnce({ persona: 'conductor', status: 'done', content: 'no matching tag', timestamp: new Date() })
      .mockResolvedValueOnce({ persona: 'default', status: 'done', content: '[JUDGE:2]', timestamp: new Date() });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [{ label: 'approved' }, { label: 'needs_fix' }],
      { cwd: '/tmp/project', stepName: 'review', abortSignal: abortController.signal },
    );

    expect(result).toEqual({ candidateIndex: 1, method: 'ai_judge' });
    for (const call of mockRunAgent.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ abortSignal: abortController.signal }));
    }
  });

  it('should reject a pre-aborted signal without starting a prompt-based provider stage', async () => {
    const abortController = new AbortController();
    abortController.abort(new Error('cancelled before judgment'));
    const caller = new PromptBasedStructuredCaller();

    await expect(caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [{ label: 'approved' }, { label: 'needs_fix' }],
      { cwd: '/tmp/project', stepName: 'review', abortSignal: abortController.signal },
    )).rejects.toThrow('cancelled before judgment');

    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])(
    'should record prompt-based provider stage %i before stopping when the signal is aborted',
    async (abortStage) => {
      const abortController = new AbortController();
      const onJudgeStage = vi.fn();
      const providerUsages = [1, 2, 3].map((stage) => ({
        inputTokens: stage,
        outputTokens: stage,
        totalTokens: stage * 2,
        usageMissing: false,
      }));
      let stage = 0;
      mockRunAgent.mockImplementation(async () => {
        stage++;
        if (stage === abortStage) {
          abortController.abort(new Error(`cancelled during stage ${stage}`));
        }
        if (stage === 1) {
          return {
            persona: 'conductor',
            status: 'done',
            content: 'no json block',
            timestamp: new Date(),
            providerUsage: providerUsages[stage - 1],
          };
        }
        if (stage === 2) {
          return {
            persona: 'conductor',
            status: 'done',
            content: 'no matching tag',
            timestamp: new Date(),
            providerUsage: providerUsages[stage - 1],
          };
        }
        return {
          persona: 'default',
          status: 'done',
          content: '[JUDGE:2]',
          timestamp: new Date(),
          providerUsage: providerUsages[stage - 1],
        };
      });
      const caller = new PromptBasedStructuredCaller();

      await expect(caller.judgeStatus(
        'structured instruction',
        'tag instruction',
        [{ label: 'approved' }, { label: 'needs_fix' }],
        {
          cwd: '/tmp/project',
          stepName: 'review',
          abortSignal: abortController.signal,
          onJudgeStage,
        },
      )).rejects.toThrow(`cancelled during stage ${abortStage}`);

      expect(mockRunAgent).toHaveBeenCalledTimes(abortStage);
      expect(onJudgeStage).toHaveBeenCalledTimes(abortStage);
      for (let index = 0; index < abortStage; index++) {
        expect(onJudgeStage).toHaveBeenNthCalledWith(index + 1, expect.objectContaining({
          stage: index + 1,
          status: index + 1 === abortStage ? 'error' : 'done',
          providerUsage: providerUsages[index],
        }));
      }
    },
  );

  it('should use the provided candidate order for Stage 3 conditions', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no json block here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no matching tag',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'default',
        status: 'done',
        content: '[JUDGE:1]',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { label: 'approved' },
        { label: 'needs_fix' },
      ],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor' },
    );

    expect(result).toEqual({ candidateIndex: 0, method: 'ai_judge' });
    const [, judgePrompt] = mockRunAgent.mock.calls[2] ?? [];
    expect(judgePrompt).toContain('approved');
    expect(judgePrompt).toContain('needs_fix');
  });

  it('should retain every provided candidate for Stage 3 conditions', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no json block here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no matching tag',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'default',
        status: 'done',
        content: '[JUDGE:2]',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { label: 'approved' },
        { label: 'interactive-only-rule' },
      ],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor' },
    );

    expect(result).toEqual({ candidateIndex: 1, method: 'ai_judge' });
    const [, judgePrompt] = mockRunAgent.mock.calls[2] ?? [];
    expect(judgePrompt).toContain('interactive-only-rule');
  });

  it('should surface JSON parse failures when no fallback can determine status', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: '```json\n{"step": }\n```',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no judge tag',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'default',
        status: 'done',
        content: 'no judge tag',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();

    await expect(caller.judgeStatus(
      'structured',
      'tag instruction',
      [
        { label: 'approved' },
        { label: 'rejected' },
      ],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor' },
    )).rejects.toThrow('Structured response parsing failed');
  });
});

describe('resolveStructuredStep', () => {
  it('should convert 1-indexed step to 0-based rule index', () => {
    expect(resolveStructuredStep({ step: 1 })).toBe(0);
    expect(resolveStructuredStep({ step: 2 })).toBe(1);
  });

  it('should return -1 for step 0 (1-indexed, so 0 is invalid)', () => {
    expect(resolveStructuredStep({ step: 0 })).toBe(-1);
  });

  it('should return -1 for non-object values', () => {
    expect(resolveStructuredStep('foo')).toBe(-1);
    expect(resolveStructuredStep(42)).toBe(-1);
    expect(resolveStructuredStep(null)).toBe(-1);
    expect(resolveStructuredStep([])).toBe(-1);
  });

  it('should return -1 when step property is not a number', () => {
    expect(resolveStructuredStep({ step: 'two' })).toBe(-1);
    expect(resolveStructuredStep({ step: null })).toBe(-1);
  });
});
