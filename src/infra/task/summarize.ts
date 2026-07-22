/**
 * Task name summarization using AI or romanization
 *
 * Generates concise English/romaji summaries for use in branch names and clone paths.
 */

import * as wanakana from 'wanakana';
import {
  resolveConfigValues,
  resolveNonWorkflowProviderModel,
  resolveNonWorkflowProviderOptions,
} from '../config/index.js';
import { getProvider, type ProviderType } from '../providers/index.js';
import { buildProviderRuntimeSystemPrompt } from '../providers/runtimeSystemPrompt.js';
import { createLogger, slugify } from '../../shared/utils/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import type { SummarizeOptions } from './types.js';

export type { SummarizeOptions };

const log = createLogger('summarize');
const MAX_ROMAJI_CHUNK_SIZE = 1024;

function toRomajiSafely(text: string): string {
  const romajiOptions = { customRomajiMapping: {} };
  try {
    if (text.length <= MAX_ROMAJI_CHUNK_SIZE) {
      return wanakana.toRomaji(text, romajiOptions);
    }
    const convertedChunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX_ROMAJI_CHUNK_SIZE) {
      convertedChunks.push(
        wanakana.toRomaji(text.slice(i, i + MAX_ROMAJI_CHUNK_SIZE), romajiOptions),
      );
    }
    return convertedChunks.join('');
  } catch (err) {
    log.error('Failed to convert to romaji', { error: err, textLength: text.length });
    return text;
  }
}

/**
 * Convert Japanese text to romaji slug.
 */
function toRomajiSlug(text: string): string {
  const romaji = toRomajiSafely(text);
  return slugify(romaji);
}

/**
 * Summarizes task names into concise slugs using AI or romanization.
 */
class TaskSummarizer {
  constructor(
    private readonly providerType: ProviderType,
    private readonly model: string | undefined,
  ) {}

  /**
   * Summarize a task name into a concise slug.
   *
   * @param taskName - Original task name (can be in any language)
   * @param cwd - Working directory used for the provider call
   * @returns Slug suitable for branch names (English if LLM, romaji if not)
   */
  async summarize(
    taskName: string,
    cwd: string,
  ): Promise<string> {
    const provider = getProvider(this.providerType);
    const systemPrompt = buildProviderRuntimeSystemPrompt(
      loadTemplate('score_slug_system_prompt', 'en'),
      'en',
      provider.getRuntimeInstructions(),
    );
    const agent = provider.setup({
      name: 'summarizer',
      systemPrompt,
    });
    const prompt = loadTemplate('score_slug_user_prompt', 'en', { taskDescription: taskName });
    const response = await agent.call(prompt, {
      cwd,
      model: this.model,
      permissionMode: 'readonly',
      providerOptions: resolveNonWorkflowProviderOptions(cwd),
    });

    const slug = slugify(response.content);
    log.info('Task name summarized', { original: taskName, slug });

    return slug || 'task';
  }
}

// ---- Module-level function ----

export async function summarizeTaskName(
  taskName: string,
  options: SummarizeOptions,
): Promise<string> {
  const { branchNameStrategy } = resolveConfigValues(options.cwd, ['branchNameStrategy']);
  const useLLM = options.useLLM ?? branchNameStrategy === 'ai';
  log.info('Summarizing task name', { taskName, useLLM });

  if (!useLLM) {
    const slug = toRomajiSlug(taskName);
    log.info('Task name romanized', { original: taskName, slug });
    return slug || 'task';
  }

  const resolved = resolveNonWorkflowProviderModel(options.cwd);
  if (resolved.provider === undefined) {
    throw new Error('No provider configured. Set "provider" in ~/.takt/config.yaml');
  }
  const summarizer = new TaskSummarizer(
    resolved.provider,
    options.model ?? resolved.model,
  );
  return summarizer.summarize(taskName, options.cwd);
}
