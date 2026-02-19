/**
 * Task name summarization using AI or romanization
 *
 * Generates concise English/romaji summaries for use in branch names and clone paths.
 */

import * as wanakana from 'wanakana';
import { resolveConfigValues } from '../config/index.js';
import { getProvider, type ProviderType } from '../providers/index.js';
import { createLogger, slugify } from '../../shared/utils/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import type { SummarizeOptions } from './types.js';

export type { SummarizeOptions };

const log = createLogger('summarize');

/**
 * Convert Japanese text to romaji slug.
 */
function toRomajiSlug(text: string): string {
  const romaji = wanakana.toRomaji(text, { customRomajiMapping: {} });
  return slugify(romaji);
}

/**
 * Summarizes task names into concise slugs using AI or romanization.
 */
export class TaskSummarizer {
  /**
   * Summarize a task name into a concise slug.
   *
   * @param taskName - Original task name (can be in any language)
   * @param options - Summarization options
   * @returns Slug suitable for branch names (English if LLM, romaji if not)
   */
  async summarize(
    taskName: string,
    options: SummarizeOptions,
  ): Promise<string> {
    const globalConfig = resolveConfigValues(options.cwd, ['branchNameStrategy', 'provider', 'model']);
    const useLLM = options.useLLM ?? (globalConfig.branchNameStrategy === 'ai');
    log.info('Summarizing task name', { taskName, useLLM });

    if (!useLLM) {
      const slug = toRomajiSlug(taskName);
      log.info('Task name romanized', { original: taskName, slug });
      return slug || 'task';
    }
    const providerType = (globalConfig.provider as ProviderType) ?? 'claude';
    const model = options.model ?? globalConfig.model;

    const provider = getProvider(providerType);
    const agent = provider.setup({
      name: 'summarizer',
      systemPrompt: loadTemplate('score_slug_system_prompt', 'en'),
    });
    const prompt = loadTemplate('score_slug_user_prompt', 'en', { taskDescription: taskName });
    const response = await agent.call(prompt, {
      cwd: options.cwd,
      model,
      permissionMode: 'readonly',
    });

    const slug = slugify(response.content);
    log.info('Task name summarized', { original: taskName, slug });

    return slug || 'task';
  }
}

// ---- Module-level function ----

const defaultSummarizer = new TaskSummarizer();

export async function summarizeTaskName(
  taskName: string,
  options: SummarizeOptions,
): Promise<string> {
  return defaultSummarizer.summarize(taskName, options);
}
