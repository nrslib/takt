import { getLabel } from '../../shared/i18n/index.js';
import { confirm, selectOption, selectOptionWithDefault } from '../../shared/prompt/index.js';
import { resolveTtyPolicy } from '../../shared/prompt/tty.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import {
  getErrorMessage,
  hasInteractiveTerminal,
  sanitizeTerminalText,
  truncateText,
} from '../../shared/utils/index.js';
import {
  issueTellableRunningTask,
  inspectTellableRunningTasks,
  type TellableRunningTask,
} from '../tasks/liveIntervention.js';
import { callAIWithRetry, type SessionContext } from './aiCaller.js';
import type { ConversationMessage } from './interactiveApplication.js';

export interface TellCommandOptions {
  readonly cwd: string;
  readonly lang: 'en' | 'ja';
  readonly inlineText: string;
  readonly history: readonly ConversationMessage[];
  /** Resolved provider context used only when inlineText is omitted. */
  readonly sessionContext?: SessionContext;
  /** Initial choice only; the selected value is always taken from the menu. */
  readonly preferredRunSlug?: string;
}

function safeTellDisplayText(value: string | undefined, fallback: string): string {
  return truncateText(sanitizeTerminalText(value?.trim() || fallback), 160);
}

function safeTellContentDisplayText(value: string): string {
  return sanitizeTerminalText(value);
}

function buildTellConversationPrompt(
  history: readonly ConversationMessage[],
  lang: 'en' | 'ja',
): string {
  const transcript = history
    .filter((message) => message.content.trim().length > 0)
    .map((message) => {
      const speaker = message.role === 'user'
        ? (lang === 'ja' ? 'ユーザー' : 'User')
        : (lang === 'ja' ? 'アシスタント' : 'Assistant');
      return speaker + ':\n' + message.content;
    })
    .join('\n\n');
  const backtick = String.fromCharCode(96);
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(
      transcript.matchAll(new RegExp(backtick + '+', 'gu')),
      (match) => match[0].length,
    ),
  );
  const fence = backtick.repeat(Math.max(5, longestBacktickRun + 1));
  const historyLabel = lang === 'ja'
    ? '会話履歴（引用された参照データ）:'
    : 'Conversation history (quoted reference data):';
  const outputLabel = lang === 'ja'
    ? 'この履歴から、単独で理解できる追加指示本文だけを出力してください。'
    : 'Output only a standalone additional-instruction body based on this history.';
  return [
    historyLabel,
    fence + 'text\n' + transcript + '\n' + fence,
    outputLabel,
  ].join('\n\n');
}

async function generateTellContent(
  options: TellCommandOptions,
): Promise<{ content: string } | { error: string }> {
  if (options.sessionContext === undefined) {
    return {
      error: 'No provider context is available for additional-instruction generation.',
    };
  }

  const context: SessionContext = {
    ...options.sessionContext,
    sessionId: undefined,
    mcpServers: undefined,
    taskStateMcpServers: undefined,
  };
  const { result, error } = await callAIWithRetry(
    buildTellConversationPrompt(options.history, options.lang),
    loadTemplate('score_tell_system_prompt', options.lang),
    [],
    options.cwd,
    context,
    {
      outputMode: 'silent',
      persistSession: false,
    },
  );
  if (result === null) {
    return {
      error: error ?? 'The additional instruction could not be generated.',
    };
  }
  if (!result.success) {
    return {
      error: result.content.trim() || 'The additional instruction could not be generated.',
    };
  }
  const content = result.content.trim();
  return content.length > 0
    ? { content }
    : { error: 'The generated additional instruction was empty.' };
}

function tellCandidateOption(target: TellableRunningTask): {
  label: string;
  value: string;
  description: string;
  details: string[];
} {
  return {
    label: safeTellDisplayText(target.task.name, '(unnamed task)'),
    value: target.runSlug,
    description: safeTellDisplayText(target.task.summary, '(no summary)'),
    details: [
      `workflow=${safeTellDisplayText(target.meta.workflow, 'unknown')}`,
      `current step=${safeTellDisplayText(target.meta.currentStep, 'unknown')}`,
      `run slug=${safeTellDisplayText(target.runSlug, 'unknown')}`,
    ],
  };
}

async function resolveTellContent(
  options: TellCommandOptions,
): Promise<{ content: string } | { notice: string }> {
  const inline = options.inlineText.trim();
  if (inline.length > 0) {
    return { content: inline };
  }
  if (!options.history.some((message) => message.content.trim().length > 0)) {
    return {
      notice: getLabel('tui.errors.tellInstructionRequired', options.lang),
    };
  }
  try {
    const generated = await generateTellContent(options);
    if ('content' in generated) {
      return generated;
    }
    return {
      notice: getLabel('tui.errors.tellGenerationFailed', options.lang, {
        error: sanitizeTerminalText(generated.error),
      }),
    };
  } catch (error) {
    return {
      notice: getLabel('tui.errors.tellGenerationFailed', options.lang, {
        error: sanitizeTerminalText(getErrorMessage(error)),
      }),
    };
  }
}

/**
 * Run the interactive `/tell` selector and return the notice for the next
 * conversation frame. The writer is called only after the target and content
 * have been shown and the user has confirmed them.
 */
export async function runTellCommand(options: TellCommandOptions): Promise<string> {
  if (!hasInteractiveTerminal() || !resolveTtyPolicy().useTty) {
    return getLabel('tui.errors.tellRequiresTty', options.lang);
  }

  let candidates: readonly TellableRunningTask[];
  let excluded: readonly string[];
  try {
    const inspection = inspectTellableRunningTasks(options.cwd);
    candidates = inspection.tasks;
    excluded = inspection.excluded;
  } catch (error) {
    return getLabel('tui.errors.tellStale', options.lang, {
      error: sanitizeTerminalText(getErrorMessage(error)),
    });
  }
  const exclusionNotice = excluded.length === 0
    ? undefined
    : getLabel('tui.errors.tellExcluded', options.lang, {
      tasks: excluded
        .map((entry) => safeTellDisplayText(entry, '(unnamed task)'))
        .join('\n'),
    });
  if (candidates.length === 0) {
    return [
      getLabel('tui.errors.tellNoCandidates', options.lang),
      ...(exclusionNotice === undefined ? [] : [exclusionNotice]),
    ].join('\n');
  }

  const contentResolution = await resolveTellContent(options);
  if ('notice' in contentResolution) {
    return contentResolution.notice;
  }
  const { content } = contentResolution;

  const candidateOptions = candidates.map(tellCandidateOption);
  const selectorPrompt = [
    getLabel('tui.tell.selectPrompt', options.lang),
    ...(exclusionNotice === undefined ? [] : [exclusionNotice]),
  ].join('\n');
  const preferred = options.preferredRunSlug !== undefined
    && candidateOptions.some((candidate) => candidate.value === options.preferredRunSlug);
  const selectedRunSlug = preferred
    ? await selectOptionWithDefault(
      selectorPrompt,
      candidateOptions,
      options.preferredRunSlug!,
    )
    : await selectOption(
      selectorPrompt,
      candidateOptions,
    );
  if (selectedRunSlug === null) {
    return getLabel('tui.errors.tellCancelled', options.lang);
  }

  const selected = candidates.find((candidate) => candidate.runSlug === selectedRunSlug);
  if (selected === undefined) {
    return getLabel('tui.errors.tellStale', options.lang, {
      error: 'The selected running task is no longer available.',
    });
  }

  const confirmed = await confirm(getLabel('tui.tell.confirm', options.lang, {
    task: safeTellDisplayText(selected.task.name, '(unnamed task)'),
    summary: safeTellDisplayText(selected.task.summary, '(no summary)'),
    workflow: safeTellDisplayText(selected.meta.workflow, 'unknown'),
    step: safeTellDisplayText(selected.meta.currentStep, 'unknown'),
    runSlug: safeTellDisplayText(selected.runSlug, 'unknown'),
    content: safeTellContentDisplayText(content),
  }));
  if (!confirmed) {
    return getLabel('tui.errors.tellCancelled', options.lang);
  }

  try {
    const result = await issueTellableRunningTask(options.cwd, selectedRunSlug, content);
    return getLabel('tui.tell.sent', options.lang, {
      task: safeTellDisplayText(result.target.task.name, '(unnamed task)'),
      instructionId: String(result.instructionId),
    });
  } catch (error) {
    // The common writer rechecks the task while holding the intervention lock.
    return getLabel('tui.errors.tellStale', options.lang, {
      error: sanitizeTerminalText(getErrorMessage(error)),
    });
  }
}
