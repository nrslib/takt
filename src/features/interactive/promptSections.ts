import { getLabel } from '../../shared/i18n/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';

export type InlineUtteranceSource = 'go' | 'acp' | 'retry' | 'task_list_revision' | 'tell' | 'requeue';

export function formatInlineUtteranceSection(
  lang: 'en' | 'ja',
  source: InlineUtteranceSource,
  userNote: string,
): string {
  const utterance = userNote.trim();
  if (!utterance) {
    return '';
  }
  return loadTemplate('parts/inline_utterance', lang, {
    go: source === 'go',
    acp: source === 'acp',
    retry: source === 'retry',
    taskListRevision: source === 'task_list_revision',
    tell: source === 'tell',
    requeue: source === 'requeue',
    utterance: formatLiteralBlock(utterance),
  }).trim();
}

function getSourceContextSystemPromptGuard(lang: 'en' | 'ja'): string {
  return loadTemplate('parts/source_context_system_guard', lang);
}

function getSourceContextGuidance(lang: 'en' | 'ja'): string {
  return loadTemplate('parts/source_context_section_guidance', lang);
}

function getUserCommentGuidance(lang: 'en' | 'ja'): string {
  return loadTemplate('parts/user_comment_section_guidance', lang);
}

export function prependInteractiveTopicBoundary(lang: 'en' | 'ja', prompt: string): string {
  const boundary = loadTemplate('parts/interactive_topic_boundary', lang).trim();
  return `${boundary}\n\n---\n\n${prompt}`;
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
