import { measureWidth, segmentGraphemes } from '../../shared/utils/grapheme.js';
import { toDisplayText } from '../tui/displayText.js';

export function layoutQuestionBody(body: string, contentWidth: number): string[] {
  const text = toDisplayText(body.replace(/\r\n?/gu, '\n')).replaceAll('\t', ' ');
  const capacity = Math.max(1, contentWidth);
  const rows: string[] = [];
  for (const line of text.split('\n')) {
    let row = '';
    let width = 0;
    for (const grapheme of segmentGraphemes(line)) {
      const graphemeWidth = measureWidth(grapheme);
      if (width + graphemeWidth > capacity && row !== '') {
        rows.push(row);
        row = '';
        width = 0;
      }
      row += grapheme;
      width += graphemeWidth;
    }
    rows.push(row);
  }
  return rows;
}
