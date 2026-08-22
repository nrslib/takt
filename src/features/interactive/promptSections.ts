import { getLabel } from '../../shared/i18n/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';

function getSourceContextSystemPromptGuard(lang: 'en' | 'ja'): string {
  return loadTemplate('parts/source_context_system_guard', lang);
}

function getSourceContextGuidance(lang: 'en' | 'ja'): string {
  return loadTemplate('parts/source_context_section_guidance', lang);
}

function getUserCommentGuidance(lang: 'en' | 'ja'): string {
  return loadTemplate('parts/user_comment_section_guidance', lang);
}

/**
 * Labels a conversational message as a user comment. Providers without a real
 * system prompt (codex prepends it to the user turn) lose the assistant-mode
 * role text in the noise, and a bare "fix X" message then reads as an
 * implementation request — the label keeps it conversation material.
 */
export function frameUserComment(lang: 'en' | 'ja', userMessage: string): string {
  return `## ${getLabel('interactive.userCommentLabel', lang)}\n${getUserCommentGuidance(lang)}\n\n${userMessage}`;
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
