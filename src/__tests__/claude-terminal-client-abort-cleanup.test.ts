import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMockState = vi.hoisted(() => ({
  abortDuringWrite: undefined as (() => void) | undefined,
  writtenConfigPath: '',
  readFileCount: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      fsMockState.readFileCount += 1;
      return await actual.readFile(...args);
    }),
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      fsMockState.writtenConfigPath = String(args[0]);
      await actual.writeFile(...args);
      fsMockState.abortDuringWrite?.();
    }),
  };
});

function createBackend() {
  return {
    start: vi.fn().mockResolvedValue({ id: 'tmux-session', name: 'takt-claude-terminal' }),
    pasteText: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function createTranscriptReader() {
  return {
    readBaseline: vi.fn().mockResolvedValue({ byteOffset: 0, lineNumberOffset: 0 }),
    findSession: vi.fn().mockResolvedValue({ sessionId: 'claude-session-1' }),
    waitForAssistantResponse: vi.fn().mockResolvedValue({
      sessionId: 'claude-session-1',
      assistantText: 'done',
      events: [],
    }),
  };
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('Claude terminal client abort cleanup', () => {
  beforeEach(() => {
    fsMockState.abortDuringWrite = undefined;
    fsMockState.writtenConfigPath = '';
    fsMockState.readFileCount = 0;
  });

  afterEach(async () => {
    fsMockState.abortDuringWrite = undefined;
    if (fsMockState.writtenConfigPath) {
      await rm(dirname(fsMockState.writtenConfigPath), { recursive: true, force: true });
    }
  });

  it('Given abort fires while MCP config is prepared, When call returns, Then the temporary config is cleaned up', async () => {
    const { callClaudeTerminal } = await import('../infra/claude-terminal/client.js');
    const controller = new AbortController();
    const backend = createBackend();
    fsMockState.abortDuringWrite = () => {
      controller.abort(new Error('aborted during mcp config preparation'));
    };

    const result = await callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      abortSignal: controller.signal,
      mcpServers: {
        docs: { type: 'stdio', command: 'docs-mcp', args: ['serve'] },
      },
      terminalBackend: backend,
      transcriptReader: createTranscriptReader(),
    });

    expect(backend.start).not.toHaveBeenCalled();
    expect(fsMockState.writtenConfigPath).toMatch(/mcp-config\.json$/);
    await expect(access(fsMockState.writtenConfigPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result).toMatchObject({
      persona: 'coder',
      status: 'error',
      failureCategory: 'external_abort',
    });
    expect(result.error).toMatch(/aborted during mcp config preparation/i);
  });

  it('Given abortSignal is provided, When client waits for transcript polling, Then reader polling receives the same signal', async () => {
    const { callClaudeTerminal } = await import('../infra/claude-terminal/client.js');
    const controller = new AbortController();
    const backend = createBackend();
    const transcriptReader = createTranscriptReader();

    await callClaudeTerminal('coder', 'implement task', {
      cwd: '/tmp/worktree',
      backend: 'tmux',
      abortSignal: controller.signal,
      terminalBackend: backend,
      transcriptReader,
    });

    expect(transcriptReader.findSession).toHaveBeenCalledWith(expect.objectContaining({
      abortSignal: controller.signal,
    }));
    expect(transcriptReader.waitForAssistantResponse).toHaveBeenCalledWith(expect.objectContaining({
      abortSignal: controller.signal,
    }));
  });

  it('Given abort fires during init stream, When the reader would reject an already aborted wait, Then polling is not started', async () => {
    const { callClaudeTerminal } = await import('../infra/claude-terminal/client.js');
    const controller = new AbortController();
    const backend = createBackend();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    const transcriptReader = {
      ...createTranscriptReader(),
      waitForAssistantResponse: vi.fn((args: { abortSignal?: AbortSignal }) => {
        if (args.abortSignal?.aborted) {
          return Promise.reject(new Error('reader observed aborted signal before wait'));
        }
        return Promise.resolve({
          sessionId: 'claude-session-1',
          assistantText: 'done',
          events: [],
        });
      }),
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const result = await callClaudeTerminal('coder', 'implement task', {
        cwd: '/tmp/worktree',
        backend: 'tmux',
        abortSignal: controller.signal,
        model: 'claude-sonnet-4-5',
        terminalBackend: backend,
        transcriptReader,
        onStream: () => {
          controller.abort(new Error('user interrupted after init'));
        },
      });
      await wait(0);

      expect(transcriptReader.waitForAssistantResponse).not.toHaveBeenCalled();
      expect(unhandledRejections).toEqual([]);
      expect(result).toMatchObject({
        persona: 'coder',
        status: 'error',
        failureCategory: 'external_abort',
      });
      expect(result.error).toMatch(/user interrupted after init/i);
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
    }
  });

  it('Given client aborts while the real transcript reader is polling, When call returns, Then terminal and polling timers are cleaned up', async () => {
    const originalHome = process.env.HOME;
    const homeDir = await mkdtemp(`${tmpdir()}/takt-claude-terminal-home-`);
    const projectDir = await mkdtemp(`${tmpdir()}/takt-claude-terminal-project-`);
    process.env.HOME = homeDir;

    try {
      const { callClaudeTerminal } = await import('../infra/claude-terminal/client.js');
      const { ProjectClaudeTranscriptReader } = await import('../infra/claude-terminal/transcript-reader.js');
      const { getClaudeProjectSessionsDir } = await import('../infra/config/project/sessionStore.js');
      const controller = new AbortController();
      const backend = createBackend();
      const sessionId = 'claude-session-1';

      const resultPromise = callClaudeTerminal('coder', 'implement task', {
        cwd: projectDir,
        backend: 'tmux',
        abortSignal: controller.signal,
        sessionId,
        keepSession: true,
        timeoutMs: 200,
        transcriptPollIntervalMs: 10,
        terminalBackend: backend,
        transcriptReader: new ProjectClaudeTranscriptReader(),
      });

      await vi.waitFor(() => {
        expect(backend.pasteText).toHaveBeenCalled();
        expect(fsMockState.readFileCount).toBeGreaterThan(0);
      });
      const readCountAtAbort = fsMockState.readFileCount;

      controller.abort(new Error('user interrupted while transcript polling'));
      const result = await resultPromise;
      const sessionsDir = getClaudeProjectSessionsDir(projectDir);
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(join(sessionsDir, `${sessionId}.jsonl`), JSON.stringify({
        type: 'user',
        session_id: sessionId,
        message: { role: 'user', content: [{ type: 'text', text: 'late prompt' }] },
      }), 'utf-8');
      await wait(30);

      expect(backend.stop).toHaveBeenCalledWith({ id: 'tmux-session', name: 'takt-claude-terminal' });
      expect(result).toMatchObject({
        persona: 'coder',
        status: 'error',
        failureCategory: 'external_abort',
      });
      expect(result.error).toMatch(/user interrupted while transcript polling/i);
      expect(fsMockState.readFileCount).toBe(readCountAtAbort);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      await rm(homeDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
