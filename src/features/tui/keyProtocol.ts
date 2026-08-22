/**
 * Kitty keyboard protocol, flag 1 (disambiguate escape codes).
 *
 * Without it a terminal reports Shift+Enter — and, under iTerm2's default
 * Option=Normal, Option+Enter — as a bare CR, indistinguishable from Enter. With
 * it those keys arrive as CSI-u reports, which Ink already decodes into
 * `key.return` plus `key.shift` / `key.meta`.
 *
 * Ink can negotiate the mode itself, but that path delivers every keystroke
 * twice (verified on Ink 7.1.1), so the TUI drives the mode the same way the
 * readline editor does.
 */
export const KITTY_KEYBOARD_ENABLE = '\x1b[>1u';
export const KITTY_KEYBOARD_DISABLE = '\x1b[<u';
