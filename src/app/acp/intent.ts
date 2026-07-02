import { SlashCommand } from '../../shared/constants.js';
import { matchSlashCommand } from '../../features/interactive/commandMatcher.js';
import type { AcpDefaultAction, AcpTaskInstructionAction } from './types.js';

export type AcpPromptIntent =
  | {
      kind: 'conversation';
    }
  | {
      kind: 'task_instruction';
      action: AcpTaskInstructionAction;
      userNote: string;
    };

const ISSUE_AND_ENQUEUE_PHRASES = [
  'issueを作ってタスクに積んで',
  'issueを作ってタスクに積む',
  'issue作ってタスクに積んで',
  'issue を作ってタスクに積んで',
  'issue を作ってタスクに積む',
  'github issueを作ってタスクに積んで',
  'github issueを作ってタスクに積む',
  'github issue を作ってタスクに積んで',
  'github issue を作ってタスクに積む',
  'issueを作ってpending taskにして',
  'issue を作って pending task にして',
  'create issue and enqueue',
  'create an issue and enqueue',
  'create a github issue and enqueue',
  'create issue and make it a pending task',
  'create an issue and make it a pending task',
];

const ENQUEUE_PHRASES = [
  'タスクに積んで',
  'pending task にして',
  'pending taskにして',
  '後で takt run する',
  'worktree で実行できるように積んで',
  'worktreeで実行できるように積んで',
  'enqueue',
  'make it a pending task',
];

const TASK_QUEUE_COMMANDS = /\b(?:put|add|make|queue)\b/g;
const MAX_TASK_QUEUE_COMMAND_DISTANCE = 80;

const DIRECT_PHRASES = [
  'そのまま実行して',
  '今すぐ実行して',
  'すぐ実行して',
  '直接実行して',
  'run it now',
  'execute now',
  'direct execution',
];

const NEGATION_AFTER_PHRASE = [
  'ではなく',
  'じゃなく',
  'ではない',
  'じゃない',
];

const NEGATION_BEFORE_PHRASE = [
  'do not ',
  "don't ",
  'not ',
];

const INSTRUCTION_QUESTION_SUFFIXES = [
  'いいか',
  'よいか',
  '良いか',
  'べきか',
  'かどうか',
  'か相談',
];

const DIRECT_COMMAND_SUFFIXES = [
  '。',
  '！',
  '!',
  '.',
  'ください',
  '下さい',
  'ほしい',
  '欲しい',
  'お願いします',
];

const INSTRUCTION_END_MARKERS = [
  '。',
  '！',
  '!',
  '.',
];

const INDIRECT_INSTRUCTION_CONTEXTS = [
  '相談',
  'should i ',
  'about ',
];

type PhraseMatch = {
  index: number;
  phrase: string;
};

function findLastTaskQueueCommandIndex(text: string): number | undefined {
  let lastIndex: number | undefined;
  for (let match = TASK_QUEUE_COMMANDS.exec(text); match; match = TASK_QUEUE_COMMANDS.exec(text)) {
    lastIndex = match.index;
  }
  TASK_QUEUE_COMMANDS.lastIndex = 0;
  return lastIndex;
}

function findPhraseMatches(text: string, phrases: readonly string[]): PhraseMatch[] {
  const normalized = text.toLocaleLowerCase();
  return phrases.flatMap((phrase) => {
    const normalizedPhrase = phrase.toLocaleLowerCase();
    const matches: PhraseMatch[] = [];
    let searchFrom = 0;
    while (searchFrom < normalized.length) {
      const index = normalized.indexOf(normalizedPhrase, searchFrom);
      if (index === -1) {
        break;
      }
      matches.push({ index, phrase: normalizedPhrase });
      searchFrom = index + normalizedPhrase.length;
    }
    return matches;
  });
}

function isNegatedPhrase(text: string, match: PhraseMatch): boolean {
  const normalized = text.toLocaleLowerCase();
  const after = normalized.slice(match.index + match.phrase.length).trimStart();
  if (NEGATION_AFTER_PHRASE.some((negation) => after.startsWith(negation))) {
    return true;
  }

  const before = normalized.slice(0, match.index);
  return NEGATION_BEFORE_PHRASE.some((negation) => before.endsWith(negation));
}

function isAdvisoryInstructionPhrase(text: string, match: PhraseMatch): boolean {
  const normalized = text.toLocaleLowerCase();
  if (normalized.includes('?') || normalized.includes('？')) {
    return true;
  }

  const before = normalized.slice(0, match.index);
  if (INDIRECT_INSTRUCTION_CONTEXTS.some((context) => before.endsWith(context))) {
    return true;
  }

  const after = normalized.slice(match.index + match.phrase.length).trimStart();
  if (INSTRUCTION_QUESTION_SUFFIXES.some((suffix) => after.startsWith(suffix))) {
    return true;
  }
  return after.includes('相談')
    && !INSTRUCTION_END_MARKERS.some((marker) => after.startsWith(marker));
}

function hasTaskQueueCommand(text: string): boolean {
  const normalized = text.toLocaleLowerCase();
  return findPhraseMatches(normalized, ['task queue']).some((match) => {
    if (isNegatedPhrase(normalized, match) || isAdvisoryInstructionPhrase(normalized, match)) {
      return false;
    }
    const before = normalized.slice(0, match.index);
    const commandIndex = findLastTaskQueueCommandIndex(before);
    if (commandIndex === undefined || match.index - commandIndex > MAX_TASK_QUEUE_COMMAND_DISTANCE) {
      return false;
    }
    const commandPrefix = normalized.slice(0, commandIndex);
    return !NEGATION_BEFORE_PHRASE.some((negation) => commandPrefix.endsWith(negation));
  });
}

function isDirectCommandTail(after: string): boolean {
  if (after === '') {
    return true;
  }
  return DIRECT_COMMAND_SUFFIXES.some((suffix) => after === suffix || after.startsWith(suffix));
}

function isIndirectDirectPhrase(text: string, match: PhraseMatch): boolean {
  if (isAdvisoryInstructionPhrase(text, match)) {
    return true;
  }

  const normalized = text.toLocaleLowerCase();
  const after = normalized.slice(match.index + match.phrase.length).trimStart();
  return !isDirectCommandTail(after);
}

function hasEnqueueInstruction(text: string): boolean {
  return findPhraseMatches(text, ENQUEUE_PHRASES)
    .some((match) => !isNegatedPhrase(text, match) && !isAdvisoryInstructionPhrase(text, match))
    || hasTaskQueueCommand(text);
}

function hasIssueAndEnqueueInstruction(text: string): boolean {
  return findPhraseMatches(text, ISSUE_AND_ENQUEUE_PHRASES)
    .some((match) => !isNegatedPhrase(text, match) && !isAdvisoryInstructionPhrase(text, match));
}

function hasDirectInstruction(text: string): boolean {
  return findPhraseMatches(text, DIRECT_PHRASES)
    .some((match) => !isNegatedPhrase(text, match) && !isIndirectDirectPhrase(text, match));
}

export function resolveAcpPromptIntent(
  text: string,
  defaultAction: AcpDefaultAction,
): AcpPromptIntent {
  const slashCommand = matchSlashCommand(text);
  if (slashCommand?.command === SlashCommand.Go) {
    return {
      kind: 'task_instruction',
      action: defaultAction,
      userNote: slashCommand.text.trim(),
    };
  }

  const hasDirect = hasDirectInstruction(text);
  const hasIssueAndEnqueue = hasIssueAndEnqueueInstruction(text);
  const hasEnqueue = hasEnqueueInstruction(text);

  if (hasDirect) {
    return {
      kind: 'task_instruction',
      action: 'direct',
      userNote: text,
    };
  }
  if (hasIssueAndEnqueue) {
    return {
      kind: 'task_instruction',
      action: 'create_issue_and_enqueue',
      userNote: text,
    };
  }
  if (hasEnqueue) {
    return {
      kind: 'task_instruction',
      action: 'enqueue',
      userNote: text,
    };
  }
  return { kind: 'conversation' };
}
