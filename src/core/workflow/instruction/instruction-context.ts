/**
 * Instruction context types and edit rule generation
 *
 * Defines the context structures used by instruction builders.
 */

import type { AgentResponse, Language, WorkflowState } from '../../models/types.js';

/**
 * Context for building instruction from template.
 */
export interface InstructionContext {
  /** The main task/prompt */
  task: string;
  /** Current iteration number (workflow-wide turn count) */
  iteration: number;
  /** Maximum steps allowed */
  maxSteps: number;
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
  /** Top-level workflow steps for workflow structure display */
  workflowSteps?: ReadonlyArray<{ name: string; description?: string }>;
  /** Index of the current step in workflowSteps (0-based) */
  currentStepIndex?: number;
  /** Workflow name */
  workflowName?: string;
  /** Workflow description (optional) */
  workflowDescription?: string;
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
  /** Workflow state for context/structured/effect interpolation */
  workflowState?: WorkflowState;
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
