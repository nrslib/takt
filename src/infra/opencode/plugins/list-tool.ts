/**
 * 'list' ツール互換シム（opencode plugin）。
 *
 * 背景（v3-r4 実測）: opencode 1.17.18 の tool registry に 'list' は存在しない
 * （'ls' への改名でもなく削除）。一方でローカルモデル（qwen3-coder-next 等）は
 * 'list' を執拗に呼び、unavailable-tool recovery（fresh session 1回）後も
 * 同名再発して確定失敗した。前置文の誘導修正に加え、幻覚の受け皿として
 * ディレクトリ一覧の最小ツールを登録する（codex 条件付き採用）。
 *
 * 責務の上限（codex 裁定）: fs.promises.readdir({ withFileTypes: true }) のみ。
 * 任意コマンド・再帰探索・glob・ファイル内容読み取りへ広げない。
 *
 * 配布経路は coerce-tool-args.ts と同じ（TAKT dist の絶対パスを config.plugin
 * へ渡す）。dist は TAKT パッケージ内にあるため 'zod' は TAKT の node_modules
 * から解決される（実測）。'@opencode-ai/plugin' は絶対パス配布のプラグインから
 * 解決できない（実測: ResolveMessage）ため import しない — ToolDefinition は
 * `tool()` ヘルパーの恒等関数を通しただけの素のオブジェクトなので、同形の
 * リテラルを返せばよい（args は Zod の raw shape）。
 *
 * 登録の可否は TAKT 側の起動時 registry プローブが決める（client.ts の
 * shouldRegisterListToolShim — upstream に 'list' が実在する場合は fail-closed
 * で登録しない）。プラグイン初期化中に自サーバの /experimental/tool/ids を
 * 引くと deadlock する（実測: タイムアウト）ため、プラグイン内では判定しない。
 */
import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

/** 巨大ディレクトリ対策の出力上限（エントリ数）。 */
const MAX_LIST_ENTRIES = 200;

/** @opencode-ai/plugin の ToolContext のうち、このシムが使う部分の局所型。 */
interface ListToolContext {
  readonly agent: string;
  /** セッションのプロジェクトディレクトリ。相対パスの基準。 */
  readonly directory: string;
  /** worktree ルート。境界（この外は拒否）。 */
  readonly worktree: string;
  readonly abort: AbortSignal;
  ask(input: {
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('list tool call aborted');
  }
}

async function resolveWithinWorktree(
  requestedPath: string,
  context: ListToolContext,
): Promise<string> {
  const targetAbs = isAbsolute(requestedPath)
    ? requestedPath
    : resolve(context.directory, requestedPath);
  // root と対象の双方を realpath してから比較する。symlink がワークツリー外を
  // 指す escape はここで実パスに解決され、境界検査で拒否される。
  const rootReal = await fs.realpath(context.worktree);
  const targetReal = await fs.realpath(targetAbs);
  const relFromRoot = relative(rootReal, targetReal);
  // startsWith('..') だけだと workspace 直下の正当な `..visible` のような
  // ディレクトリ名を escape と誤判定する（codex 指摘）。親方向は「`..` 単体」
  // または「`..` + 区切り」で始まる場合のみ。
  if (relFromRoot === '..' || relFromRoot.startsWith(`..${sep}`) || isAbsolute(relFromRoot)) {
    throw new Error(
      `list: path escapes the workspace root: ${requestedPath} (resolved to ${targetReal})`,
    );
  }
  return targetReal;
}

export const ListToolShim = async (): Promise<{
  tool: Record<string, {
    description: string;
    args: Record<string, unknown>;
    execute(args: { path?: string }, context: ListToolContext): Promise<string>;
  }>;
}> => ({
  tool: {
    list: {
      description: 'List the entries of a single directory (non-recursive). '
        + 'Returns entry names, one per line; directories end with "/". '
        + 'Use glob for pattern matching or read for file contents.',
      args: {
        path: z.string().optional().describe(
          'Directory to list. Relative paths resolve against the project directory. Defaults to the project directory.',
        ),
      },
      async execute(args: { path?: string }, context: ListToolContext): Promise<string> {
        throwIfAborted(context.abort);
        const requestedPath = args.path === undefined || args.path.trim() === '' ? '.' : args.path.trim();
        const targetReal = await resolveWithinWorktree(requestedPath, context);
        // 可視性（per-prompt tools の read → list）と実行時権限の二重化:
        // execute 内で必ず read 権限の ask を通す。
        await context.ask({
          permission: 'read',
          patterns: [targetReal],
          always: [],
          metadata: { tool: 'list', path: targetReal },
        });
        throwIfAborted(context.abort);
        const entries = await fs.readdir(targetReal, { withFileTypes: true });
        throwIfAborted(context.abort);
        // 安定ソート（ロケール非依存の決定的順序）。
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const shown = entries.slice(0, MAX_LIST_ENTRIES);
        const lines = shown.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
        const truncatedNote = entries.length > shown.length
          ? `\n… (${entries.length - shown.length} more entries not shown; narrow the path or use glob)`
          : '';
        return `${targetReal}:\n${lines.join('\n')}${truncatedNote}`;
      },
    },
  },
});
