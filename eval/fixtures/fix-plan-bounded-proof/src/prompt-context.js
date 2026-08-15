const PROMPT_ASSETS = {
  en: 'prompts/en/failed-instruct.md',
  ja: 'prompts/ja/failed-instruct.md',
};

export function buildProviderPrompt(locale, failedEvidence, loadPrompt) {
  const template = loadPrompt(PROMPT_ASSETS[locale]);
  return template.replace('{{failedEvidence}}', failedEvidence);
}
