import { render, type Instance } from 'ink';
import type { ReactElement } from 'react';
import { KITTY_KEYBOARD_DISABLE, KITTY_KEYBOARD_ENABLE } from './keyProtocol.js';
import { takeTerminalOwnership } from './terminalOwnership.js';

/**
 * Surfaces the first failure. A teardown that also failed rides along as the
 * cause so it stays observable without hiding what actually went wrong.
 */
function buildRunFailure(
  primaryError: unknown,
  hasPrimaryError: boolean,
  reportedTeardownErrors: readonly unknown[],
): unknown {
  // The same rejection can be seen twice — once as the mount's failure and again
  // while awaiting the exit during teardown — and hanging an error off itself as
  // its own cause makes an endless chain.
  const teardownErrors = reportedTeardownErrors.filter((error) => error !== primaryError);
  const [firstTeardownError, ...restTeardownErrors] = teardownErrors;
  if (!hasPrimaryError) {
    return firstTeardownError;
  }
  if (teardownErrors.length === 0) {
    return primaryError;
  }
  // A wrapped error already names its own cause, and overwriting it would lose
  // what the run actually failed on; the two are reported side by side instead.
  if (primaryError instanceof Error && primaryError.cause === undefined) {
    return Object.assign(primaryError, {
      cause: restTeardownErrors.length === 0
        ? firstTeardownError
        : new AggregateError(teardownErrors, 'TUI teardown failed'),
    });
  }
  return new AggregateError([primaryError, ...teardownErrors], 'TUI run failed');
}

/**
 * Mounts one Ink tree, waits for it to settle, and gives the terminal back.
 *
 * The selectors this run puts on screen are the ordinary readline ones, and
 * they need the terminal to themselves, so a run mounts and unmounts Ink around
 * each of them instead of keeping one tree up for the whole session. Ownership,
 * the keyboard protocol and the tree itself are therefore taken and returned
 * inside this one call, which is what keeps the pairs matched.
 */
export async function mountInk<T>(
  buildTree: (handlers: {
    settle: (value: T) => void;
    /** Ends the mount with a failure, which outranks any teardown failure. */
    fail: (error: unknown) => void;
  }) => ReactElement,
  exitedEarlyMessage: string,
): Promise<T> {
  let settle!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const settled = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  // Whatever went wrong first is what the caller needs to see; a teardown that
  // also fails must never replace it, but must not vanish either.
  let primaryError: unknown;
  let hasPrimaryError = false;
  const teardownErrors: unknown[] = [];
  const recordFailure = (error: unknown): void => {
    if (hasPrimaryError) {
      teardownErrors.push(error);
      return;
    }
    hasPrimaryError = true;
    primaryError = error;
  };
  /** Runs a teardown step to completion, keeping its failure without letting it stop the rest. */
  const teardown = async (step: () => void | Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      recordFailure(error);
    }
  };

  const terminal = takeTerminalOwnership();
  let outcome: { readonly value: T } | undefined;
  try {
    let instance: Instance | undefined;
    try {
      // Enabled inside the guaranteed range so the matching disable always runs,
      // even if this very write throws. Without the protocol a terminal sends a
      // bare CR for Shift+Enter, and for Option+Enter too under iTerm2's default
      // Option=Normal, so neither can be told apart from Enter. Ink decodes the
      // CSI-u reports the flag turns on but only negotiates the mode through an
      // option that delivers every keystroke twice, so it is driven here exactly
      // as the readline editor drives it.
      terminal.stdout.write(KITTY_KEYBOARD_ENABLE);
      instance = render(buildTree({ settle, fail }), {
        exitOnCtrlC: false,
        stdout: terminal.stdout,
        stderr: terminal.stderr,
        // Ink otherwise turns its live frame off whenever `CI` is set, even on a
        // real terminal — and then the conversation has no input box while the
        // run still reads keys. TAKT has already decided this is an interactive
        // terminal (`hasInteractiveTerminal`) and owns it, so that decision is
        // handed to Ink rather than re-made from the environment.
        interactive: true,
      });

      // An Ink teardown before the view settles would leave this pending.
      instance.waitUntilExit().then(
        () => fail(new Error(exitedEarlyMessage)),
        (error: unknown) => fail(error),
      );

      outcome = { value: await settled };
    } catch (error) {
      recordFailure(error);
    } finally {
      // Each step is guaranteed on its own: a failure in one must not skip the next.
      const mounted = instance;
      if (mounted) {
        // The dynamic frame is erased first: what follows this mount is either a
        // readline selector or the end of the run, and neither should be drawn
        // under a leftover input box.
        await teardown(() => mounted.clear());
        await teardown(() => mounted.unmount());
        await teardown(async () => {
          await mounted.waitUntilExit();
        });
      }
      await teardown(() => {
        terminal.stdout.write(KITTY_KEYBOARD_DISABLE);
      });
      await teardown(() => {
        // Ink unrefs stdin when it hands raw mode back, which leaves the next
        // reader polling a handle libuv has stopped watching: measured on a real
        // PTY, the readline selector that runs after a mount never receives a
        // keypress without this.
        if (process.stdin.isTTY) {
          process.stdin.ref();
        }
      });
    }
  } catch (error) {
    recordFailure(error);
  } finally {
    await teardown(() => terminal.release());
  }

  if (outcome === undefined || hasPrimaryError || teardownErrors.length > 0) {
    throw buildRunFailure(primaryError, hasPrimaryError, teardownErrors);
  }
  return outcome.value;
}

