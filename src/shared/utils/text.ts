/**
 * Text display width utilities
 *
 * Pure functions for calculating and truncating text based on
 * terminal display width, with full-width (CJK) character support.
 */

import { truncateUtf8 } from './utf8.js';
import { MAX_AGENT_FAILURE_MESSAGE_BYTES } from '../types/agent-failure.js';

export const MAX_TERMINAL_OUTPUT_BYTES = MAX_AGENT_FAILURE_MESSAGE_BYTES;

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
 * Removes CSI sequences (colors, cursor motion, etc.),
 * OSC sequences, and other single-character escape codes.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Sanitize terminal-bound text by removing ANSI escapes and visualizing control characters.
 */
export function sanitizeTerminalText(text: string): string {
  const stripped = stripAnsi(text);
  let sanitized = '';

  for (const char of stripped) {
    const code = char.codePointAt(0) ?? 0;
    // C0 controls, DEL, and C1 controls (0x80-0x9f: 8-bit CSI/OSC introducers)
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      switch (char) {
        case '\n':
          sanitized += '\\n';
          break;
        case '\r':
          sanitized += '\\r';
          break;
        case '\t':
          sanitized += '\\t';
          break;
        default:
          sanitized += `\\x${code.toString(16).padStart(2, '0')}`;
          break;
      }
      continue;
    }

    sanitized += char;
  }

  return sanitized;
}

const TRUNCATION_MARKER_PATTERN = /\[TRUNCATED: [^\]]+\]$/;

export function truncateUtf8WithMarker(
  text: string,
  maxBytes: number,
  createMarker: (omittedBytes: number) => string,
): string {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= maxBytes) {
    return text;
  }
  if (maxBytes <= 0) {
    return '';
  }

  let prefixBytes = maxBytes;
  while (true) {
    const prefix = truncateUtf8(text, prefixBytes);
    const marker = createMarker(totalBytes - prefix.bytes);
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    if (markerBytes >= maxBytes) {
      return truncateUtf8(marker, maxBytes).value;
    }

    const nextPrefixBytes = maxBytes - markerBytes;
    if (nextPrefixBytes >= prefix.bytes) {
      return `${prefix.value}${marker}`;
    }
    prefixBytes = nextPrefixBytes;
  }
}

export function truncateUtf8PreservingMarker(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  const marker = text.match(TRUNCATION_MARKER_PATTERN)?.[0];
  return truncateUtf8WithMarker(
    text,
    maxBytes,
    marker === undefined
      ? (omittedBytes) => `[TRUNCATED: ${omittedBytes} bytes]`
      : () => marker,
  );
}

export function sanitizeTerminalTextWithinBytes(
  text: string,
  maxBytes: number,
): string {
  const sanitized = sanitizeTerminalText(text);
  return truncateUtf8PreservingMarker(sanitized, maxBytes);
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
