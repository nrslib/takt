/**
 * Text display width utilities
 *
 * Pure functions for calculating and truncating text based on
 * terminal display width, with full-width (CJK) character support.
 */

/**
 * Check if a Unicode code point is full-width (occupies 2 columns).
 * Covers CJK unified ideographs, Hangul, fullwidth forms, etc.
 */
export function isFullWidth(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115F) ||  // Hangul Jamo
    (code >= 0x2E80 && code <= 0x9FFF) ||  // CJK radicals, symbols, ideographs
    (code >= 0xAC00 && code <= 0xD7AF) ||  // Hangul syllables
    (code >= 0xF900 && code <= 0xFAFF) ||  // CJK compatibility ideographs
    (code >= 0xFE10 && code <= 0xFE6F) ||  // CJK compatibility forms
    (code >= 0xFF01 && code <= 0xFF60) ||  // Fullwidth ASCII variants
    (code >= 0xFFE0 && code <= 0xFFE6) ||  // Fullwidth symbols
    (code >= 0x20000 && code <= 0x2FA1F)   // CJK extension B+
  );
}

/**
 * Calculate the display width of a plain text string.
 * Full-width characters (CJK etc.) count as 2, others as 1.
 */
export function getDisplayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += isFullWidth(code) ? 2 : 1;
  }
  return width;
}

// CSI (Control Sequence Introducer): ESC [ ... final_byte
// OSC (Operating System Command): ESC ] ... (ST | BEL)
// Other escape: ESC followed by a single character
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]/g;

/**
 * Strip all ANSI escape sequences from a string.
 * Removes CSI sequences (colors, cursor movement, etc.),
 * OSC sequences, and other single-character escape codes.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Truncate plain text to fit within maxWidth display columns.
 * Appends '…' if truncated. The ellipsis itself counts as 1 column.
 */
export function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  let width = 0;
  let i = 0;
  for (const char of text) {
    const charWidth = isFullWidth(char.codePointAt(0) ?? 0) ? 2 : 1;
    if (width + charWidth > maxWidth - 1) {
      // Not enough room; truncate and add ellipsis
      return text.slice(0, i) + '…';
    }
    width += charWidth;
    i += char.length;
  }
  return text;
}
