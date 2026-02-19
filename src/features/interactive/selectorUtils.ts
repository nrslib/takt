/**
 * Shared utilities for selector UI components.
 */

/**
 * Truncate text to a single line with a maximum length for display as a label.
 */
export function truncateForLabel(text: string, maxLength: number): string {
  const singleLine = text.replace(/\n/g, ' ').trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return singleLine.slice(0, maxLength) + '…';
}

/**
 * Format a date string for display in selector options.
 */
export function formatDateForSelector(dateStr: string, lang: 'en' | 'ja'): string {
  const date = new Date(dateStr);
  return date.toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
