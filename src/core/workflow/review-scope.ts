/**
 * タスクのレビュースコープ（このタスクの変更対象ファイル集合）の算出と提示。
 *
 * ## 作業ツリー計算（cwd 由来）
 *
 * 次の和集合である。レビューが走る時点でタスクの変更が既にブランチへ
 * コミット済みの構成では HEAD との差分が空になり、コミット済み範囲を
 * 含めないとレビュアーから変更が見えない。これはブランチレビュー、
 * エージェント自身がコミットするワークフロー、ベンチのチェックポイント
 * コミット、worktree クローンの自動コミット後の再レビューで発生する。
 * - base コミット..HEAD のコミット済み変更
 * - HEAD と working tree の差分（削除を含む）
 * - untracked ファイル（ignored を除く）
 *
 * この作業ツリー計算はレビュー対象の一貫した範囲を決めるために共有する。
 *
 * ## PR スコープ（指示注入側だけの拡張）
 *
 * prContext を持つ実行では、PR の diff range `base...head` と未コミット変更・
 * 未追跡ファイルの和集合を提示する。推定 base からのコミット済み変更を足すと、
 * 同期で取り込んだ base 側の変更まで含まれるため、PR の明示 base を使う。
 * PR の head ブランチ上では現在の HEAD、それ以外では headDiffRef を使う。`--pr` は
 * 「PR のレビューコメントを取り込んで修正する」フローであり、同じ実行の中で
 * 作業ツリーが変更される。かつ headDiffRef はコミット済みしか映さず
 * auto-commit はワークフロー完了後なので、PR diff range だけでは
 * 修正→再レビューのループでレビュアーが修正前の姿を渡される。
 *
 * この計算はレビュアー指示への注入だけの拡張である。snapshot.ts は
 * cwd の作業ツリーを記録するため prContext を受け取らず、ローカルに
 * materialize されていない PR 側のパスは含めない。
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import type { Language } from '../models/types.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { escapeTemplateChars } from '#faceted-prompting';
import {
  toCloneBaseRef,
  toLocalBranchRef,
  toPullRequestBaseRef,
  toRemoteTrackingBranchRef,
} from '../../shared/utils/gitBranchValidation.js';
import { resolveMergeBase } from '../../infra/task/branchBaseCandidateResolver.js';
import { resolveBranchEntryPointFromReflog } from '../../infra/task/branchEntryPointResolver.js';
import { detectDefaultBranch } from '../../infra/task/branchList.js';
import { getCurrentBranch } from '../../infra/task/git.js';
import type { PullRequestContext } from './pr-context.js';

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** プロンプト肥大を防ぐ表示上限。超過分は残件数を明示して省略する。 */
export const REVIEW_SCOPE_MAX_LISTED_PATHS = 200;

const DETACHED_HEAD_BRANCH = 'HEAD';
const MISSING_REF_EXIT_STATUS = 1;

export type ReviewScopeBaseRange =
  /** cwd が git リポジトリではない。 */
  | { readonly kind: 'not_a_git_repository' }
  /** base コミットが確定し、そこから HEAD までのコミット済み変更を含む。 */
  | { readonly kind: 'branch_base'; readonly baseCommit: string }
  /** 現在のブランチが base ブランチそのもの。タスク由来のコミット範囲は存在しない。 */
  | { readonly kind: 'base_branch_head' }
  /** コミットがまだ1つもないリポジトリ。 */
  | { readonly kind: 'no_commits' }
  /** base を特定できなかった。コミット済み変更は一覧に含まれない。 */
  | { readonly kind: 'unresolved'; readonly reason: string };

export interface ReviewScopeDiffRange {
  readonly baseDiffRef: string;
  readonly headDiffRef: string;
}

export type ReviewScopeSource =
  | { readonly kind: 'working_tree'; readonly baseRange: ReviewScopeBaseRange }
  | {
    readonly kind: 'pull_request';
    readonly prNumber: number;
    /** ローカルに materialize された PR の diff range。未 materialize なら undefined。 */
    readonly diffRange?: ReviewScopeDiffRange;
    /** 未コミット変更・未追跡ファイルが paths へ寄与したか。 */
    readonly includesWorkingTree: boolean;
    readonly baseRange: ReviewScopeBaseRange;
  };

export type TaskReviewScope =
  | { readonly kind: 'not_a_git_repository' }
  | {
    readonly kind: 'collected';
    /** 重複排除・ソート済みのリポジトリ相対パス。 */
    readonly paths: readonly string[];
    readonly source: ReviewScopeSource;
  };

export interface TaskReviewScopeInput {
  readonly cwd: string;
  /** 境界で一度だけ解決した base。 */
  readonly baseRange: ReviewScopeBaseRange;
  /** PR 由来の実行のみ設定される。PR の累積差分と未コミット変更・未追跡を対象とする。 */
  readonly prContext?: PullRequestContext;
  /**
   * 同一瞬間に読んだ untracked を共有するための注入口。snapshot.ts は
   * inventory と changedPaths の由来を同じ読み取りへ揃えるために渡す。
   */
  readonly untracked?: readonly string[];
}

function runGit(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_MAX_BUFFER,
  });
}

/**
 * git の終了コードを返す。spawn 失敗（git 未インストール等）は述語へ潰さず送出する。
 * 「コマンドを実行できなかった」と「git が false を返した」は別の事実である。
 */
function gitExitStatus(cwd: string, args: string[]): number {
  try {
    runGit(cwd, args);
    return 0;
  } catch (cause) {
    const status = (cause as { status?: unknown }).status;
    if (typeof status !== 'number') {
      throw cause;
    }
    return status;
  }
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function refExists(cwd: string, ref: string): boolean {
  const status = gitExitStatus(cwd, ['rev-parse', '--verify', '--quiet', ref]);
  if (status === 0) {
    return true;
  }
  if (status === MISSING_REF_EXIT_STATUS) {
    return false;
  }
  throw new Error(`git rev-parse --verify ${ref} failed with exit status ${status}`);
}

/**
 * NUL 区切りパスの解析。
 * snapshot.ts の parseNulEntries とは別実装で、非 UTF-8 パスや壊れた出力に対して
 * 投げる例外型が経路ごとに異なる（あちらは ReviewScopeSnapshotError）。証拠検証側は
 * inventory 用にパスを Buffer のまま扱う必要があるため統合していない。
 */
function parseNulPaths(output: Buffer, command: string): string[] {
  if (output.length === 0) {
    return [];
  }
  if (output[output.length - 1] !== 0) {
    throw new Error(`${command}: NUL-terminated output is missing its final delimiter`);
  }

  const paths: string[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end === start) {
      throw new Error(`${command}: NUL-terminated output contains an empty path`);
    }
    const raw = output.subarray(start, end);
    const decoded = raw.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(raw)) {
      throw new Error(`${command}: repository path is not reversibly UTF-8 encoded`);
    }
    paths.push(decoded);
    start = end + 1;
  }
  return paths;
}

function sortedUnique(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort();
}

type AncestryCheck = 'ancestor' | 'not_ancestor' | 'undetermined';

/**
 * 0 / 1 以外（オブジェクト喪失による 128 など）は「判定不能」として扱う。
 * base の絞り込みは最適化であり、ここで実行を止める価値はない。
 * base 解決全体の fail-fast（ref 検証・HEAD 検証）はそのまま維持している。
 */
function checkAncestry(cwd: string, ancestor: string, descendant: string): AncestryCheck {
  const status = gitExitStatus(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (status === 0) {
    return 'ancestor';
  }
  return status === MISSING_REF_EXIT_STATUS ? 'not_ancestor' : 'undetermined';
}

/**
 * reflog の分岐点と merge-base の両方が取れたときは子孫側（新しい方）を採る。
 * rebase や base ブランチ取り込みの後は reflog の最古エントリが実際の分岐点より
 * 古くなり、無関係な差分までスコープが膨張するため。
 * 祖先関係が無い場合と判定不能な場合は、HEAD との共通祖先であることが
 * 保証されている merge-base を採る。
 */
function pickNarrowerBase(cwd: string, reflogBase: string, mergeBase: string): string {
  return checkAncestry(cwd, mergeBase, reflogBase) === 'ancestor' ? reflogBase : mergeBase;
}

/**
 * merge-base の相手となる ref を選ぶ。TAKT がクローンへ materialize した base ref を
 * 優先し、無ければ検出した default branch を使う。origin remote を削除したクローンでは
 * ローカルに base ブランチが残らないため、この候補列が必要になる。
 * 既存ブランチをそのまま clone する resume 経路では3候補とも存在しないことがあり、
 * その場合は reflog へ、それも無ければ unresolved になる（docs に制約として記載）。
 */
function resolveBaseRefCandidate(
  cwd: string,
  branch: string,
  defaultBranch: string,
): string | undefined {
  const candidates = [toPullRequestBaseRef(branch), toCloneBaseRef(branch), defaultBranch];
  return candidates.find((ref) => refExists(cwd, ref));
}

function resolveMergeBaseCommit(
  cwd: string,
  branch: string,
  defaultBranch: string,
): string | undefined {
  const baseRef = resolveBaseRefCandidate(cwd, branch, defaultBranch);
  if (baseRef === undefined) {
    return undefined;
  }
  try {
    const commit = resolveMergeBase(cwd, baseRef, branch);
    return commit.length === 0 ? undefined : commit;
  } catch (cause) {
    // 共通祖先が無い（履歴が独立している）と merge-base は非ゼロ終了する。
    // spawn 失敗はここでも潰さず送出する。
    if (typeof (cause as { status?: unknown }).status !== 'number') {
      throw cause;
    }
    return undefined;
  }
}

/**
 * base の解決。ref 候補の列挙と merge-base 計算を伴うため、ラン境界で一度だけ
 * 実行して保持する（createTaskReviewScopeResolver）。
 */
export function resolveReviewScopeBaseRange(cwd: string): ReviewScopeBaseRange {
  // spawnSync は「git が無い」場合も「cwd が無い」場合も同じ ENOENT を返す。
  // 存在しないディレクトリを先に弾いておくことで、残る ENOENT を git 未導入として
  // 送出できる（実行できなかった事実を not_a_git_repository へ潰さない）。
  if (!isExistingDirectory(cwd)) {
    return { kind: 'not_a_git_repository' };
  }
  if (gitExitStatus(cwd, ['rev-parse', '--git-dir']) !== 0) {
    return { kind: 'not_a_git_repository' };
  }
  const headStatus = gitExitStatus(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (headStatus === MISSING_REF_EXIT_STATUS) {
    return { kind: 'no_commits' };
  }
  if (headStatus !== 0) {
    throw new Error(`git rev-parse --verify HEAD failed with exit status ${headStatus}`);
  }

  const branch = getCurrentBranch(cwd);
  if (branch === DETACHED_HEAD_BRANCH) {
    return { kind: 'unresolved', reason: 'HEAD is detached' };
  }

  const defaultBranch = detectDefaultBranch(cwd);
  if (branch === defaultBranch) {
    return { kind: 'base_branch_head' };
  }

  const mergeBase = resolveMergeBaseCommit(cwd, branch, defaultBranch);
  const reflogBase = resolveBranchEntryPointFromReflog(cwd, branch)?.baseCommit;
  if (mergeBase !== undefined && reflogBase !== undefined) {
    return { kind: 'branch_base', baseCommit: pickNarrowerBase(cwd, reflogBase, mergeBase) };
  }
  if (mergeBase !== undefined) {
    return { kind: 'branch_base', baseCommit: mergeBase };
  }
  if (reflogBase !== undefined) {
    return { kind: 'branch_base', baseCommit: reflogBase };
  }
  return {
    kind: 'unresolved',
    reason: `no base ref for ${branch} and no branch entry point in the reflog`,
  };
}

function readUntrackedPaths(cwd: string): string[] {
  return parseNulPaths(
    runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
    'git ls-files --others',
  );
}

function collectUncommittedPaths(
  cwd: string,
  baseRange: ReviewScopeBaseRange,
  untracked: readonly string[],
): string[] {
  if (baseRange.kind === 'no_commits') {
    return sortedUnique(untracked);
  }

  const workingTree = parseNulPaths(
    runGit(cwd, ['diff', '--name-only', '-z', 'HEAD', '--']),
    'git diff --name-only HEAD',
  );
  return sortedUnique([...workingTree, ...untracked]);
}

function collectWorkingTreePaths(
  cwd: string,
  baseRange: ReviewScopeBaseRange,
  untracked: readonly string[],
): string[] {
  const workingTree = collectUncommittedPaths(cwd, baseRange, untracked);
  const committed = baseRange.kind === 'branch_base'
    ? parseNulPaths(
      runGit(cwd, ['diff', '--name-only', '-z', baseRange.baseCommit, 'HEAD', '--']),
      'git diff --name-only <base> HEAD',
    )
    : [];

  return sortedUnique([...committed, ...workingTree]);
}

function resolvePullRequestBranchRef(
  cwd: string,
  branch: string,
  role: 'base' | 'head',
): string | undefined {
  const candidates = role === 'base'
    ? [toRemoteTrackingBranchRef(branch), toLocalBranchRef(branch)]
    : [toLocalBranchRef(branch), toRemoteTrackingBranchRef(branch)];
  return candidates.find((ref) => refExists(cwd, ref));
}

function materializedDiffRange(
  cwd: string,
  prContext: PullRequestContext,
): ReviewScopeDiffRange | undefined {
  // --skip-git は diff ref を作らないため、PR が明示したブランチの既存 ref だけを使う。
  const baseDiffRef = prContext.baseDiffRef ?? resolvePullRequestBranchRef(cwd, prContext.baseBranch, 'base');
  const headDiffRef = prContext.headDiffRef ?? resolvePullRequestBranchRef(cwd, prContext.headBranch, 'head');
  if (baseDiffRef === undefined || headDiffRef === undefined) {
    return undefined;
  }
  if (!refExists(cwd, baseDiffRef) || !refExists(cwd, headDiffRef)) {
    return undefined;
  }
  return {
    baseDiffRef,
    headDiffRef: getCurrentBranch(cwd) === prContext.headBranch ? 'HEAD' : headDiffRef,
  };
}

/**
 * PR の累積差分と、未コミット変更・未追跡ファイルの和集合。
 * `--pr` は修正を伴うフローなので、同じ実行で作られた変更も対象に含める。
 */
function collectPullRequestScope(
  cwd: string,
  prContext: PullRequestContext,
  baseRange: ReviewScopeBaseRange,
  workingTreePaths: readonly string[],
): TaskReviewScope {
  const diffRange = materializedDiffRange(cwd, prContext);
  const pullRequestPaths = diffRange === undefined
    ? []
    : parseNulPaths(
      runGit(cwd, [
        'diff',
        '--name-only',
        '-z',
        `${diffRange.baseDiffRef}...${diffRange.headDiffRef}`,
        '--',
      ]),
      'git diff --name-only <base>...<head>',
    );

  return {
    kind: 'collected',
    paths: sortedUnique([...pullRequestPaths, ...workingTreePaths]),
    source: {
      kind: 'pull_request',
      prNumber: prContext.prNumber,
      ...(diffRange === undefined ? {} : { diffRange }),
      includesWorkingTree: workingTreePaths.length > 0,
      baseRange,
    },
  };
}

/** 解決済みの base を受け取り、変更対象ファイル集合を算出する。 */
export function collectTaskReviewScope(input: TaskReviewScopeInput): TaskReviewScope {
  if (input.baseRange.kind === 'not_a_git_repository') {
    return { kind: 'not_a_git_repository' };
  }
  const untracked = input.untracked ?? readUntrackedPaths(input.cwd);
  if (input.prContext !== undefined) {
    const workingTreePaths = collectUncommittedPaths(input.cwd, input.baseRange, untracked);
    return collectPullRequestScope(input.cwd, input.prContext, input.baseRange, workingTreePaths);
  }
  const workingTreePaths = collectWorkingTreePaths(input.cwd, input.baseRange, untracked);
  return {
    kind: 'collected',
    paths: workingTreePaths,
    source: { kind: 'working_tree', baseRange: input.baseRange },
  };
}

/**
 * ラン中に別の kind へ遷移し得る base はキャッシュしない。
 * `no_commits` は初コミットで `branch_base` / `base_branch_head` へ、
 * `not_a_git_repository` は `git init` や worktree 生成で、
 * `base_branch_head` はブランチ切り替えで変わる。特に `no_commits` を
 * 保持すると初コミット後にトラッキング済み変更が恒久的に見えなくなる。
 * `branch_base`（分岐点は動かない）と `unresolved`（手がかりが無い状態は
 * ラン中に回復しない）だけを保持し、ref 走査の再実行を避ける。
 */
function isStableBaseRange(baseRange: ReviewScopeBaseRange): boolean {
  return baseRange.kind === 'branch_base' || baseRange.kind === 'unresolved';
}

/**
 * ラン境界で作る解決器。分岐点はラン中に動かないので cwd ごとに保持し、
 * 作業ツリーは動くので毎回読み直す。
 */
export function createTaskReviewScopeResolver(deps: {
  readonly getCwd: () => string;
  readonly getPrContext: () => PullRequestContext | undefined;
}): () => TaskReviewScope {
  const stableBaseRangeByCwd = new Map<string, ReviewScopeBaseRange>();
  return () => {
    const cwd = deps.getCwd();
    const cached = stableBaseRangeByCwd.get(cwd);
    const baseRange = cached ?? resolveReviewScopeBaseRange(cwd);
    if (cached === undefined && isStableBaseRange(baseRange)) {
      stableBaseRangeByCwd.set(cwd, baseRange);
    }
    const prContext = deps.getPrContext();
    return collectTaskReviewScope({
      cwd,
      baseRange,
      ...(prContext === undefined ? {} : { prContext }),
    });
  };
}

type ReviewScopeTemplateVars = Record<string, string | boolean | null>;

function buildPathVars(paths: readonly string[]): ReviewScopeTemplateVars {
  if (paths.length === 0) {
    return { noPaths: true };
  }
  const listed = paths.slice(0, REVIEW_SCOPE_MAX_LISTED_PATHS);
  const omittedCount = paths.length - listed.length;
  return {
    hasPaths: true,
    totalCount: String(paths.length),
    pathList: escapeTemplateChars(listed.map((path) => `- ${path}`).join('\n')),
    hasOmitted: omittedCount > 0,
    shownCount: String(listed.length),
    omittedCount: String(omittedCount),
  };
}

function buildBaseRangeVars(baseRange: ReviewScopeBaseRange): ReviewScopeTemplateVars {
  switch (baseRange.kind) {
    case 'not_a_git_repository':
      return { notRepository: true };
    case 'branch_base':
      return {
        isBranchBase: true,
        baseCommit: escapeTemplateChars(baseRange.baseCommit.slice(0, 12)),
      };
    case 'base_branch_head':
      return { isBaseBranchHead: true };
    case 'no_commits':
      return { isNoCommits: true };
    case 'unresolved':
      return {
        isBaseUnresolved: true,
        baseUnresolvedReason: escapeTemplateChars(baseRange.reason),
      };
  }
}

function buildSourceVars(source: ReviewScopeSource): ReviewScopeTemplateVars {
  if (source.kind !== 'pull_request') {
    return buildBaseRangeVars(source.baseRange);
  }
  const prNumber = String(source.prNumber);
  if (source.diffRange === undefined) {
    return { isPullRequestWithoutDiffRange: true, prNumber };
  }
  return {
    isPullRequest: true,
    prNumber,
    diffRange: escapeTemplateChars(
      `${source.diffRange.baseDiffRef}...${source.diffRange.headDiffRef}`,
    ),
    ...(source.includesWorkingTree ? { includesWorkingTree: true } : { noWorkingTreeChange: true }),
  };
}

function buildScopeVars(scope: TaskReviewScope | undefined): ReviewScopeTemplateVars {
  if (scope === undefined) {
    return { notComputed: true };
  }
  if (scope.kind === 'not_a_git_repository') {
    return { notRepository: true };
  }
  return { ...buildPathVars(scope.paths), ...buildSourceVars(scope.source) };
}

/**
 * {review_scope} の本文を組み立てる。
 * スコープが得られない場合も、その事実を述べる文言に解決する（空文字にしない）。
 */
export function renderTaskReviewScope(
  scope: TaskReviewScope | undefined,
  language: Language,
): string {
  return loadTemplate('parts/review_scope', language, buildScopeVars(scope)).trim();
}
