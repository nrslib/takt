/**
 * Display boundary for every string the TUI hands to Ink.
 *
 * Provider output and pasted input may carry terminal control sequences, and
 * the terminal must never execute them. The shared `stripAnsi` helper only
 * covers numeric CSI, 7-bit OSC and `ESC <char>`, so private-mode CSI
 * (`ESC [ ? 25 l`), the 8-bit C1 introducers and bare control bytes would reach
 * the terminal unchanged.
 *
 * Streaming adds a second problem: a sequence split across chunks is still
 * incomplete when the frame is rendered. Callers therefore keep the raw buffer
 * and re-derive the display text from it; a sequence that is not yet terminated
 * at the end of the buffer is withheld until the remaining bytes arrive.
 */

const ESCAPE = 0x1b;
const BELL = 0x07;
const TAB = 0x09;
const NEWLINE = 0x0a;
const C1_CSI = 0x9b;
const C1_STRING_TERMINATOR = 0x9c;

/** DCS, SOS, OSC, PM, APC — all run until a string terminator. */
const C1_STRING_INTRODUCERS = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);
const ESCAPE_STRING_INTRODUCERS = new Set(['P', 'X', ']', '^', '_']);

function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function isRenderableControl(code: number): boolean {
  return code === NEWLINE || code === TAB;
}

/** CSI parameter (0x30-0x3f) and intermediate (0x20-0x2f) bytes. */
function isCsiBody(code: number): boolean {
  return code >= 0x20 && code <= 0x3f;
}

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

/** Bytes that can complete a two-byte `ESC <byte>` sequence. */
function isEscapeFinal(code: number): boolean {
  return code >= 0x20 && code <= 0x7e;
}

/** Index just past the CSI sequence, or null while it is still incomplete. */
function scanCsi(raw: string, start: number): number | null {
  let index = start;
  while (index < raw.length && isCsiBody(raw.charCodeAt(index))) {
    index += 1;
  }
  if (index >= raw.length) {
    return null;
  }
  // A byte that is neither body nor final aborts the sequence; rescan from it.
  return isCsiFinal(raw.charCodeAt(index)) ? index + 1 : index;
}

/** Index just past the string sequence, or null while its terminator is missing. */
function scanStringSequence(raw: string, start: number): number | null {
  let index = start;
  while (index < raw.length) {
    const code = raw.charCodeAt(index);
    if (code === BELL || code === C1_STRING_TERMINATOR) {
      return index + 1;
    }
    if (code === ESCAPE) {
      if (index + 1 >= raw.length) {
        return null;
      }
      // `ESC \` terminates; any other escape aborts the string and starts anew.
      return raw[index + 1] === '\\' ? index + 2 : index;
    }
    index += 1;
  }
  return null;
}

/**
 * Text from `raw` that is safe to render now.
 *
 * A trailing sequence whose terminator has not arrived yet is dropped from the
 * result and reappears once the caller passes the completed buffer.
 */
export function toDisplayText(raw: string): string {
  let text = '';
  let index = 0;

  while (index < raw.length) {
    const code = raw.charCodeAt(index);

    if (code === ESCAPE) {
      const bodyStart = index + 1;
      if (bodyStart >= raw.length) {
        return text;
      }
      const introducer = raw[bodyStart]!;
      if (introducer === '[') {
        const end = scanCsi(raw, bodyStart + 1);
        if (end === null) {
          return text;
        }
        index = end;
        continue;
      }
      if (ESCAPE_STRING_INTRODUCERS.has(introducer)) {
        const end = scanStringSequence(raw, bodyStart + 1);
        if (end === null) {
          return text;
        }
        index = end;
        continue;
      }
      // Only 0x20-0x7e can complete `ESC <byte>`. Anything else (a newline, a
      // second ESC) is not part of this sequence, so drop the ESC alone and
      // rescan that byte on its own terms.
      index = isEscapeFinal(raw.charCodeAt(bodyStart)) ? bodyStart + 1 : bodyStart;
      continue;
    }

    if (code === C1_CSI) {
      const end = scanCsi(raw, index + 1);
      if (end === null) {
        return text;
      }
      index = end;
      continue;
    }

    if (C1_STRING_INTRODUCERS.has(code)) {
      const end = scanStringSequence(raw, index + 1);
      if (end === null) {
        return text;
      }
      index = end;
      continue;
    }

    if (isControl(code) && !isRenderableControl(code)) {
      index += 1;
      continue;
    }

    text += raw[index];
    index += 1;
  }

  return text;
}

/**
 * Display text for a fixed-height row. Truncation only bounds the width, so a
 * message carrying line breaks would still grow the interactive frame.
 */
export function toSingleLineText(raw: string): string {
  return toDisplayText(raw).replace(/[\n\t]+/g, ' ').trim();
}
