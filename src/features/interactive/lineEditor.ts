/**
 * Reads one answer from a stdin that is not a terminal.
 *
 * A terminal is served by the Ink TUI (`src/features/tui/`), which owns every
 * interactive editing gesture. What is left here is the path piped input takes —
 * scripts, CI, and the E2E suite that feeds a run through a pipe — where there
 * is no cursor to move and readline reads the line as it arrives.
 */

import * as readline from 'node:readline';

export function readPipedLine(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.stdin.readable && !process.stdin.destroyed) {
      process.stdin.resume();
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let answered = false;

    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });

    // A closed pipe with nothing left to read is the caller's cancellation.
    rl.on('close', () => {
      if (!answered) {
        resolve(null);
      }
    });
  });
}
