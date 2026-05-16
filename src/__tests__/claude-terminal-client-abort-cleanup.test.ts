import { access, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMockState = vi.hoisted(() => ({
  abortDuringWrite: undefined as (() => void) | undefined,
  writtenConfigPath: '',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
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

describe('Claude terminal client abort cleanup', () => {
  beforeEach(() => {
    fsMockState.abortDuringWrite = undefined;
    fsMockState.writtenConfigPath = '';
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
});
