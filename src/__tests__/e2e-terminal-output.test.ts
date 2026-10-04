/**
 * The PTY E2E suite searches this text for what the TUI printed, so a control
 * byte left in it would sit inside the very strings the assertions match on.
 * What is pinned here is that chunk boundaries cannot leave one behind.
 */

import { describe, expect, it } from 'vitest';
import { createTerminalOutput } from '../../e2e/helpers/terminal-output.js';

describe('terminal output history', () => {
  it('should remove a sequence whose halves arrived on either side of a read', () => {
    const output = createTerminalOutput();

    // A PTY hands over whatever bytes were ready, so the erase-line sequence is
    // cut in half here, and neither half is a sequence on its own. Reading in
    // between is what polling for a pattern does, and it must not settle the
    // first half as text.
    output.push('ready\x1b[');
    output.text();
    output.push('2K done');

    expect(output.text()).toBe('ready done');
  });

  it('should keep the text of every chunk in arrival order', () => {
    const output = createTerminalOutput();

    output.push('\x1b[32mfirst\x1b[0m\r\n');
    output.push('second');

    expect(output.text()).toBe('first\r\nsecond');
  });
});
