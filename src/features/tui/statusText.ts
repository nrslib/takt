import stringWidth from 'string-width';
import { segmentGraphemes } from '../../shared/utils/grapheme.js';

export function formatElapsedTime(seconds: number): string {
  return seconds < 60 ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

export function truncateStatusText(text: string, columns: number): string {
  if (columns <= 0) return '';
  if (stringWidth(text) <= columns) return text;
  let result = '';
  let width = stringWidth('…');
  for (const grapheme of segmentGraphemes(text)) {
    const nextWidth = width + stringWidth(grapheme);
    if (nextWidth > columns) break;
    result += grapheme;
    width = nextWidth;
  }
  return `${result}…`;
}
