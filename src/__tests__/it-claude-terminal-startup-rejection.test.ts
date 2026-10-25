import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { TmuxTerminalBackend } from '../infra/claude-terminal/tmux-backend.js';
import type { ChildProcess } from 'node:child_process';

const boundary = vi.hoisted(() => ({ execFile: vi.fn(), input: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: (...args: unknown[]) => boundary.execFile(...args),
  spawn: (...args: unknown[]) => { boundary.input(...args); throw new Error('Unexpected input process'); },
}));
const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');
afterEach(() => { vi.clearAllMocks(); });

it.each(([
  ['target', 'No conversation found with session ID: saved-session'],
  ['other-id', 'No conversation found with session ID: another-session'],
  ['generic', 'Authentication failed'],
] as const).flatMap(([kind, diagnostic]) => [true, false].map((formatSupported) => ({ kind, diagnostic, formatSupported }))))(
  'executes the production startup wrapper and observes an immediate child exit before input ($kind, format supported: $formatSupported)',
  async ({ kind, diagnostic, formatSupported }) => {
    const root = mkdtempSync(join(getGlobalConfigDir(), 'terminal-startup-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const retention = join(root, 'retention');
    const format = join(root, 'format');
    const formatAttempt = join(root, 'format-attempt');
    const observed = join(root, 'cli-started');
    const cli = join(bin, 'fake claude');
    writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nset -eu\ncase "$5" in\nremain-on-exit) printf "%s" "$6" > "$RETENTION_FILE";;\nremain-on-exit-format)\n  printf "%s" "$4" > "$FORMAT_ATTEMPT_FILE"\n  if [ "$FORMAT_SUPPORTED" = false ]; then\n    printf "%s\\n" "invalid option: remain-on-exit-format" >&2\n    exit 1\n  fi\n  printf "%s" "$6" > "$FORMAT_FILE";;\n*) exit 2;;\nesac\n');
    writeFileSync(cli, '#!/bin/sh\nset -eu\n[ "$(cat "$RETENTION_FILE")" = on ] || exit 2\nif [ "$FORMAT_SUPPORTED" = true ]; then [ -f "$FORMAT_FILE" ] || exit 2; fi\nprintf "%s" "$2" > "$OBSERVED_FILE"\nprintf "%s\\n" "$DIAGNOSTIC_TEXT"\nexit 1\n');
    chmodSync(join(bin, 'tmux'), 0o700); chmodSync(cli, 0o700);
    let child: ChildProcess | undefined;
    let completed: Promise<{ code: number | null; output: string }> | undefined;
    let exit: { code: number | null; output: string } | undefined;
    const commands: string[][] = [];
    boundary.execFile.mockImplementation((_file: string, args: string[], _options: unknown,
      callback: (error: Error | null, value?: { stdout: string; stderr: string }) => void) => {
      commands.push(args);
      const run = async () => {
        if (args[0] === 'new-session') {
          const launch = args.slice(args.indexOf('/bin/sh'));
          if (launch[0] !== '/bin/sh') throw new Error('Missing production launch command');
          child = native.spawn(launch[0], launch.slice(1), {
            cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, killSignal: 'SIGKILL',
            env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TMUX_PANE: '%fixture',
              RETENTION_FILE: retention, FORMAT_FILE: format, FORMAT_ATTEMPT_FILE: formatAttempt,
              FORMAT_SUPPORTED: String(formatSupported), OBSERVED_FILE: observed, DIAGNOSTIC_TEXT: diagnostic },
          });
          const processForAttempt = child;
          completed = new Promise((resolve, reject) => {
            let output = '';
            processForAttempt.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
            processForAttempt.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
            processForAttempt.once('error', reject);
            processForAttempt.once('close', (code) => resolve({ code, output }));
          });
          exit = await completed;
          return '';
        }
        if (args[0] === 'kill-session') return '';
        if (exit === undefined || !existsSync(retention) || readFileSync(retention, 'utf8') !== 'on') {
          throw new Error('Pane disappeared without retention');
        }
        if (args[0] === 'display-message') return `1:${exit.code}`;
        if (args[0] === 'capture-pane') return exit.output;
        throw new Error('Unexpected input command');
      };
      void run().then((stdout) => callback(null, { stdout, stderr: '' }), (error: Error) => callback(error));
    });
    const backend = new TmuxTerminalBackend();
    let session: Awaited<ReturnType<typeof backend.start>> | undefined;
    try {
      session = await backend.start({ cwd: root, backend: 'tmux', resumeSessionId: 'saved-session',
        command: { executable: cli, args: ['--resume', 'saved-session'] } });
      expect(exit).toEqual({ code: 1, output: `${diagnostic}\n` });
      expect(readFileSync(observed, 'utf8')).toBe('saved-session');
      expect(readFileSync(formatAttempt, 'utf8')).toBe('%fixture');
      if (formatSupported) expect(readFileSync(format, 'utf8')).toBe('');
      else expect(existsSync(format)).toBe(false);
      const input = backend.pasteText(session, 'continue');
      if (kind === 'target') await expect(input).rejects.toMatchObject({ failureCategory: 'session_continuation_unsupported' });
      else await expect(input).rejects.not.toHaveProperty('failureCategory', 'session_continuation_unsupported');
      expect(boundary.input).not.toHaveBeenCalled();
      expect(commands.filter(([command]) => ['load-buffer', 'paste-buffer', 'send-keys'].includes(command!))).toEqual([]);
    } finally {
      try {
        if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await completed;
        if (session !== undefined) await backend.stop(session);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  },
);
