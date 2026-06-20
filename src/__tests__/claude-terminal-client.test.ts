import { describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { USAGE_MISSING_REASONS } from '../core/logging/contracts.js';
import { callClaudeTerminal } from '../infra/claude-terminal/client.js';
import { initDebugLogger, resetDebugLogger } from '../shared/utils/index.js';

function createBackend() {
  return {
    start: vi.fn().mockResolvedValue({ id: 'tmux-session', name: 'takt-claude-terminal' }),
    pasteText: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function createTranscriptReader(response: unknown) {
  return {
    readBaseline: vi.fn().mockResolvedValue({ byteOffset: 0, lineNumberOffset: 0 }),
    findSession: vi.fn().mockResolvedValue({ sessionId: 'claude-session-1' }),
    waitForAssistantResponse: vi.fn().mockResolvedValue(response),
  };
}

describe('Claude terminal client', () => {
  it('Given mock terminal backend, When call succeeds, Then prompt is pasted and session is stopped by default', async () => {
    const backend = createBackend();
    const transcriptReader = createTranscriptReader({
      sessionId: 'claude-session-1',
      assistantText: 'done',
      events: [],
    });

    const result = await callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      timeoutMs: 1000,
      keepSession: false,
      terminalBackend: backend,
      transcriptReader,
    });

    expect(backend.start).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/worktree',
      backend: 'tmux',
      command: expect.objectContaining({
        args: expect.arrayContaining(['--session-id']),
      }),
    }));
    expect(backend.pasteText).toHaveBeenCalledWith({ id: 'tmux-session', name: 'takt-claude-terminal' }, 'implement task');
    expect(transcriptReader.readBaseline).toHaveBeenCalledWith({
      cwd: '/tmp/worktree',
      sessionId: expect.any(String),
    });
    expect(transcriptReader.findSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/worktree',
      sessionId: expect.any(String),
      timeoutMs: 1000,
    }));
    expect(transcriptReader.waitForAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      session: { sessionId: 'claude-session-1' },
      baseline: { byteOffset: 0, lineNumberOffset: 0 },
      cwd: '/tmp/worktree',
      timeoutMs: 1000,
    }));
    expect(backend.stop).toHaveBeenCalledWith({ id: 'tmux-session', name: 'takt-claude-terminal' });
    expect(result).toMatchObject({
      persona: 'coder',
      status: 'done',
      content: 'done',
      sessionId: 'claude-session-1',
    });
  });

  it('Given mcpServers, When call succeeds, Then Claude command receives a temporary mcp config and cleanup removes it', async () => {
    const backend = createBackend();
    let mcpConfigPath = '';
    let mcpConfigJson = '';
    backend.start.mockImplementation(async (options) => {
      const configFlagIndex = options.command.args.indexOf('--mcp-config');
      mcpConfigPath = options.command.args[configFlagIndex + 1];
      mcpConfigJson = await readFile(mcpConfigPath, 'utf-8');
      return { id: 'tmux-session', name: 'takt-claude-terminal' };
    });
    const transcriptReader = createTranscriptReader({
      sessionId: 'claude-session-1',
      assistantText: 'done',
      events: [],
    });

    await callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      mcpServers: {
        docs: { type: 'stdio', command: 'docs-mcp', args: ['serve'] },
      },
      terminalBackend: backend,
      transcriptReader,
    });

    expect(mcpConfigPath).toMatch(/mcp-config\.json$/);
    expect(JSON.parse(mcpConfigJson)).toEqual({
      mcpServers: {
        docs: { type: 'stdio', command: 'docs-mcp', args: ['serve'] },
      },
    });
    expect(backend.start).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.objectContaining({
        args: expect.arrayContaining(['--mcp-config', mcpConfigPath]),
      }),
    }));
    await expect(access(mcpConfigPath)).rejects.toThrow();
  });

  it('Given keepSession true, When call succeeds, Then terminal session is preserved', async () => {
    const backend = createBackend();
    const transcriptReader = createTranscriptReader({
      sessionId: 'claude-session-1',
      assistantText: 'done',
      events: [],
    });

    await callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      keepSession: true,
      terminalBackend: backend,
      transcriptReader,
    });

    expect(backend.stop).not.toHaveBeenCalled();
  });

  it('Given childProcessEnv, When call starts terminal, Then backend receives the same snapshot', async () => {
    const backend = createBackend();
    const transcriptReader = createTranscriptReader({
      sessionId: 'claude-session-1',
      assistantText: 'done',
      events: [],
    });
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };

    await callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      terminalBackend: backend,
      transcriptReader,
      childProcessEnv,
    });

    expect(backend.start).toHaveBeenCalledWith(expect.objectContaining({
      childProcessEnv,
    }));
  });

  it('Given abortSignal fires during transcript wait, When call is running, Then terminal session is stopped and external_abort is returned', async () => {
    const backend = createBackend();
    const controller = new AbortController();
    const transcriptReader = {
      readBaseline: vi.fn().mockResolvedValue({ byteOffset: 0, lineNumberOffset: 0 }),
      findSession: vi.fn().mockResolvedValue({ sessionId: 'claude-session-1' }),
      waitForAssistantResponse: vi.fn(() => new Promise(() => {})),
    };

    const resultPromise = callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      abortSignal: controller.signal,
      keepSession: true,
      terminalBackend: backend,
      transcriptReader,
    });

    await vi.waitFor(() => {
      expect(transcriptReader.waitForAssistantResponse).toHaveBeenCalled();
    });
    controller.abort(new Error('user interrupted'));
    const result = await resultPromise;

    expect(backend.stop).toHaveBeenCalledWith({ id: 'tmux-session', name: 'takt-claude-terminal' });
    expect(result).toMatchObject({
      persona: 'coder',
      status: 'error',
      failureCategory: 'external_abort',
      sessionId: 'claude-session-1',
    });
    expect(result.error).toMatch(/user interrupted|aborted/i);
  });

  it('Given abortSignal fires while terminal start is pending, When start later resolves, Then session is stopped', async () => {
    const backend = createBackend();
    const controller = new AbortController();
    const terminalSession = { id: 'tmux-session', name: 'takt-claude-terminal' };
    let resolveStart!: (session: typeof terminalSession) => void;
    const startPromise = new Promise<typeof terminalSession>((resolve) => {
      resolveStart = resolve;
    });
    backend.start.mockReturnValue(startPromise);
    const transcriptReader = createTranscriptReader({
      sessionId: 'claude-session-1',
      assistantText: 'unused',
      events: [],
    });

    const resultPromise = callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      abortSignal: controller.signal,
      keepSession: true,
      terminalBackend: backend,
      transcriptReader,
    });

    await vi.waitFor(() => {
      expect(backend.start).toHaveBeenCalled();
    });
    controller.abort(new Error('aborted during terminal start'));
    const result = await resultPromise;
    expect(backend.stop).not.toHaveBeenCalled();

    resolveStart(terminalSession);
    await vi.waitFor(() => {
      expect(backend.stop).toHaveBeenCalledWith(terminalSession);
    });

    expect(backend.pasteText).not.toHaveBeenCalled();
    expect(transcriptReader.readBaseline).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      persona: 'coder',
      status: 'error',
      failureCategory: 'external_abort',
    });
    expect(result.error).toMatch(/aborted during terminal start/i);
  });

  it('Given abortSignal fires while terminal start never resolves, When call is running, Then external_abort returns without waiting for start cleanup', async () => {
    const backend = createBackend();
    const controller = new AbortController();
    backend.start.mockReturnValue(new Promise(() => {}));
    const transcriptReader = createTranscriptReader({
      sessionId: 'claude-session-1',
      assistantText: 'unused',
      events: [],
    });

    const resultPromise = callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      abortSignal: controller.signal,
      keepSession: true,
      terminalBackend: backend,
      transcriptReader,
    });

    await vi.waitFor(() => {
      expect(backend.start).toHaveBeenCalled();
    });
    controller.abort(new Error('aborted while start is pending'));
    const outcome = await Promise.race([
      resultPromise,
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), 100);
      }),
    ]);

    expect(outcome).not.toBe('timeout');
    expect(outcome).toMatchObject({
      persona: 'coder',
      status: 'error',
      failureCategory: 'external_abort',
    });
    expect(backend.stop).not.toHaveBeenCalled();
    expect(backend.pasteText).not.toHaveBeenCalled();
    expect(transcriptReader.readBaseline).not.toHaveBeenCalled();
  });

  it('Given abortSignal fires while terminal start is pending, When start later rejects, Then delayed failure is logged', async () => {
    const backend = createBackend();
    const controller = new AbortController();
    let rejectStart!: (error: Error) => void;
    backend.start.mockReturnValue(new Promise((_resolve, reject) => {
      rejectStart = reject;
    }));
    const transcriptReader = createTranscriptReader({
      sessionId: 'claude-session-1',
      assistantText: 'unused',
      events: [],
    });
    const logDir = await mkdtemp(join(tmpdir(), 'takt-claude-terminal-'));
    const logFile = join(logDir, 'debug.log');
    resetDebugLogger();
    initDebugLogger({ enabled: true, logFile });

    try {
      const resultPromise = callClaudeTerminal('coder', 'implement task', {
        cwd: '/tmp/worktree',
        backend: 'tmux',
        abortSignal: controller.signal,
        keepSession: true,
        terminalBackend: backend,
        transcriptReader,
      });

      await vi.waitFor(() => {
        expect(backend.start).toHaveBeenCalled();
      });
      controller.abort(new Error('aborted before start rejected'));
      const result = await resultPromise;
      rejectStart(new Error('tmux start failed after abort'));

      await vi.waitFor(async () => {
        const logContent = await readFile(logFile, 'utf-8');
        expect(logContent).toContain('Claude terminal session start failed after abort');
        expect(logContent).toContain('tmux start failed after abort');
      });
      expect(result).toMatchObject({
        persona: 'coder',
        status: 'error',
        failureCategory: 'external_abort',
      });
      expect(backend.stop).not.toHaveBeenCalled();
      expect(backend.pasteText).not.toHaveBeenCalled();
      expect(transcriptReader.readBaseline).not.toHaveBeenCalled();
    } finally {
      resetDebugLogger();
    }
  });

  it('Given model and onStream, When session is discovered, Then init event is emitted with model and sessionId', async () => {
    const backend = createBackend();
    const onStream = vi.fn();
    const transcriptReader = createTranscriptReader({
      sessionId: 'claude-session-1',
      assistantText: 'done',
      events: [],
    });

    await callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      model: 'opus',
      onStream,
      terminalBackend: backend,
      transcriptReader,
    });

    expect(onStream).toHaveBeenCalledWith({
      type: 'init',
      data: {
        model: 'opus',
        sessionId: 'claude-session-1',
      },
    });
  });

  it('Given maxTurns, When call is invoked, Then unsupported provider error is returned before terminal start', async () => {
    const backend = createBackend();

    const result = await callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      maxTurns: 4,
      terminalBackend: backend,
      transcriptReader: createTranscriptReader({
        sessionId: 'claude-session-1',
        assistantText: 'unused',
        events: [],
      }),
    });

    expect(backend.start).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      persona: 'coder',
      status: 'error',
      failureCategory: 'provider_error',
      providerUsage: {
        usageMissing: true,
        reason: USAGE_MISSING_REASONS.NOT_SUPPORTED_BY_PROVIDER,
      },
    });
    expect(result.sessionId).toBeUndefined();
    expect(result.error).toMatch(/does not support maxTurns/i);
  });

  it('Given ask-user question event and callback, When call is invoked, Then callback answer is pasted and response wait continues', async () => {
    const backend = createBackend();
    const onPermissionRequest = vi.fn();
    const onAskUserQuestion = vi.fn().mockResolvedValue({ answer: 'Use option A.' });
    const transcriptReader = {
      readBaseline: vi.fn().mockResolvedValue({ byteOffset: 0, lineNumberOffset: 0 }),
      findSession: vi.fn().mockResolvedValue({ sessionId: 'claude-session-1' }),
      waitForAssistantResponse: vi.fn()
        .mockResolvedValueOnce({
          sessionId: 'claude-session-1',
          assistantText: '',
	          events: [
	            {
	              type: 'ask_user_question',
	              questions: [{ question: 'Which option should I use?' }],
	            },
	          ],
        })
        .mockResolvedValueOnce({
          sessionId: 'claude-session-1',
          assistantText: 'done after answer',
          events: [],
        }),
    };

    const result = await callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      onPermissionRequest,
      onAskUserQuestion,
      terminalBackend: backend,
      transcriptReader,
    });

    expect(backend.start).toHaveBeenCalledOnce();
    expect(onPermissionRequest).not.toHaveBeenCalled();
    expect(onAskUserQuestion).toHaveBeenCalledWith({
      questions: [{ question: 'Which option should I use?' }],
    });
    expect(backend.pasteText).toHaveBeenNthCalledWith(
      1,
      { id: 'tmux-session', name: 'takt-claude-terminal' },
      'implement task',
    );
    expect(backend.pasteText).toHaveBeenNthCalledWith(
      2,
      { id: 'tmux-session', name: 'takt-claude-terminal' },
      'Use option A.',
    );
    expect(transcriptReader.waitForAssistantResponse).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      persona: 'coder',
      status: 'done',
      content: 'done after answer',
      sessionId: 'claude-session-1',
    });
  });

  it('Given terminal backend start fails, When call returns error, Then provider usage missing reason is explicit', async () => {
    const backend = createBackend();
    backend.start.mockRejectedValue(new Error('tmux command not found. Install tmux to use provider: claude-terminal.'));

    const result = await callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      terminalBackend: backend,
      transcriptReader: createTranscriptReader({
        sessionId: 'claude-session-1',
        assistantText: 'unused',
        events: [],
      }),
    });

    expect(result).toMatchObject({
      persona: 'coder',
      status: 'error',
      failureCategory: 'provider_error',
      providerUsage: {
        usageMissing: true,
        reason: USAGE_MISSING_REASONS.NOT_SUPPORTED_BY_PROVIDER,
      },
    });
    expect(result.error).toMatch(/tmux command not found/i);
  });

  it('Given transcript wait times out, When call returns error, Then provider usage missing reason is explicit', async () => {
    const backend = createBackend();
    const transcriptReader = {
      readBaseline: vi.fn().mockResolvedValue({ byteOffset: 0, lineNumberOffset: 0 }),
      findSession: vi.fn().mockResolvedValue({ sessionId: 'claude-session-1' }),
      waitForAssistantResponse: vi.fn().mockRejectedValue(
        new Error('Timed out waiting for Claude terminal assistant response.'),
      ),
    };

    const result = await callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      terminalBackend: backend,
      transcriptReader,
    });

    expect(result).toMatchObject({
      persona: 'coder',
      status: 'error',
      failureCategory: 'provider_error',
      sessionId: 'claude-session-1',
      providerUsage: {
        usageMissing: true,
        reason: USAGE_MISSING_REASONS.NOT_SUPPORTED_BY_PROVIDER,
      },
    });
    expect(result.error).toMatch(/timed out waiting/i);
  });

  it('Given session discovery fails after terminal start, When call returns error, Then generated session id is retained', async () => {
    const backend = createBackend();
    let generatedSessionId = '';
    backend.start.mockImplementation(async (options) => {
      const sessionIdFlagIndex = options.command.args.indexOf('--session-id');
      generatedSessionId = options.command.args[sessionIdFlagIndex + 1];
      return { id: 'tmux-session', name: 'takt-claude-terminal' };
    });
    const transcriptReader = {
      readBaseline: vi.fn().mockResolvedValue({ byteOffset: 0, lineNumberOffset: 0 }),
      findSession: vi.fn().mockRejectedValue(
        new Error('Timed out waiting for Claude terminal session.'),
      ),
      waitForAssistantResponse: vi.fn(),
    };

    const result = await callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      terminalBackend: backend,
      transcriptReader,
    });

    expect(generatedSessionId).toEqual(expect.any(String));
    expect(result).toMatchObject({
      persona: 'coder',
      status: 'error',
      failureCategory: 'provider_error',
      sessionId: generatedSessionId,
    });
    expect(transcriptReader.waitForAssistantResponse).not.toHaveBeenCalled();
    expect(result.error).toMatch(/timed out waiting/i);
  });

  it('Given permission request event and callback, When call returns, Then permission decision is pasted and response wait continues', async () => {
    const backend = createBackend();
    const onPermissionRequest = vi.fn().mockResolvedValue({ behavior: 'allow' });
    const transcriptReader = {
      readBaseline: vi.fn().mockResolvedValue({ byteOffset: 0, lineNumberOffset: 0 }),
      findSession: vi.fn().mockResolvedValue({ sessionId: 'claude-session-1' }),
      waitForAssistantResponse: vi.fn()
        .mockResolvedValueOnce({
          sessionId: 'claude-session-1',
          assistantText: '',
          events: [
            {
              type: 'permission_request',
              tool: 'Bash',
              input: { command: 'npm test' },
            },
          ],
        })
        .mockResolvedValueOnce({
          sessionId: 'claude-session-1',
          assistantText: 'tests passed',
          events: [],
        }),
    };

    const result = await callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      onPermissionRequest,
      terminalBackend: backend,
      transcriptReader,
    });

    expect(onPermissionRequest).toHaveBeenCalledWith({
      toolName: 'Bash',
      input: { command: 'npm test' },
    });
    expect(backend.pasteText).toHaveBeenNthCalledWith(
      1,
      { id: 'tmux-session', name: 'takt-claude-terminal' },
      'implement task',
    );
    expect(backend.pasteText).toHaveBeenNthCalledWith(
      2,
      { id: 'tmux-session', name: 'takt-claude-terminal' },
      'yes',
    );
    expect(transcriptReader.waitForAssistantResponse).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      persona: 'coder',
      status: 'done',
      content: 'tests passed',
      sessionId: 'claude-session-1',
    });
  });

  it('Given multiple interactive events in one transcript batch, When call returns, Then every callback reply is pasted before continuing', async () => {
    const backend = createBackend();
    const onPermissionRequest = vi.fn().mockResolvedValue({ behavior: 'allow' });
    const onAskUserQuestion = vi.fn().mockResolvedValue({ answer: 'Use option B.' });
    const transcriptReader = {
      readBaseline: vi.fn().mockResolvedValue({ byteOffset: 0, lineNumberOffset: 0 }),
      findSession: vi.fn().mockResolvedValue({ sessionId: 'claude-session-1' }),
      waitForAssistantResponse: vi.fn()
        .mockResolvedValueOnce({
          sessionId: 'claude-session-1',
          assistantText: '',
          events: [
            {
              type: 'permission_request',
              tool: 'Bash',
              input: { command: 'npm test' },
            },
            {
              type: 'ask_user_question',
              questions: [{ question: 'Which option should I use?' }],
            },
          ],
        })
        .mockResolvedValueOnce({
          sessionId: 'claude-session-1',
          assistantText: 'continued after both replies',
          events: [],
        }),
    };

    const result = await callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      onPermissionRequest,
      onAskUserQuestion,
      terminalBackend: backend,
      transcriptReader,
    });

    expect(onPermissionRequest).toHaveBeenCalledWith({
      toolName: 'Bash',
      input: { command: 'npm test' },
    });
    expect(onAskUserQuestion).toHaveBeenCalledWith({
      questions: [{ question: 'Which option should I use?' }],
    });
    expect(backend.pasteText).toHaveBeenNthCalledWith(
      1,
      { id: 'tmux-session', name: 'takt-claude-terminal' },
      'implement task',
    );
    expect(backend.pasteText).toHaveBeenNthCalledWith(
      2,
      { id: 'tmux-session', name: 'takt-claude-terminal' },
      'yes',
    );
    expect(backend.pasteText).toHaveBeenNthCalledWith(
      3,
      { id: 'tmux-session', name: 'takt-claude-terminal' },
      'Use option B.',
    );
    expect(transcriptReader.waitForAssistantResponse).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      persona: 'coder',
      status: 'done',
      content: 'continued after both replies',
      sessionId: 'claude-session-1',
    });
  });

		  it('Given permission request event without callback, When call returns, Then provider error is explicit', async () => {
    const backend = createBackend();

    const result = await callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      terminalBackend: backend,
      transcriptReader: createTranscriptReader({
        sessionId: 'claude-session-1',
        assistantText: '',
        events: [
          {
            type: 'permission_request',
            tool: 'Bash',
            input: { command: 'npm test' },
          },
        ],
      }),
    });

    expect(result).toMatchObject({
      persona: 'coder',
      status: 'error',
      failureCategory: 'provider_error',
      providerUsage: {
        usageMissing: true,
        reason: USAGE_MISSING_REASONS.NOT_SUPPORTED_BY_PROVIDER,
      },
    });
	    expect(result.error).toMatch(/no onPermissionRequest handler/i);
	  });

	  it('Given permission callback returns updated input or permissions, When call returns, Then provider error is explicit', async () => {
	    const backend = createBackend();
	    const onPermissionRequest = vi.fn().mockResolvedValue({
	      behavior: 'allow',
	      updatedInput: { command: 'npm test -- --runInBand' },
	      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits' }],
	    });

	    const result = await callClaudeTerminal('coder', 'implement task', {
	      cwd: '/tmp/worktree',
	      backend: 'tmux',
	      onPermissionRequest,
	      terminalBackend: backend,
	      transcriptReader: createTranscriptReader({
	        sessionId: 'claude-session-1',
	        assistantText: '',
	        events: [
	          {
	            type: 'permission_request',
	            tool: 'Bash',
	            input: { command: 'npm test' },
	          },
	        ],
	      }),
	    });

	    expect(onPermissionRequest).toHaveBeenCalledWith({
	      toolName: 'Bash',
	      input: { command: 'npm test' },
	    });
	    expect(backend.pasteText).toHaveBeenCalledOnce();
	    expect(result).toMatchObject({
	      persona: 'coder',
	      status: 'error',
	      failureCategory: 'provider_error',
	      sessionId: 'claude-session-1',
	    });
	    expect(result.error).toMatch(/cannot apply updated permission input or rules/i);
	  });

	  it('Given permission callback denies with message, When call returns, Then deny reply is pasted and response wait continues', async () => {
	    const backend = createBackend();
	    const onPermissionRequest = vi.fn().mockResolvedValue({
	      behavior: 'deny',
	      message: 'Use a read-only command.',
	    });
	    const transcriptReader = {
	      readBaseline: vi.fn().mockResolvedValue({ byteOffset: 0, lineNumberOffset: 0 }),
	      findSession: vi.fn().mockResolvedValue({ sessionId: 'claude-session-1' }),
	      waitForAssistantResponse: vi.fn()
	        .mockResolvedValueOnce({
	          sessionId: 'claude-session-1',
	          assistantText: '',
	          events: [
	            {
	              type: 'permission_request',
	              tool: 'Bash',
	              input: { command: 'rm -rf dist' },
	            },
	          ],
	        })
	        .mockResolvedValueOnce({
	          sessionId: 'claude-session-1',
	          assistantText: 'used a safer command',
	          events: [],
	        }),
	    };

	    const result = await callClaudeTerminal('coder', 'implement task', {
	      cwd: '/tmp/worktree',
	      backend: 'tmux',
	      onPermissionRequest,
	      terminalBackend: backend,
	      transcriptReader,
	    });

	    expect(backend.pasteText).toHaveBeenNthCalledWith(
	      2,
	      { id: 'tmux-session', name: 'takt-claude-terminal' },
	      'no\nUse a read-only command.',
	    );
	    expect(transcriptReader.waitForAssistantResponse).toHaveBeenCalledTimes(2);
	    expect(result).toMatchObject({
	      persona: 'coder',
	      status: 'done',
	      content: 'used a safer command',
	      sessionId: 'claude-session-1',
	    });
	  });

	  it('Given permission callback denies with interrupt, When call returns, Then provider error is explicit', async () => {
	    const backend = createBackend();
	    const onPermissionRequest = vi.fn().mockResolvedValue({
	      behavior: 'deny',
	      message: 'Stop.',
	      interrupt: true,
	    });

	    const result = await callClaudeTerminal('coder', 'implement task', {
	      cwd: '/tmp/worktree',
	      backend: 'tmux',
	      onPermissionRequest,
	      terminalBackend: backend,
	      transcriptReader: createTranscriptReader({
	        sessionId: 'claude-session-1',
	        assistantText: '',
	        events: [
	          {
	            type: 'permission_request',
	            tool: 'Bash',
	            input: { command: 'npm test' },
	          },
	        ],
	      }),
	    });

	    expect(backend.pasteText).toHaveBeenCalledOnce();
	    expect(result).toMatchObject({
	      persona: 'coder',
	      status: 'error',
	      failureCategory: 'provider_error',
	      sessionId: 'claude-session-1',
	    });
	    expect(result.error).toMatch(/cannot interrupt a terminal permission request/i);
	  });

	  it('Given ask-user callback returns no answer text, When call returns, Then provider error is explicit', async () => {
	    const backend = createBackend();
	    const onAskUserQuestion = vi.fn().mockResolvedValue({ answer: '' });

	    const result = await callClaudeTerminal('coder', 'implement task', {
	      cwd: '/tmp/worktree',
	      backend: 'tmux',
	      onAskUserQuestion,
	      terminalBackend: backend,
	      transcriptReader: createTranscriptReader({
	        sessionId: 'claude-session-1',
	        assistantText: '',
	        events: [
	          {
	            type: 'ask_user_question',
	            questions: [{ question: 'Which option should I use?' }],
	          },
	        ],
	      }),
	    });

	    expect(onAskUserQuestion).toHaveBeenCalledWith({
	      questions: [{ question: 'Which option should I use?' }],
	    });
	    expect(backend.pasteText).toHaveBeenCalledOnce();
	    expect(result).toMatchObject({
	      persona: 'coder',
	      status: 'error',
	      failureCategory: 'provider_error',
	      sessionId: 'claude-session-1',
	    });
	    expect(result.error).toMatch(/returned no answer text/i);
	  });

	  it('Given abortSignal fires while permission callback is pending, When call is running, Then terminal session is stopped and no reply is pasted', async () => {
	    const backend = createBackend();
	    const controller = new AbortController();
	    const onPermissionRequest = vi.fn(() => new Promise<never>(() => {}));
	    const transcriptReader = {
	      readBaseline: vi.fn().mockResolvedValue({ byteOffset: 0, lineNumberOffset: 0 }),
	      findSession: vi.fn().mockResolvedValue({ sessionId: 'claude-session-1' }),
	      waitForAssistantResponse: vi.fn().mockResolvedValue({
	        sessionId: 'claude-session-1',
	        assistantText: '',
	        events: [
	          {
	            type: 'permission_request',
	            tool: 'Bash',
	            input: { command: 'npm test' },
	          },
	        ],
	      }),
	    };

	    const resultPromise = callClaudeTerminal('coder', 'implement task', {
	      cwd: '/tmp/worktree',
	      backend: 'tmux',
	      abortSignal: controller.signal,
	      keepSession: true,
	      onPermissionRequest,
	      terminalBackend: backend,
	      transcriptReader,
	    });

	    await vi.waitFor(() => {
	      expect(onPermissionRequest).toHaveBeenCalled();
	    });
	    controller.abort(new Error('aborted during permission callback'));
	    const outcome = await Promise.race([
	      resultPromise,
	      new Promise<'timeout'>((resolve) => {
	        setTimeout(() => resolve('timeout'), 100);
	      }),
	    ]);

	    expect(outcome).not.toBe('timeout');
	    expect(outcome).toMatchObject({
	      persona: 'coder',
	      status: 'error',
	      failureCategory: 'external_abort',
	      sessionId: 'claude-session-1',
	    });
	    expect(backend.stop).toHaveBeenCalledWith({ id: 'tmux-session', name: 'takt-claude-terminal' });
	    expect(backend.pasteText).toHaveBeenCalledOnce();
	  });
	});
