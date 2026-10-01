import { buildSummaryPrompt } from '../dist/features/interactive/interactive-summary.js';

export default async function buildTaskInstructionGherkinPrompt({ vars }) {
  const language = vars.language === 'ja' ? 'ja' : 'en';
  const conversationLabel = language === 'ja' ? '## 会話履歴' : '## Conversation History';
  const formalSpec = vars.formalSpec === true || vars.formalSpec === 'true';
  const formalSpecComments = vars.formalSpecComments === undefined
    || vars.formalSpecComments === true
    || vars.formalSpecComments === 'true';

  const history = vars.messages === undefined
    ? [{ role: 'user', content: String(vars.conversation ?? '') }]
    : vars.messages;
  if (!Array.isArray(history) || history.length === 0 || history.some((message) =>
    !message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) {
    throw new Error('messages must be a non-empty array of user/assistant messages with string content');
  }

  return buildSummaryPrompt(
    history,
    false,
    language,
    '',
    conversationLabel,
    undefined,
    undefined,
    undefined,
    formalSpec,
    false,
    formalSpecComments,
  );
}
