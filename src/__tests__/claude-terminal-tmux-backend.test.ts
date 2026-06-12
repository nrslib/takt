import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockExecFile,
  mockSpawn,
} = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
  spawn: mockSpawn,
}));

import { TmuxTerminalBackend } from '../infra/claude-terminal/tmux-backend.js';

function mockExecFileSuccess(): void {
  let captureCount = 0;
  mockExecFile.mockImplementation((_file, _args, _options, callback) => {
    if (_args[0] === 'capture-pane') {
      captureCount += 1;
      const stdout = captureCount === 1 ? '❯' : `pane-${captureCount}`;
      callback(null, { stdout, stderr: '' });
      return;
    }
    callback(null, { stdout: '', stderr: '' });
  });
}

function createExecFileError(message: string, code: number, stderr: string): Error & { code: number; stderr: string } {
  return Object.assign(new Error(message), { code, stderr });
}

function createSpawnChild(stdinWrites: string[], exitCode: number, stderrText: string) {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stdin: { end: ReturnType<typeof vi.fn> };
  };
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stderr.setEncoding = vi.fn();
  child.stderr = stderr;
  child.stdin = {
    end: vi.fn((text: string) => {
      stdinWrites.push(text);
      if (stderrText.length > 0) {
        stderr.emit('data', stderrText);
      }
      queueMicrotask(() => child.emit('close', exitCode));
    }),
  };
  return child;
}

function getNonCaptureTmuxArgs(): unknown[] {
  return mockExecFile.mock.calls
    .map((call) => call[1])
    .filter((args) => args[0] !== 'capture-pane');
}

describe('TmuxTerminalBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSuccess();
    mockSpawn.mockImplementation(() => createSpawnChild([], 0, ''));
  });

  it('Given terminal start options, When start is called, Then tmux new-session receives cwd and Claude command', async () => {
    const backend = new TmuxTerminalBackend();

    const session = await backend.start({
      cwd: '/tmp/worktree',
      backend: 'tmux',
      command: {
        executable: 'claude',
        args: ['--model', 'opus'],
      },
    });

    expect(session.name).toMatch(/^takt-claude-terminal-/);
    expect(mockExecFile).toHaveBeenCalledWith(
      'tmux',
      [
        'new-session',
        '-d',
        '-s',
        session.name,
        '-c',
        '/tmp/worktree',
        'claude',
        '--model',
        'opus',
      ],
      {
        cwd: '/tmp/worktree',
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024 * 4,
        env: expect.any(Object),
      },
      expect.any(Function),
    );
  });

  it('Given childProcessEnv, When start is called, Then tmux new-session receives nested observability env args', async () => {
    const backend = new TmuxTerminalBackend();
    const previousTaktObservability = process.env.TAKT_OBSERVABILITY;
    const previousOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient.example.test';

    try {
      await backend.start({
        cwd: '/tmp/worktree',
        backend: 'tmux',
        command: {
          executable: 'claude',
          args: [],
        },
        childProcessEnv: {
          TAKT_OBSERVABILITY: '{"enabled":true}',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
          OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer secret',
          OTEL_EXPORTER_OTLP_CLIENT_KEY: '/tmp/client.key',
        },
      });

      const newSessionArgs = mockExecFile.mock.calls[0]?.[1];
      expect(newSessionArgs).toEqual([
        'new-session',
        '-d',
        '-s',
        expect.stringMatching(/^takt-claude-terminal-/),
        '-c',
        '/tmp/worktree',
        '-e',
        'TAKT_OBSERVABILITY={"enabled":true}',
        '-e',
        'OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.test',
        'claude',
      ]);
      expect(newSessionArgs).not.toContain('TAKT_OBSERVABILITY={"enabled":false}');
      expect(newSessionArgs).not.toContain('OTEL_EXPORTER_OTLP_ENDPOINT=https://ambient.example.test');
      expect(newSessionArgs).not.toContain('OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer secret');
      expect(newSessionArgs).not.toContain('OTEL_EXPORTER_OTLP_CLIENT_KEY=/tmp/client.key');
    } finally {
      if (previousTaktObservability === undefined) {
        delete process.env.TAKT_OBSERVABILITY;
      } else {
        process.env.TAKT_OBSERVABILITY = previousTaktObservability;
      }
      if (previousOtlpEndpoint === undefined) {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      } else {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousOtlpEndpoint;
      }
    }
  });

  it('Given prompt text, When pasteText is called, Then tmux waits for prompt and submits pasted text', async () => {
    const backend = new TmuxTerminalBackend();
    const stdinWrites: string[] = [];
    mockSpawn.mockImplementation(() => createSpawnChild(stdinWrites, 0, ''));

    await backend.pasteText({ id: 'tmux-session', name: 'takt-session' }, 'implement task');

    expect(mockSpawn).toHaveBeenCalledWith('tmux', ['load-buffer', '-b', 'takt-session-prompt', '-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    expect(stdinWrites).toEqual(['implement task']);
    expect(mockExecFile.mock.calls.map((call) => call[1][0])).toEqual([
      'capture-pane',
      'capture-pane',
      'paste-buffer',
      'capture-pane',
      'send-keys',
      'delete-buffer',
    ]);
    expect(getNonCaptureTmuxArgs()).toEqual([
      ['paste-buffer', '-p', '-b', 'takt-session-prompt', '-t', 'takt-session'],
      ['send-keys', '-t', 'takt-session', 'Enter'],
      ['delete-buffer', '-b', 'takt-session-prompt'],
    ]);
  });

  it('Given Claude pane is still busy, When pasteText is called, Then prompt is not pasted until input is ready', async () => {
    const backend = new TmuxTerminalBackend();
    const stdinWrites: string[] = [];
    const capturedPanes = [
      'Running tool...',
      'Thinking...',
      'Ready\n❯\n? for shortcuts',
      'Ready\n❯\n? for shortcuts',
      'prompt entered',
    ];
    mockSpawn.mockImplementation(() => createSpawnChild(stdinWrites, 0, ''));
    mockExecFile.mockImplementation((_file, args, _options, callback) => {
      if (args[0] === 'capture-pane') {
        callback(null, { stdout: capturedPanes.shift() ?? 'prompt entered', stderr: '' });
        return;
      }
      callback(null, { stdout: '', stderr: '' });
    });

    await backend.pasteText({ id: 'tmux-session', name: 'takt-session' }, 'implement task');

    expect(stdinWrites).toEqual(['implement task']);
    expect(mockExecFile.mock.calls.map((call) => call[1][0])).toEqual([
      'capture-pane',
      'capture-pane',
      'capture-pane',
      'capture-pane',
      'paste-buffer',
      'capture-pane',
      'send-keys',
      'delete-buffer',
    ]);
  });

  it('Given old busy output remains in pane history, When tail prompt is ready, Then prompt is pasted', async () => {
    const backend = new TmuxTerminalBackend();
    const stdinWrites: string[] = [];
    const readyPaneWithHistory = [
      'Running tool...',
      'Tool completed',
      'Ready',
      '❯',
      '? for shortcuts',
    ].join('\n');
    const capturedPanes = [
      readyPaneWithHistory,
      readyPaneWithHistory,
      'implement task',
    ];
    mockSpawn.mockImplementation(() => createSpawnChild(stdinWrites, 0, ''));
    mockExecFile.mockImplementation((_file, args, _options, callback) => {
      if (args[0] === 'capture-pane') {
        callback(null, { stdout: capturedPanes.shift() ?? 'implement task', stderr: '' });
        return;
      }
      callback(null, { stdout: '', stderr: '' });
    });

    await backend.pasteText({ id: 'tmux-session', name: 'takt-session' }, 'implement task');

    expect(stdinWrites).toEqual(['implement task']);
    expect(mockExecFile.mock.calls.map((call) => call[1][0])).toEqual([
      'capture-pane',
      'capture-pane',
      'paste-buffer',
      'capture-pane',
      'send-keys',
      'delete-buffer',
    ]);
  });

  it('Given Claude trust dialog with numbered menu, When pasteText is called, Then trust dialog is not treated as ready and prompt is only pasted after transition to real input', async () => {
    const backend = new TmuxTerminalBackend();
    const stdinWrites: string[] = [];
    const trustDialogPane = [
      '────────────────────────────────────────',
      '❯ 1. Yes, I trust this folder',
      '  2. No, exit',
    ].join('\n');
    const realReadyPane = [
      '────────────────────────────────────────',
      '❯ Try "refactor routing.ts"',
      '────────────────────────────────────────',
    ].join('\n');
    const capturedPanes = [
      trustDialogPane,
      trustDialogPane,
      realReadyPane,
      realReadyPane,
      'pasted prompt',
    ];
    mockSpawn.mockImplementation(() => createSpawnChild(stdinWrites, 0, ''));
    mockExecFile.mockImplementation((_file, args, _options, callback) => {
      if (args[0] === 'capture-pane') {
        callback(null, { stdout: capturedPanes.shift() ?? 'pasted prompt', stderr: '' });
        return;
      }
      callback(null, { stdout: '', stderr: '' });
    });

    await backend.pasteText({ id: 'tmux-session', name: 'takt-session' }, 'implement task');

    expect(stdinWrites).toEqual(['implement task']);
    expect(mockExecFile.mock.calls.map((call) => call[1][0])).toEqual([
      'capture-pane',
      'capture-pane',
      'capture-pane',
      'capture-pane',
      'paste-buffer',
      'capture-pane',
      'send-keys',
      'delete-buffer',
    ]);
  });

  it('Given Claude v2.1 pane with placeholder hint after prompt char, When pasteText is called, Then prompt is detected as ready', async () => {
    const backend = new TmuxTerminalBackend();
    const stdinWrites: string[] = [];
    const v21ReadyPane = [
      '────────────────────────────────────────',
      '❯ Try "refactor routing.ts"',
      '────────────────────────────────────────',
      '  ⏵⏵ auto mode on · ◉ xhigh · /effort',
    ].join('\n');
    const capturedPanes = [
      v21ReadyPane,
      v21ReadyPane,
      'implement task',
    ];
    mockSpawn.mockImplementation(() => createSpawnChild(stdinWrites, 0, ''));
    mockExecFile.mockImplementation((_file, args, _options, callback) => {
      if (args[0] === 'capture-pane') {
        callback(null, { stdout: capturedPanes.shift() ?? 'implement task', stderr: '' });
        return;
      }
      callback(null, { stdout: '', stderr: '' });
    });

    await backend.pasteText({ id: 'tmux-session', name: 'takt-session' }, 'implement task');

    expect(stdinWrites).toEqual(['implement task']);
    expect(mockExecFile.mock.calls.map((call) => call[1][0])).toEqual([
      'capture-pane',
      'capture-pane',
      'paste-buffer',
      'capture-pane',
      'send-keys',
      'delete-buffer',
    ]);
  });

  it('Given tmux paste-buffer fails after loading prompt, When pasteText rejects, Then tmux buffer is deleted', async () => {
    const backend = new TmuxTerminalBackend();
    const stdinWrites: string[] = [];
    let captureCount = 0;
    mockSpawn.mockImplementation(() => createSpawnChild(stdinWrites, 0, ''));
    mockExecFile.mockImplementation((_file, args, _options, callback) => {
      if (args[0] === 'capture-pane') {
        captureCount += 1;
        callback(null, { stdout: captureCount === 1 ? '❯' : `pane-${captureCount}`, stderr: '' });
        return;
      }
      if (args[0] === 'paste-buffer') {
        callback(createExecFileError('Command failed with sensitive argv', 1, 'tmux paste-buffer failed'));
        return;
      }
      callback(null, { stdout: '', stderr: '' });
    });

    await expect(backend.pasteText({ id: 'tmux-session', name: 'takt-session' }, 'secret prompt'))
      .rejects.toThrow(/paste-buffer failed/i);

    expect(stdinWrites).toEqual(['secret prompt']);
    expect(getNonCaptureTmuxArgs()).toEqual([
      ['paste-buffer', '-p', '-b', 'takt-session-prompt', '-t', 'takt-session'],
      ['delete-buffer', '-b', 'takt-session-prompt'],
    ]);
  });

  it('Given tmux send-keys fails after pasting prompt, When pasteText rejects, Then tmux buffer is deleted', async () => {
    const backend = new TmuxTerminalBackend();
    const stdinWrites: string[] = [];
    let captureCount = 0;
    mockSpawn.mockImplementation(() => createSpawnChild(stdinWrites, 0, ''));
    mockExecFile.mockImplementation((_file, args, _options, callback) => {
      if (args[0] === 'capture-pane') {
        captureCount += 1;
        callback(null, { stdout: captureCount === 1 ? '❯' : `pane-${captureCount}`, stderr: '' });
        return;
      }
      if (args[0] === 'send-keys') {
        callback(createExecFileError('Command failed with sensitive argv', 1, 'tmux send-keys failed'));
        return;
      }
      callback(null, { stdout: '', stderr: '' });
    });

    await expect(backend.pasteText({ id: 'tmux-session', name: 'takt-session' }, 'secret prompt'))
      .rejects.toThrow(/send-keys failed/i);

    expect(stdinWrites).toEqual(['secret prompt']);
    expect(getNonCaptureTmuxArgs()).toEqual([
      ['paste-buffer', '-p', '-b', 'takt-session-prompt', '-t', 'takt-session'],
      ['send-keys', '-t', 'takt-session', 'Enter'],
      ['delete-buffer', '-b', 'takt-session-prompt'],
    ]);
  });

  it('Given terminal session, When stop is called, Then tmux kill-session targets the session', async () => {
    const backend = new TmuxTerminalBackend();

    await backend.stop({ id: 'tmux-session', name: 'takt-session' });

    expect(mockExecFile).toHaveBeenCalledWith(
      'tmux',
      ['kill-session', '-t', 'takt-session'],
      {
        cwd: undefined,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024 * 4,
        env: expect.any(Object),
      },
      expect.any(Function),
    );
  });

  it('Given tmux executable is missing, When start is called, Then a clear provider error is thrown', async () => {
    const backend = new TmuxTerminalBackend();
    const enoent = Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' });
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      callback(enoent);
    });

    await expect(backend.start({
      cwd: '/tmp/worktree',
      backend: 'tmux',
      command: {
        executable: 'claude',
        args: [],
      },
    })).rejects.toThrow(/tmux command not found/i);
  });

  it('Given tmux start fails with sensitive Claude args in execFile error, When start rejects, Then error is sanitized', async () => {
    const backend = new TmuxTerminalBackend();
    const secretPrompt = 'do not leak this system prompt';
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      callback(createExecFileError(
        `Command failed: tmux new-session claude --system-prompt ${secretPrompt}`,
        1,
        `tmux failed for claude --system-prompt ${secretPrompt}`,
      ));
    });

    let startError: unknown;
    try {
      await backend.start({
        cwd: '/tmp/worktree',
        backend: 'tmux',
        command: {
          executable: 'claude',
          args: ['--system-prompt', secretPrompt],
        },
      });
    } catch (error) {
      startError = error;
    }

    expect(startError).toBeInstanceOf(Error);
    const message = (startError as Error).message;
    expect(message).toMatch(/tmux command failed with code 1: tmux failed for claude --system-prompt \[redacted\]/i);
    expect(message).not.toContain(secretPrompt);
    expect(message).not.toContain('Command failed: tmux new-session');
    expect(mockExecFile).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['--system-prompt', secretPrompt]),
      expect.any(Object),
      expect.any(Function),
    );
  });
});
