/**
 * PTY-backed takt runner for E2E specs that need a real terminal.
 *
 * `runTakt` pipes stdio, so `process.stdout.isTTY` is undefined and TTY-gated
 * features (the Ink TUI) refuse to start. This runner allocates a pseudo
 * terminal instead, and synchronizes on emitted output rather than sleeps.
 */

import headless from '@xterm/headless';
import { spawn as spawnPty, type IPty } from 'node-pty';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectProviderArgs } from './takt-runner.js';
import { createTerminalOutput } from './terminal-output.js';
import { waitFor } from './wait.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;
const DEFAULT_OUTPUT_TIMEOUT = 60_000;
const DEFAULT_EXIT_TIMEOUT = 120_000;
const DISPOSE_TIMEOUT = 10_000;
const TERMINAL_SCROLLBACK = 10_000;
/** Matches the polling `waitFor` does, so both waits react at the same pace. */
const SCREEN_POLL_INTERVAL = 100;

export interface TaktPtyOptions {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  injectProvider?: boolean;
}

export interface TaktPtySession {
  /**
   * Everything written to the terminal so far, with ANSI sequences removed.
   * This is the raw byte history — frames the app later erased are still in it,
   * so it answers "was this ever emitted?", not "is this on screen?".
   */
  output(): string;
  /**
   * What a real terminal would actually show: the scrollback plus the current
   * screen, after every cursor move and erase has been applied. Trailing blank
   * lines are dropped. Use this to assert on what the user sees.
   *
   * Async because the emulator parses writes off the event loop; reading the
   * buffer before they drain would sample a half-applied screen.
   */
  visibleTranscript(): Promise<string[]>;
  /** The rows of the live screen, oldest first. */
  visibleScreen(): Promise<string[]>;
  /** Resolve once the pattern appears in the output; reject with the output on timeout. */
  waitForOutput(pattern: string | RegExp, timeoutMs?: number): Promise<void>;
  /**
   * Resolve once the live screen satisfies `predicate`, with the screen it
   * matched on; reject with the last screen on timeout.
   *
   * `waitForOutput` searches the whole byte history, so a pattern the app has
   * since erased still matches it. Anything that has to be true *now* — a draft
   * that was taken, a hint that went away — has to be asked of the screen, and
   * `expectation` is what the timeout message says was never true.
   */
  waitForScreen(
    expectation: string,
    predicate: (screen: string) => boolean,
    timeoutMs?: number,
  ): Promise<string>;
  /** Send raw key bytes to the terminal. */
  write(data: string): void;
  /** Resolve with the process exit code; reject with the output on timeout. */
  waitForExit(timeoutMs?: number): Promise<number>;
  /** Terminate the process and wait for the PTY to be released. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * node-pty requires string-valued env entries. `TAKT_NO_TTY` is dropped because
 * the child really does own a TTY here, and leaving it set would route the CLI
 * through its non-interactive fallbacks.
 */
function toPtyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const ptyEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key === 'TAKT_NO_TTY') {
      continue;
    }
    ptyEnv[key] = value;
  }
  return ptyEnv;
}

function matches(output: string, pattern: string | RegExp): boolean {
  if (typeof pattern === 'string') {
    return output.includes(pattern);
  }
  // A /g or /y source pattern carries lastIndex across polls and would skip matches.
  const stateless = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
  return stateless.test(output);
}

export function startTaktPty(options: TaktPtyOptions): TaktPtySession {
  const binPath = resolve(__dirname, '../../bin/takt');
  const provider = options.injectProvider === false ? undefined : process.env.TAKT_E2E_PROVIDER;
  const args = injectProviderArgs(options.args, provider);

  const received = createTerminalOutput();
  let exitCode: number | null = null;

  // A real VT is the only honest judge of what survived the app's own erases.
  const terminal = new headless.Terminal({
    cols: options.cols ?? DEFAULT_COLS,
    rows: options.rows ?? DEFAULT_ROWS,
    allowProposedApi: true,
    scrollback: TERMINAL_SCROLLBACK,
  });

  const pty: IPty = spawnPty(process.execPath, [binPath, ...args], {
    name: 'xterm-256color',
    cols: options.cols ?? DEFAULT_COLS,
    rows: options.rows ?? DEFAULT_ROWS,
    cwd: options.cwd,
    env: toPtyEnv(options.env),
  });

  // Serialized: the emulator applies writes asynchronously, so chunks must be
  // queued in arrival order and drained before the buffer is read.
  let terminalDrained: Promise<void> = Promise.resolve();
  /** What the emulator refused, kept so a screen read can say why it is stale. */
  let terminalWriteError: unknown;
  pty.onData((chunk) => {
    received.push(chunk);
    terminalDrained = terminalDrained
      .then(() => new Promise<void>((resolve) => terminal.write(chunk, resolve)))
      // A refused write must not leave the chain rejected: every later screen
      // read would then fail with this instead of with what the TUI did.
      .catch((error: unknown) => {
        terminalWriteError ??= error;
      });
  });
  pty.onExit(({ exitCode: code }) => {
    exitCode = code;
  });

  const output = (): string => received.text();

  async function drainTerminal(): Promise<void> {
    await terminalDrained;
    if (terminalWriteError !== undefined) {
      throw new Error(
        `the terminal emulator refused a write: ${String(terminalWriteError)}`,
      );
    }
  }

  function readTerminalLines(from: number, to: number): string[] {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let index = from; index < to; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true).trimEnd() ?? '');
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines;
  }

  async function readScreen(): Promise<string[]> {
    await drainTerminal();
    const buffer = terminal.buffer.active;
    return readTerminalLines(buffer.baseY, buffer.baseY + terminal.rows);
  }

  return {
    output,

    async visibleTranscript(): Promise<string[]> {
      await drainTerminal();
      return readTerminalLines(0, terminal.buffer.active.length);
    },

    visibleScreen: readScreen,

    async waitForOutput(pattern: string | RegExp, timeoutMs = DEFAULT_OUTPUT_TIMEOUT): Promise<void> {
      const found = await waitFor(() => matches(output(), pattern), timeoutMs);
      if (!found) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for ${String(pattern)}\noutput:\n${output()}`,
        );
      }
    },

    async waitForScreen(
      expectation: string,
      predicate: (screen: string) => boolean,
      timeoutMs = DEFAULT_OUTPUT_TIMEOUT,
    ): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      let screen = '';
      while (Date.now() < deadline) {
        screen = (await readScreen()).join('\n');
        if (predicate(screen)) {
          return screen;
        }
        await new Promise((resolve) => setTimeout(resolve, SCREEN_POLL_INTERVAL));
      }
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${expectation}\nscreen:\n${screen}`,
      );
    },

    write(data: string): void {
      pty.write(data);
    },

    async waitForExit(timeoutMs = DEFAULT_EXIT_TIMEOUT): Promise<number> {
      const exited = await waitFor(() => exitCode !== null, timeoutMs);
      if (!exited) {
        pty.kill('SIGKILL');
        throw new Error(
          `takt did not exit within ${timeoutMs}ms\noutput:\n${output()}`,
        );
      }
      return exitCode!;
    },

    async dispose(): Promise<void> {
      try {
        if (exitCode !== null) {
          return;
        }
        pty.kill('SIGKILL');
        const released = await waitFor(() => exitCode !== null, DISPOSE_TIMEOUT);
        if (!released) {
          throw new Error(
            `takt PTY was not released within ${DISPOSE_TIMEOUT}ms\noutput:\n${output()}`,
          );
        }
      } finally {
        // The emulator holds a scrollback buffer and its own listeners, and a
        // spec mounts one of these per test: it has to go whether the run ended
        // by itself or had to be killed.
        terminal.dispose();
      }
    },
  };
}
