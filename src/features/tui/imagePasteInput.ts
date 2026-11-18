/**
 * Inline-image paste reassembly for the Ink TUI.
 *
 * A terminal that pastes a screenshot writes an OSC 1337 sequence onto stdin.
 * Ink splits stdin at every ESC and drops the ESC from the event it resolves, so
 * a real sequence arrives as `"]"` on its own followed by `"1337;File=…"`, while
 * the same characters typed or pasted as literal text arrive as a single event
 * (measured on Ink 7.1.1). That event boundary is the only signal left once the
 * ESC is gone, so holding starts **only** at a lone `"]"` — literal text is never
 * mistaken for a paste and swallowed.
 *
 * The module stays free of React, Ink and IO so the rules can be pinned down
 * without a terminal attached, and every function returns fresh state.
 */

import {
  MAX_PENDING_INLINE_IMAGE_CHARS,
  OSC_IMAGE_PREFIX,
  parseInlineImageSequence,
  type PastedImage,
} from '../interactive/inlineImagePaste.js';

/** The lone event a stripped ESC leaves behind at the start of an OSC. */
const OSC_OPENER_EVENT = OSC_IMAGE_PREFIX.slice(1, 2);
/** `OSC_IMAGE_PREFIX` in the shape `useInput` reports it: Ink removed the ESC. */
const INLINE_IMAGE_MARKER = OSC_IMAGE_PREFIX.slice(1);
const STRIPPED_ESCAPE_LENGTH = OSC_IMAGE_PREFIX.length - INLINE_IMAGE_MARKER.length;

export type ImagePasteOutcome =
  /** Nothing image-related; the caller handles the event as a normal key. */
  | { readonly kind: 'none' }
  /** The held bytes may still become an image; the caller swallows the event. */
  | { readonly kind: 'pending' }
  /** A complete inline image, plus the bytes that followed it in the event. */
  | { readonly kind: 'image'; readonly image: PastedImage; readonly rest: string }
  | { readonly kind: 'error'; readonly rest: string; readonly consumed?: boolean }
  /**
   * Held bytes that are not an image after all; the caller types them.
   * `consumed` is false when the event that ended the hold was not part of the
   * released text — the caller must still run its own handling for that key.
   */
  | { readonly kind: 'passthrough'; readonly text: string; readonly consumed: boolean };

export interface ImagePasteBuffer {
  /** Bytes withheld from the editor because they may still open an image. */
  readonly held: string;
  readonly discarding?: boolean;
}

export interface ImagePasteResult {
  readonly buffer: ImagePasteBuffer;
  readonly outcome: ImagePasteOutcome;
}

export function createImagePasteBuffer(): ImagePasteBuffer {
  return { held: '' };
}

function release(text: string, consumed: boolean): ImagePasteResult {
  return { buffer: createImagePasteBuffer(), outcome: { kind: 'passthrough', text, consumed } };
}

const BELL = '\u0007';

function imageTerminator(text: string, restoreStringTerminator: boolean): number {
  const bell = text.indexOf(BELL);
  const st = restoreStringTerminator ? text.indexOf('\\') : -1;
  return bell < 0 ? st : st < 0 ? bell : Math.min(bell, st);
}

/**
 * Any other control character ends the hold, because none of them can appear
 * inside the sequence — C0 (including Enter's `\r` and Ctrl+J's `\n`), DEL, and
 * the C1 range a terminal can send as single bytes. Their own key handling must
 * still run, which is why such an event is released as unconsumed instead of
 * being swallowed.
 */
function endsHold(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (character === BELL) {
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function isMarkerPrefix(text: string): boolean {
  return text.length < INLINE_IMAGE_MARKER.length && INLINE_IMAGE_MARKER.startsWith(text);
}

/**
 * Reads one key event against the buffer.
 *
 * `chunk` is the text the event carries; pass an empty string for an event that
 * carries none — a non-printable key or a control chord — because such an event
 * can never extend a held sequence and the held bytes belong back in the editor.
 * An event whose text carries a control character other than the sequence's own
 * terminator (Enter, Ctrl+J) is treated the same way and reported as unconsumed.
 *
 * Never throws: by default malformed or oversized sequences pass through.
 * Manager callers opt into rejecting recognized image payloads instead.
 */
export function consumeImagePasteInput(
  buffer: ImagePasteBuffer,
  chunk: string,
  rejectInvalidImages = false,
): ImagePasteResult {
  const invalid = (text: string): ImagePasteResult => {
    const end = imageTerminator(text, rejectInvalidImages);
    return { buffer: end < 0 ? { held: '', discarding: true } : createImagePasteBuffer(),
      outcome: { kind: 'error', rest: end < 0 ? '' : text.slice(end + 1) } };
  };
  if (buffer.discarding) {
    const end = imageTerminator(chunk, rejectInvalidImages);
    if (end >= 0) return release(chunk.slice(end + 1), true);
    if (chunk === '' || endsHold(chunk)) return { buffer: createImagePasteBuffer(), outcome: { kind: 'none' } };
    return { buffer, outcome: { kind: 'pending' } };
  }
  if (buffer.held === '') {
    // Only the lone opener starts a hold; anything else is ordinary input.
    return chunk === OSC_OPENER_EVENT
      ? { buffer: { held: chunk }, outcome: { kind: 'pending' } }
      : { buffer, outcome: { kind: 'none' } };
  }

  const accumulated = buffer.held + chunk;
  if (chunk === '' || endsHold(chunk)) {
    if (rejectInvalidImages && accumulated.startsWith(INLINE_IMAGE_MARKER)
      && accumulated.slice(INLINE_IMAGE_MARKER.length).split(':', 1)[0]!.split(';').includes('inline=1')) {
      const end = imageTerminator(accumulated, true);
      // Controls after a complete image belong to its trailing text, not its payload.
      if (end < 0 || endsHold(accumulated.slice(0, end))) {
        return { buffer: createImagePasteBuffer(), outcome: { kind: 'error',
          rest: end < 0 ? '' : accumulated.slice(end + 1), consumed: chunk.length > 1 } };
      }
    } else return release(buffer.held, false);
  }
  if (accumulated.length > MAX_PENDING_INLINE_IMAGE_CHARS) {
    if (rejectInvalidImages && accumulated.startsWith(INLINE_IMAGE_MARKER) && accumulated.includes('inline=1')) return invalid(accumulated);
    return release(accumulated, true);
  }
  if (isMarkerPrefix(accumulated)) {
    return { buffer: { held: accumulated }, outcome: { kind: 'pending' } };
  }
  if (!accumulated.startsWith(INLINE_IMAGE_MARKER)) {
    return release(accumulated, true);
  }

  // Ink strips both OSC escapes. Only manager's recognized OSC context restores
  // ST; ordinary TUI input keeps its existing classification.
  const end = imageTerminator(accumulated, rejectInvalidImages);
  const restoreST = end >= 0 && accumulated[end] === '\\';
  const normalized = restoreST ? accumulated.slice(0, end) + '\x1b' + accumulated.slice(end) : accumulated;
  const sequence = OSC_IMAGE_PREFIX + normalized.slice(INLINE_IMAGE_MARKER.length);
  let parsed: ReturnType<typeof parseInlineImageSequence>;
  try {
    parsed = parseInlineImageSequence(sequence, 0);
  } catch {
    return rejectInvalidImages ? invalid(accumulated) : release(accumulated, true);
  }

  if (parsed.status === 'incomplete') {
    return { buffer: { held: accumulated }, outcome: { kind: 'pending' } };
  }
  if (parsed.status === 'passthrough') {
    return release(accumulated, true);
  }

  return {
    buffer: createImagePasteBuffer(),
    outcome: {
      kind: 'image',
      image: parsed.image,
      rest: accumulated.slice(parsed.sequenceEnd - STRIPPED_ESCAPE_LENGTH - (restoreST ? 1 : 0)),
    },
  };
}
