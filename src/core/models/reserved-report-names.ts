/**
 * reports/ 直下の予約ファイル名。
 *
 * resume の継承 manifest（resume-artifacts.json）は reports スナップショットの
 * 内側に置かれる内部ファイルであり、workflow の成果物名前空間と衝突し得る。
 * 予約名を全境界（出力契約の Zod 検証・report-writer・{report:X} リゾルバ・
 * doctor）で拒否し、「同名レポートを持つ run を resume するとスナップショットの
 * 無条件除外で成果物が黙って消える」「内部形式へ意図せず依存する」事故を防ぐ。
 */

export const RESUME_ARTIFACTS_FILE_NAME = 'resume-artifacts.json';

/**
 * レポートファイル名が予約名かどうか。大文字小文字・前後空白を正規化し、
 * ネストしたパス指定（`sub/resume-artifacts.json`）も basename で判定する。
 * 区切りは `/` と `\` の双方を扱う — `/` だけだと Windows 形式の
 * `sub\resume-artifacts.json` が予約名判定を通過し、この共通関数を使う
 * 4境界（Zod / writer / reference / doctor）を同時に迂回できてしまう
 * （boundary requirement）。
 */
export function isReservedReportFileName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  const segments = normalized.split(/[/\\]/);
  const base = segments[segments.length - 1] ?? normalized;
  return base === RESUME_ARTIFACTS_FILE_NAME;
}

/** 予約名拒否の共通エラーメッセージ（境界ごとの主語を付けて使う）。 */
export function reservedReportFileNameMessage(name: string): string {
  return `"${name}" is a reserved internal file name (${RESUME_ARTIFACTS_FILE_NAME} holds the resume snapshot manifest); choose a different report name`;
}
