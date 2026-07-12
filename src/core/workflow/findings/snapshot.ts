/**
 * review scope snapshot id（codex 対策#4: typed evidence protocol の snapshotId
 * フィールドを支える機構）。
 *
 * reviewer は自分でハッシュを計算できない（コードを読むだけの LLM であり、
 * TAKT は review step にファイル内容を直接埋め込まない — reviewer は自分の
 * ツール呼び出しでリポジトリを探索する）。そこでエンジンが「このラウンドの
 * reviewer が見ている working tree の状態」を表す不透明なトークンを1つだけ
 * 計算し、reviewer 向け instruction に埋め込んで丸ごと echo させる
 * （raw-capabilities.ts の same_with_proof が availableSameProofId を echo
 * させるのと同じ「エンジン発行トークンをそのまま返させる」パターン）。
 *
 * 検証側（manager-runner.ts）は同じ cwd に対してこの関数をもう一度呼ぶ —
 * reviewer 呼び出しと検証呼び出しの間に書き込みが起きない通常経路では
 * 同じ値になる。値が違えば「reviewer が見た版と今の版が違う」ことが
 * 決定的にわかる（stale-snapshot、admission-validation.ts の
 * verifySourceQuoteEvidence 参照）。
 *
 * ハッシュには3系統を畳み込む:
 *   1. HEAD の commit sha（`git rev-parse HEAD`）
 *   2. tracked ファイルの未コミット差分（`git diff HEAD`）
 *   3. untracked（未追跡・非 .gitignore）ファイルの内容
 * 3 が必須なのは、実レビュー対象には coder が新規作成した untracked な src/
 * ファイルが含まれるため（codex 検証ブロッカー#4）。HEAD + diff HEAD だけだと
 * untracked ファイルは snapshot の外になり、「引用行はそのままで周辺行を
 * 書き換える」改変が snapshot も verbatimExcerpt 照合も一致したまま admission を
 * 通り抜けてしまう。untracked ファイルの内容をハッシュに含めることで、
 * レビュー対象ファイルが1バイトでも変われば snapshot 値が変わり stale 判定が
 * 効く（内容アドレス方式）。.gitignore 済み（node_modules 等）は
 * `--exclude-standard` で除外する。
 *
 * untracked ファイルの扱いで2つの穴を塞いでいる（codex 検証2巡目#3）:
 *   (a) 内容はサイズに依らず最後まで畳み込む。チャンク読みでメモリを固定するので、
 *       巨大ファイルでも「サイズだけ一致する改変（同サイズ書き換え）」を確実に
 *       検出できる（サイズだけの近似ハッシュはしない）。
 *   (b) symlink は追従しない。lstat で symlink を判定し、readlink の向き先文字列を
 *       ハッシュする。追従して target 内容を読むと、参照先すり替え（broken
 *       symlink の張り替え・スコープ外ファイルへの差し替え）を取りこぼす。
 *
 * git が使えない cwd（git コマンドが失敗する）では tracked 部分は空文字列に
 * フォールバックする — この場合スナップショット比較は常に一致する（同一の
 * 定数ハッシュ）が、verbatimExcerpt 自体の完全一致検証は独立して効き続けるため
 * 安全側に縮退する（stale 判定が効かないだけで、幻覚した引用は依然として
 * 不一致で弾かれる）。
 */
import { execFileSync } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * untracked ファイル内容を畳み込むときのチャンクバッファサイズ。ファイルの
 * サイズに依らずメモリをこの固定分だけに抑えつつ、内容を全量ハッシュする。
 */
const HASH_CHUNK_BYTES = 1024 * 1024;

function runGit(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/**
 * ファイル内容をチャンク読みで全量ハッシュへ畳み込む（メモリはチャンク分で固定。
 * サイズに依らず内容の1バイト変化も検出する。codex 検証2巡目#3a）。
 */
function hashFileContentInto(hash: Hash, absPath: string): void {
  const fd = openSync(absPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * cwd の working tree（tracked ファイルの未コミット差分 + untracked ファイルの
 * 内容）を内容アドレスする不透明なトークン。同じ cwd に対して書き込みが
 * 起きない限り決定的に同じ値を返す。
 */
export function computeReviewScopeSnapshotId(cwd: string): string {
  const head = runGit(cwd, ['rev-parse', 'HEAD']) ?? '';
  const dirtyDiff = runGit(cwd, ['diff', 'HEAD']) ?? '';
  // -z: NUL 区切り。ファイル名に空白・改行・特殊文字があっても曖昧にならない。
  const untrackedList = runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '';

  const hash = createHash('sha256').update(head).update('\0').update(dirtyDiff).update('\0');
  const untrackedFiles = untrackedList.split('\0').filter((name) => name.length > 0).sort();
  for (const file of untrackedFiles) {
    hash.update(file).update('\0');
    const absPath = join(cwd, file);
    let stat;
    try {
      stat = lstatSync(absPath); // lstat: symlink を追従しない
    } catch {
      // 一覧取得と検査の間に消えた/読めないファイルは定数で畳み込む。
      hash.update('__unreadable__').update('\0');
      continue;
    }
    if (stat.isSymbolicLink()) {
      // symlink は追従せず、リンクの向き先文字列そのものをハッシュする。参照先を
      // すり替えれば readlink 値が変わり snapshot も変わる。追従して target 内容を
      // 読むと、target 差し替えや broken symlink の張り替えを取りこぼす
      // （codex 検証2巡目#3b）。
      try {
        hash.update('__symlink__:').update(readlinkSync(absPath));
      } catch {
        hash.update('__broken-symlink__');
      }
    } else if (stat.isFile()) {
      // 内容を最後まで畳み込む（サイズだけの近似はしない。同サイズ改変も検出。
      // codex 検証2巡目#3a）。
      try {
        hashFileContentInto(hash, absPath);
      } catch {
        hash.update('__unreadable__');
      }
    } else {
      // ls-files --others は通常ファイル/symlink のみ列挙するが、防御的に種別だけ
      // 畳み込む（dir/socket/fifo 等）。
      hash.update('__non-file__');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}
