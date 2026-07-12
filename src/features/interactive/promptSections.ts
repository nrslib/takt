import { getLabel } from '../../shared/i18n/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';

function getSourceContextSystemPromptGuard(lang: 'en' | 'ja'): string {
  return loadTemplate('parts/source_context_system_guard', lang);
}

function getSourceContextGuidance(lang: 'en' | 'ja'): string {
  return loadTemplate('parts/source_context_section_guidance', lang);
}

export function formatLiteralBlock(content: string): string {
  const longestFence = [...content.matchAll(/`+/g)].reduce((max, match) => {
    return Math.max(max, match[0].length);
  }, 0);
  const fence = '`'.repeat(Math.max(3, longestFence + 1));
  return `${fence}text\n${content}\n${fence}`;
}

export function prependInitialPromptContext(
  userMessage: string,
  initialPromptContext?: string,
): string {
  if (!initialPromptContext) {
    return userMessage;
  }

  return `${initialPromptContext}\n\n---\n\n${userMessage}`;
}

export function formatSourceContextSection(
  lang: 'en' | 'ja',
  sourceContext?: string,
): string {
  if (!sourceContext) {
    return '';
  }

  return `## ${getLabel('interactive.sourceContextLabel', lang)}\n${getSourceContextGuidance(lang)}\n\n${formatLiteralBlock(sourceContext)}`;
}

export function prependSourceContext(
  lang: 'en' | 'ja',
  userMessage: string,
  sourceContext?: string,
): string {
  const sourceContextSection = formatSourceContextSection(lang, sourceContext);
  if (!sourceContextSection) {
    return userMessage;
  }

  return `${sourceContextSection}\n\n---\n\n${userMessage}`;
}

export function prependSourceContextGuardToSystemPrompt(
  lang: 'en' | 'ja',
  systemPrompt: string,
): string {
  return `${getSourceContextSystemPromptGuard(lang)}\n\n---\n\n${systemPrompt}`;
}
