import { loadTemplate } from '../../shared/prompts/index.js';

function getPolicyIntro(lang: 'en' | 'ja'): string {
  return lang === 'ja'
    ? '以下のポリシーは行動規範です。必ず遵守してください。'
    : 'The following policy defines behavioral guidelines. Please follow them.';
}

function getPolicyReminder(lang: 'en' | 'ja'): string {
  return lang === 'ja'
    ? '上記の Policy セクションで定義されたポリシー規範を遵守してください。'
    : 'Please follow the policy guidelines defined in the Policy section above.';
}

export function buildInteractivePolicyPrompt(lang: 'en' | 'ja', userMessage: string): string {
  const policyContent = loadTemplate('score_interactive_policy', lang, {});

  return `## Policy\n${getPolicyIntro(lang)}\n\n${policyContent}\n\n---\n\n${userMessage}\n\n---\n**Policy Reminder:** ${getPolicyReminder(lang)}`;
}
