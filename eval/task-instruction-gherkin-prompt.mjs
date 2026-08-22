import { buildSummaryPrompt } from '../dist/features/interactive/interactive-summary.js';

export default async function buildTaskInstructionGherkinPrompt({ vars }) {
  const language = vars.language === 'ja' ? 'ja' : 'en';
  const conversationLabel = language === 'ja' ? '## 会話履歴' : '## Conversation History';
  const formalSpec = vars.formalSpec === true || vars.formalSpec === 'true';

  return buildSummaryPrompt(
    [{ role: 'user', content: String(vars.conversation ?? '') }],
    false,
    language,
    '',
    conversationLabel,
    undefined,
    undefined,
    undefined,
    formalSpec,
  );
}
