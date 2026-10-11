import { getLabel } from '../../shared/i18n/index.js';
import type { StreamCallback } from '../../shared/types/provider.js';
import { statusLine } from '../../shared/ui/StatusLine.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';

type HandoffStage = 'selectTask' | 'selectStart' | 'reviseInstruction' | 'composeTell';

export async function withHandoffProgress<T>(
  enabled: boolean,
  stage: HandoffStage,
  lang: 'en' | 'ja',
  operation: (onStream: StreamCallback | undefined) => Promise<T>,
): Promise<T> {
  if (!enabled) return operation(undefined);

  const label = getLabel(`tui.ui.${stage}`, lang);
  let active = true;
  let streamed = '';
  const onStream: StreamCallback | undefined = stage === 'selectTask' || stage === 'selectStart'
    ? undefined
    : (event) => {
      if (!active || event.type !== 'text') return;
      // Only the final two lines are needed, including the line before a trailing LF.
      streamed = (streamed + event.data.text).split('\n').slice(-2).join('\n');
      const lines = streamed.split('\n');
      const last = lines[lines.length - 1]!;
      const tail = sanitizeTerminalText(last === '' ? (lines[lines.length - 2] ?? '') : last);
      statusLine.update(`${label}${tail === '' ? '' : `  ${tail}`}`);
    };

  try {
    statusLine.start(label, { dim: true, intervalMs: 120, truncate: true, renderImmediately: true });
    return await operation(onStream);
  } finally {
    active = false;
    statusLine.stop();
  }
}
