/**
 * Instruction context types and edit rule generation
 *
 * Defines the context structures used by instruction builders.
 */

import type { AgentResponse, Language } from '../../models/types.js';

/**
 * Context for building instruction from template.
 */
export interface InstructionContext {
  /** The main task/prompt */
  task: string;
  /** Current iteration number (piece-wide turn count) */
  iteration: number;
  /** Maximum movements allowed */
  maxMovements: number;
  /** Current movement's iteration number (how many times this movement has been executed) */
  movementIteration: number;
  /** Working directory (agent work dir, may be a clone) */
  cwd: string;
  /** Project root directory (where .takt/ lives). */
  projectCwd: string;
  /** User inputs accumulated during piece */
  userInputs: string[];
  /** Previous movement output if available */
  previousOutput?: AgentResponse;
  /** Source path for previous response snapshot */
  previousResponseSourcePath?: string;
  /** Preprocessed previous response text for template placeholder replacement */
  previousResponseText?: string;
  /** Report directory path */
  reportDir?: string;
  /** Language for metadata rendering. Defaults to 'en'. */
  language?: Language;
  /** Whether interactive-only rules are enabled */
  interactive?: boolean;
  /** Top-level piece movements for piece structure display */
  pieceMovements?: ReadonlyArray<{ name: string; description?: string }>;
  /** Index of the current movement in pieceMovements (0-based) */
  currentMovementIndex?: number;
  /** Piece name */
  pieceName?: string;
  /** Piece description (optional) */
  pieceDescription?: string;
  /** Retry note explaining why task is being retried */
  retryNote?: string;
  /** Resolved policy content strings for injection into instruction */
  policyContents?: string[];
  /** Source path for policy snapshot */
  policySourcePath?: string;
  /** Resolved knowledge content strings for injection into instruction */
  knowledgeContents?: string[];
  /** Source path for knowledge snapshot */
  knowledgeSourcePath?: string;
}

/**
 * Build the edit rule string for the execution context section.
 *
 * Returns a localized string describing the edit permission for this step.
 * Returns empty string when edit is undefined (no explicit permission).
 */
export function buildEditRule(edit: boolean | undefined, language: Language): string {
  if (edit === true) {
    if (language === 'ja') {
      return '**このステップでは編集が許可されています。** ユーザーの要求に応じて、ファイルの作成・変更・削除を行ってください。';
    }
    return '**Editing is ENABLED for this step.** You may create, modify, and delete files as needed to fulfill the user\'s request.';
  }
  if (edit === false) {
    if (language === 'ja') {
      return '**このステップでは編集が禁止されています。** プロジェクトのソースファイルを作成・変更・削除しないでください。コードの読み取り・検索のみ行ってください。レポート出力は後のフェーズで自動的に行われます。';
    }
    return '**Editing is DISABLED for this step.** Do NOT create, modify, or delete any project source files. You may only read and search code. Report output will be handled automatically in a later phase.';
  }
  return '';
}

/**
 * Build the git commit rule string for the execution context section.
 *
 * Returns a localized string describing the git commit/add prohibition for this step.
 * Returns empty string when allowGitCommit is true (prohibition suppressed).
 *
 * Phase 1 includes both git commit and git add prohibition.
 * Phase 2 includes only git commit prohibition (git add is not relevant).
 */
export function buildGitCommitRule(
  allowGitCommit: boolean,
  language: Language,
  phase: 'phase1' | 'phase2' = 'phase1',
): string {
  if (allowGitCommit) {
    return '';
  }
  if (phase === 'phase1') {
    if (language === 'ja') {
      return '- **git commit を実行しないでください。** コミットはワークフロー完了後にシステムが自動で行います。\n- **git add を実行しないでください。** ステージングもシステムが自動で行います。新規ファイルが未追跡（`??`）でも正常です。';
    }
    return '- **Do NOT run git commit.** Commits are handled automatically by the system after workflow completion.\n- **Do NOT run git add.** Staging is also handled automatically by the system. Untracked files (`??`) are normal.';
  }
  // phase2: git commit only
  if (language === 'ja') {
    return '- **git commit を実行しないでください。** コミットはワークフロー完了後にシステムが自動で行います。';
  }
  return '- **Do NOT run git commit.** Commits are handled automatically by the system after workflow completion.';
}
