import { toDisplayText } from '../tui/displayText.js';

const GOAL_NAME_LIMIT = 24;
const INQUIRY_SUMMARY_LIMIT = 40;
const ELLIPSIS = '…';

function formatShortText(raw: string, limit: number): string {
  const text = toDisplayText(raw.replace(/\r\n?/gu, '\n')).replace(/\s+/gu, ' ').trim();
  let count = 0;
  let cutoff = 0;
  for (const { index } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    count += 1;
    if (count === limit) cutoff = index;
    if (count > limit) return text.slice(0, cutoff).trimEnd() + ELLIPSIS;
  }
  return text;
}

export function formatGoalName(objective: string): string {
  const name = formatShortText(objective, GOAL_NAME_LIMIT);
  return name === '' ? '—' : name;
}

export function formatInquirySummary(body: string): string {
  return formatShortText(body, INQUIRY_SUMMARY_LIMIT);
}
