/**
 * Session selector for interactive mode
 *
 * Presents recent Claude Code sessions for the user to choose from,
 * allowing them to resume a previous conversation as the assistant.
 */

import { loadSessionIndex, extractLastAssistantResponse } from '../../infra/claude/session-reader.js';
import { selectOption, type SelectOptionItem } from '../../shared/prompt/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { info } from '../../shared/ui/index.js';
import { truncateForLabel, formatDateForSelector } from './selectorUtils.js';

/** Maximum number of sessions to display */
const MAX_DISPLAY_SESSIONS = 10;

/** Maximum length for last response preview */
const MAX_RESPONSE_PREVIEW_LENGTH = 200;

/**
 * Prompt user to select from recent Claude Code sessions.
 *
 * @param cwd - Current working directory (project directory)
 * @param lang - Display language
 * @returns Selected session ID, or null for new session / no sessions
 */
export async function selectRecentSession(
  cwd: string,
  lang: 'en' | 'ja',
): Promise<string | null> {
  const sessions = loadSessionIndex(cwd);

  if (sessions.length === 0) {
    info(getLabel('interactive.sessionSelector.noSessions', lang));
    return null;
  }

  const displaySessions = sessions.slice(0, MAX_DISPLAY_SESSIONS);

  const options: SelectOptionItem<string>[] = [
    {
      label: getLabel('interactive.sessionSelector.newSession', lang),
      value: '__new__',
      description: getLabel('interactive.sessionSelector.newSessionDescription', lang),
    },
  ];

  for (const session of displaySessions) {
    const label = truncateForLabel(session.firstPrompt, 60);
    const dateStr = formatDateForSelector(session.modified, lang);
    const messagesStr = getLabel('interactive.sessionSelector.messages', lang, {
      count: String(session.messageCount),
    });
    const description = `${dateStr} | ${messagesStr}`;

    const details: string[] = [];
    const lastResponse = extractLastAssistantResponse(session.fullPath, MAX_RESPONSE_PREVIEW_LENGTH);
    if (lastResponse) {
      const previewLine = lastResponse.replace(/\n/g, ' ').trim();
      const preview = getLabel('interactive.sessionSelector.lastResponse', lang, {
        response: previewLine,
      });
      details.push(preview);
    }

    options.push({
      label,
      value: session.sessionId,
      description,
      details: details.length > 0 ? details : undefined,
    });
  }

  const prompt = getLabel('interactive.sessionSelector.prompt', lang);
  const selected = await selectOption<string>(prompt, options);

  if (selected === null || selected === '__new__') {
    return null;
  }

  return selected;
}
