import stringWidth from 'string-width';
import { getLabel } from '../../shared/i18n/index.js';
import type { ConversationActivity } from '../../shared/types/conversation-activity.js';
import { segmentGraphemes } from '../../shared/utils/grapheme.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { toSingleLineText } from './displayText.js';

export function conversationActivityLabel(activity: ConversationActivity | undefined, lang: 'en' | 'ja'): string | undefined {
  switch (activity?.kind) {
    case 'thinking': return getLabel('tui.ui.extendedThinking', lang);
    case 'responding': return getLabel('tui.ui.responding', lang);
    case 'waiting': return getLabel('tui.ui.thinking', lang);
    case 'tool': return sanitizeSensitiveText(toSingleLineText(activity.description ?? activity.tool));
    default: return undefined;
  }
}

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
