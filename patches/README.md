# Ink history-preserving resize

[English](./README.md) | [日本語](./README.ja.md) | [简体中文](./README.zh-CN.md)

`ink+7.1.1.patch` is applied by `npm run patch:dependencies` automatically after
development dependency installation, before builds/watch, and before
`npm test` / `npm run test:it`. The install hook runs only when both the patch
asset and the local `patch-package` CLI exist. Published bundles already include
patched Ink and omit these development assets, so their install hook does not
require dev dependencies. Patch failures in development installs still fail the
installation. Nix reapplies the patch directly after recreating its production
dependency tree. Ink is pinned and bundled in the published npm package, so the
build's patched renderer is shipped with TAKT.

On main-screen interactive TTY resize events, pause live drawing until there
have been no further resize events for 150ms. Cancel queued old-width frames.
Once resizing settles, erase only the owned live region and redraw the current
input/status region at the new size. Do not clear the screen or scrollback, and
do not replay committed `<Static>` entries: the terminal owns existing history.
This also handles bursts that finish at the original width. The main-screen
fullscreen fallback also erases only live rows and prints only new static
output, rather than clearing history and replaying the entire transcript.

`TranscriptView` uses the patched `<Static renderOutput>` opt-in for terminal
output. Each new item is serialized directly from sanitized source text, without
Ink's width-dependent hard breaks or space padding. The terminal can therefore
reflow both user and AI paragraphs when narrowed or widened, even in scrollback.
Explicit source newlines remain hard breaks. Native wrapped continuation rows
start at the left edge; explicit continuation lines retain the marker indent.
User bands are painted with erase-to-end **before** their text, rather than
literal padding spaces. Erasing after text at an exact right margin can erase
its last glyph when the terminal clamps its pending-wrap cursor. Their old
background padding is not repainted on resize. Output already printed
by the old renderer retains its hard breaks; it cannot be repaired without
replacing terminal history. Non-TTY and screen-reader output uses the normal
React children rather than the terminal serializer.

TAKT's `mountInk()` opts into `anchorLiveFrame`: the hidden physical cursor stays
at the **first** live row, and the frame forms one soft-wrapped group. Xterm-like
terminals leave the cursor's group for the application to redraw. Height
reductions discard live rows below the cursor instead of pushing their leading
input/Thinking rows into scrollback. Clear erases from this cursor downward,
never committed rows above it. Allocate blank rows before painting, and paint
bottom-to-top with wraparound disabled: even a resize between PTY chunks cannot
push already-painted live rows above the cursor into history. Unicode width
differences and tabs cannot add uncontrolled live rows. Teardown clears the
owned region. This opt-in requires the software caret used by TAKT and overrides
incremental rendering; it rejects `useCursor()` hardware cursor positions.

Without that opt-in, the `log-update.js` patch counts the previous frame's rows
at the current terminal width, including ANSI-styled padding and wide
characters. Standard and incremental renderers restore a hardware cursor's
position relative to that reflowed frame before erasing.

Static output committed during the drawing pause is queued, not discarded.
Explicit output/flush, clear, suspension and unmount settle the pending resize
before taking over the terminal. Unmount cancels the timer so no delayed frame
can overwrite a selector or leak after exit. Waiting for an already unmounted
instance also avoids registering a new process-exit listener. Alternate-screen,
debug, non-TTY
and screen-reader rendering keep their existing resize paths.

Regression coverage in `src/__tests__/tui-conversation-view.test.tsx` checks the
entire emulated terminal buffer, including preexisting shell scrollback. It
covers narrowing/widening, rapid bursts, busy `/go` drafts, hardware cursors,
height reductions with multiline drafts (including emoji/tabs), resizing between
partial PTY-frame chunks, exact-right-margin user text, static commits during
resizing, fullscreen transitions, unmount, queued handoffs
and task dispatch.
`e2e/specs/tui.e2e.ts` also resizes a real PTY and checks offscreen history,
selector remounts and the live input/Thinking region without replaying history.
Tests commit English/Japanese user and AI paragraphs at a narrow width and verify
that they become single rows again when widened. The PTY regression also keeps
older offscreen messages while resizing these paragraphs repeatedly. A real-PTY
height regression checks idle and busy multiline drafts at 8/6 rows and on
re-expansion, with 70 committed history lines preserved exactly once.
