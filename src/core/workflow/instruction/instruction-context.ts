/**
 * Instruction context types and edit rule generation
 *
 * Defines the context structures used by instruction builders.
 */

import type {
  AgentResponse,
  FallbackContext,
  Language,
  WorkflowMaxSteps,
  WorkflowState,
  ResolvedFacetContent,
} from '../../models/types.js';
import { loadTemplate } from '../../../shared/prompts/index.js';
import type { PullRequestContext } from '../pr-context.js';
import type { TaskReviewScope } from '../review-scope.js';
import type { FindingReviewPresentationContext } from '../findings/review-publication.js';

/**
 * FC レビュアーの出力契約。経路は1本しかない — レビュアーは常に markdown
 * レポートだけを書き、raw findings は正規化係の単発呼び出しが取り出す。
 */
export interface FindingContractReviewerContext {
  reviewScopeSnapshotId: string;
  presentationContext?: FindingReviewPresentationContext;
  /**
   * この呼び出しがレビューとして何を要求されているか。呼び出し側が明示する。
   *
   * `review`（既定）は通常のレビュー — 言い直し request があれば「レビューに加えて
   * これにも答えろ」として同梱する。`restatement-only` は言い直しだけを行う
   * 差し戻し呼び出しで、通常のレビュー指示は出さない。
   *
   * request 件数から導出してはならない。導出すると「言い直し request 付きの完全な
   * 再レビュー」が言い直し専用指示に化け、その publication で後続レビュー成立に
   * よる取り下げ（withdrawal）が走って未検証のまま anomaly が決着する。
   */
  mode?: 'review' | 'restatement-only';
}

export interface FindingContractInstructionContext {
  ledgerSummary: string;
  reportLedgerSummary: string;
  /** Whether the ledger currently has open findings (computed from the ledger, not re-parsed from the summary). */
  hasOpenFindings: boolean;
  /** Whether the ledger currently has waived findings. */
  hasWaivedFindings: boolean;
  hasDismissedFindings: boolean;
  /**
   * レビュアー step のときだけ設定される。この round のレビュー scope 束縛と
   * 再提示 batch を表す（レビュアーは markdown レポートだけを書くので、
   * provider へ渡す構造化出力契約はここにない）。
   */
  reviewer?: FindingContractReviewerContext;
}

export type FindingContractInstructionPolicy =
  | { mode: 'omit' }
  | { mode: 'explicit'; context: FindingContractInstructionContext };

/**
 * Context for building instruction from template.
 */
export interface InstructionContext {
  /** The main task/prompt */
  task: string;
  /** Current iteration number (workflow-wide turn count) */
  iteration: number;
  /** Maximum steps allowed */
  maxSteps: WorkflowMaxSteps;
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
  /** Fallback context to inject once after provider switching */
  fallbackContext?: FallbackContext;
  /** Preprocessed previous response text for template placeholder replacement */
  previousResponseText?: string;
  /** Report directory path */
  reportDir?: string;
  /**
   * run の reports ルート（namespace なし）。workflow_call の子の {report:X} が
   * 親成果物へ read-only フォールバックするために engine から明示的に渡す。
   */
  reportsRootDir?: string;
  /**
   * {report:X} の存在検証を無効化する（`takt prompt` プレビューなど実 run が
   * 存在しない文脈のみ）。既定は検証あり。
   */
  validateReportReferences?: boolean;
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
  /** Structured PR context resolved at the execution boundary. */
  prContext?: PullRequestContext;
  /**
   * Engine-computed changed file set for this task, resolved at the execution
   * boundary and rendered by the `{review_scope}` placeholder.
   */
  reviewScope?: TaskReviewScope;
  /** Resolved policy content strings for injection into instruction */
  policyContents?: readonly ResolvedFacetContent[];
  /** Source path for policy snapshot */
  policySourcePath?: string;
  /** Resolved knowledge content strings for injection into instruction */
  knowledgeContents?: readonly ResolvedFacetContent[];
  /** Source path for knowledge snapshot */
  knowledgeSourcePath?: string;
  /** Workflow state for context/structured/effect interpolation */
  workflowState?: WorkflowState;
  /** Scalar context inherited through workflow_call boundaries. */
  workflowCallVars?: Readonly<Record<string, string | number | boolean>>;
  /** Finding Contract input for reviewer raw finding output. */
  findingContract?: FindingContractInstructionContext;
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

type GitRulePhase = 'phase1' | 'phase2';

/**
 * git 操作の禁止ルール。文面は src/shared/prompts/{en,ja}/parts/git_rules.md にある。
 *
 * phase1 だけに載る「index の状態を根拠に指摘を立てるな」は、隣の「git add を実行するな」
 * が**行為**の禁止でしかなく、指摘を立てる**判断**を禁じていなかったために足した（#1012）。
 * TAKT が stage/commit を管理する実行では、実際にステージするのはワークフロー成功後の
 * stageAndCommit() だけなので、「未追跡だからコミットせよ」という指摘はそれ自身が
 * ブロックしている成功に依存し、coder には構造的に閉じられない。
 *
 * 禁止は index の状態に限る。.gitignore の誤設定や意図しない削除など、git の状態が
 * 正当な証拠になる場合まで潰さない。
 */
export function buildGitRules(
  allowGitCommit: boolean | undefined,
  language: Language,
  phase: GitRulePhase,
): string {
  if (allowGitCommit === true) {
    return '';
  }
  return loadTemplate('parts/git_rules', language, { isPhase1: phase === 'phase1' }).trimEnd();
}
