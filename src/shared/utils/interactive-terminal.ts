/**
 * Whether this process owns a terminal on both ends.
 *
 * Every front-end that can run either on the Ink TUI or through the readline
 * reader asks the same question, and asking it in one place is what keeps the
 * two paths from drifting apart: a run that renders frames must also be able to
 * read keys, so both streams have to be a TTY.
 */
export function hasInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
