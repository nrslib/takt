/**
 * Grapheme boundaries and terminal column widths, in one place.
 *
 * A user-perceived character can be several code points — a combining mark, a
 * variation selector, a ZWJ emoji sequence — and every part of a terminal
 * editor has to agree on where one ends: the caret must not stop inside one,
 * Backspace must remove all of it, and the renderer must draw it as the single
 * cell the terminal gives it. Splitting that logic across modules is what makes
 * a caret land half-way into an emoji.
 *
 * Widths come from `string-width`, the package Ink itself measures with, so the
 * wrapping computed here and the layout Ink performs agree by construction
 * rather than by a hand-rolled approximation.
 */

import stringWidth from 'string-width';

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The user-perceived characters of `text`, in order. */
export function segmentGraphemes(text: string): string[] {
  return [...GRAPHEME_SEGMENTER.segment(text)].map((entry) => entry.segment);
}

/** Offset just past the grapheme that starts at or contains `index`. */
export function nextGraphemeEnd(text: string, index: number): number {
  if (index >= text.length) {
    return text.length;
  }
  const found = GRAPHEME_SEGMENTER.segment(text).containing(index);
  return found === undefined ? text.length : found.index + found.segment.length;
}

/** Offset where the grapheme ending at `index` starts. */
export function previousGraphemeStart(text: string, index: number): number {
  if (index <= 0) {
    return 0;
  }
  const found = GRAPHEME_SEGMENTER.segment(text).containing(index - 1);
  return found === undefined ? 0 : found.index;
}

/**
 * Terminal columns `text` occupies. Zero-width marks cost nothing, an emoji
 * cluster costs two, and East Asian wide characters cost two — the same rules
 * Ink applies when it lays a frame out.
 */
export function measureWidth(text: string): number {
  return stringWidth(text);
}
