/**
 * OpenCode のツール引数を実行直前に矯正するプラグイン。
 *
 * ローカルモデル（qwen3-coder-next など）は数値引数を "290.0" のような文字列で送り、
 * キー名を "filepaath" と綴り間違える。OpenCode は型変換も別名解決もせず SchemaError で
 * 即失敗し、返すエラーに期待スキーマを載せないため、モデルは同じ呼び出しを繰り返す。
 * 上流の既知バグ（anomalyco/opencode#1328, #26870, #29142）で未修正。
 *
 * `tool.execute.before` はスキーマ検証より前に呼ばれるため、ここで直せば呼び出しは成立する。
 * 直すのは「検証できる誤り」だけに限る。値の意味を推測して補完はしない。
 *
 * TAKT は dist の絶対パスを OpenCode の config.plugin に渡して読み込ませる。
 * ユーザーのリポジトリに .opencode/plugin を作らない。
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** 数値として解釈すべき引数。ツールごとに列挙し、推測で広げない。 */
const NUMERIC_ARGS: Record<string, readonly string[]> = {
  read: ['offset', 'limit'],
  grep: ['limit'],
  glob: ['limit'],
  bash: ['timeout'],
  webfetch: ['timeout'],
};

/** filePath の代わりに観測された綴り。実在するパスを指すときだけ読み替える。 */
const FILE_PATH_ALIASES = ['filepaath', 'filepath', 'file_path', 'path', 'filename', 'fileName'] as const;

/** filePath を必須とし、既存ファイルを対象にするツール。 */
const FILE_PATH_TOOLS = ['read', 'edit'];

const INTEGER_LIKE = /^[+-]?\d+(?:\.0+)?$/;

/**
 * "290" と "290.0" だけを 290 に直す。
 *
 * 情報を落とさない変換だけを行う。"1.9" は切り捨てれば別の値になり、
 * "1e3" や "0x10" は書き手の意図が読めない。これらは変換せず、
 * OpenCode 本来のスキーマ検証に委ねる。
 */
function toInteger(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!INTEGER_LIKE.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * filePath が無いとき、別名に入った既存ファイルの絶対パスを filePath へ移す。
 *
 * 実在を確認できたものだけを扱う。候補が複数あるときは、どれが本命か決められないので
 * 何もしない。存在しないパスも、綴り間違いなのか新規作成の意図なのか区別できないので触らない。
 */
function recoverFilePath(args: Record<string, unknown>): void {
  if (typeof args.filePath === 'string') return;

  const candidates = FILE_PATH_ALIASES.filter((alias) => {
    const value = args[alias];
    return typeof value === 'string' && isAbsolute(value) && existsSync(value);
  });
  const [alias] = candidates;
  if (candidates.length !== 1 || alias === undefined) return;

  args.filePath = args[alias];
  delete args[alias];
}

interface ToolExecuteBeforeInput {
  tool: string;
}

interface ToolExecuteBeforeOutput {
  args: Record<string, unknown>;
}

export const CoerceToolArgs = async (): Promise<{
  'tool.execute.before': (input: ToolExecuteBeforeInput, output: ToolExecuteBeforeOutput) => Promise<void>;
}> => ({
  'tool.execute.before': async (input, output) => {
    const args = output.args;
    if (args === null || typeof args !== 'object') return;

    for (const name of NUMERIC_ARGS[input.tool] ?? []) {
      const coerced = toInteger(args[name]);
      if (coerced !== undefined) {
        args[name] = coerced;
      }
    }

    if (FILE_PATH_TOOLS.includes(input.tool)) {
      recoverFilePath(args);
    }
  },
});
