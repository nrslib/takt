import { selectOption, type SelectOptionItem } from '../../shared/prompt/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { info } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { listRecords, type InteractiveSessionRecords } from './interactiveSessionRecords.js';
import { truncateForLabel, formatDateForSelector } from './selectorUtils.js';

export async function selectRecentSession(
  cwd: string,
  lang: 'en' | 'ja',
  provider: string,
  records?: InteractiveSessionRecords,
): Promise<string | null> {
  const sessions = records ? records.list(provider) : listRecords(cwd, provider);
  if (sessions.length === 0) {
    info(getLabel('interactive.sessionSelector.noSessions', lang));
    return null;
  }

  const options: SelectOptionItem<string>[] = [{
    label: getLabel('interactive.sessionSelector.newSession', lang),
    value: '__new__',
    description: getLabel('interactive.sessionSelector.newSessionDescription', lang),
  }];
  for (const session of sessions) {
    const label = truncateForLabel(sanitizeTerminalText(session.inputs.at(-1) ?? ''), 60);
    const date = formatDateForSelector(session.modified, lang);
    const count = getLabel('interactive.sessionSelector.messages', lang, { count: String(session.messageCount) });
    const details = session.inputs.slice(0, -1).reverse()
      .map((input) => truncateForLabel(sanitizeTerminalText(input), 60));
    if (session.response) {
      details.push(getLabel('interactive.sessionSelector.lastResponse', lang, {
        response: truncateForLabel(sanitizeTerminalText(session.response), 60),
      }));
    }
    options.push({ label, value: session.sessionId, description: `${date} | ${count}`, details });
  }
  const selected = await selectOption<string>(getLabel('interactive.sessionSelector.prompt', lang), options);
  return selected === null || selected === '__new__' ? null : selected;
}
