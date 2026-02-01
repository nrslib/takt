/**
 * Instruction context types and execution metadata rendering
 *
 * Defines the context structures used by instruction builders,
 * and renders execution metadata (working directory, rules) as markdown.
 */

import type { AgentResponse, Language } from '../models/types.js';

/**
 * Context for building instruction from template.
 */
export interface InstructionContext {
  /** The main task/prompt */
  task: string;
  /** Current iteration number (workflow-wide turn count) */
  iteration: number;
  /** Maximum iterations allowed */
  maxIterations: number;
  /** Current step's iteration number (how many times this step has been executed) */
  stepIteration: number;
  /** Working directory (agent work dir, may be a clone) */
  cwd: string;
  /** Project root directory (where .takt/ lives). */
  projectCwd: string;
  /** User inputs accumulated during workflow */
  userInputs: string[];
  /** Previous step output if available */
  previousOutput?: AgentResponse;
  /** Report directory path */
  reportDir?: string;
  /** Language for metadata rendering. Defaults to 'en'. */
  language?: Language;
}

/** Execution environment metadata prepended to agent instructions */
export interface ExecutionMetadata {
  /** The agent's working directory (may be a clone) */
  readonly workingDirectory: string;
  /** Language for metadata rendering */
  readonly language: Language;
  /** Whether file editing is allowed for this step (undefined = no prompt) */
  readonly edit?: boolean;
}

/**
 * Build execution metadata from instruction context and step config.
 *
 * Pure function: (InstructionContext, edit?) → ExecutionMetadata.
 */
export function buildExecutionMetadata(context: InstructionContext, edit?: boolean): ExecutionMetadata {
  return {
    workingDirectory: context.cwd,
    language: context.language ?? 'en',
    edit,
  };
}

/** Localized strings for execution metadata rendering */
export const METADATA_STRINGS = {
  en: {
    heading: '## Execution Context',
    workingDirectory: 'Working Directory',
    rulesHeading: '## Execution Rules',
    noCommit: '**Do NOT run git commit.** Commits are handled automatically by the system after workflow completion.',
    noCd: '**Do NOT use `cd` in Bash commands.** Your working directory is already set correctly. Run commands directly without changing directories.',
    editEnabled: '**Editing is ENABLED for this step.** You may create, modify, and delete files as needed to fulfill the user\'s request.',
    editDisabled: '**Editing is DISABLED for this step.** Do NOT create, modify, or delete any project source files. You may only read/search code and write to report files in the Report Directory.',
    note: 'Note: This section is metadata. Follow the language used in the rest of the prompt.',
  },
  ja: {
    heading: '## 実行コンテキスト',
    workingDirectory: '作業ディレクトリ',
    rulesHeading: '## 実行ルール',
    noCommit: '**git commit を実行しないでください。** コミットはワークフロー完了後にシステムが自動で行います。',
    noCd: '**Bashコマンドで `cd` を使用しないでください。** 作業ディレクトリは既に正しく設定されています。ディレクトリを変更せずにコマンドを実行してください。',
    editEnabled: '**このステップでは編集が許可されています。** ユーザーの要求に応じて、ファイルの作成・変更・削除を行ってください。',
    editDisabled: '**このステップでは編集が禁止されています。** プロジェクトのソースファイルを作成・変更・削除しないでください。コードの読み取り・検索と、Report Directoryへのレポート出力のみ行えます。',
    note: '',
  },
} as const;

/**
 * Render execution metadata as a markdown string.
 *
 * Pure function: ExecutionMetadata → string.
 * Always includes heading + Working Directory + Execution Rules.
 * Language determines the output language; 'en' includes a note about language consistency.
 */
export function renderExecutionMetadata(metadata: ExecutionMetadata): string {
  const strings = METADATA_STRINGS[metadata.language];
  const lines = [
    strings.heading,
    `- ${strings.workingDirectory}: ${metadata.workingDirectory}`,
    '',
    strings.rulesHeading,
    `- ${strings.noCommit}`,
    `- ${strings.noCd}`,
  ];
  if (metadata.edit === true) {
    lines.push(`- ${strings.editEnabled}`);
  } else if (metadata.edit === false) {
    lines.push(`- ${strings.editDisabled}`);
  }
  if (strings.note) {
    lines.push('');
    lines.push(strings.note);
  }
  lines.push('');
  return lines.join('\n');
}
