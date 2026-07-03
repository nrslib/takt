/**
 * builtin ファセットからレビュー評価用プロンプトを組み立てる。
 *
 *   node prompt-evals/build-prompts.ts [--lang ja] [--overlay <dir>]
 *
 * 生成物（prompt-evals/prompts/、gitignore 対象）:
 *   round1.txt          初回レビュー断面（固定欠陥コードの検出力測定）
 *   round2-base.txt     2周目断面（前回レポート付き、builtin ファセットそのまま）
 *   round2-overlay.txt  2周目断面（--overlay のファセットで instruction/契約を差し替え）
 *
 * ファセットは常にリポジトリの builtins/{lang}/facets から読むため、
 * ファセットを編集したらこのスクリプトを再実行するだけで評価が追随する。
 * overlay は実験的ファセット変種（例: overlays/rescan-evidence）を
 * builtin に重ねるための仕組みで、ファイル名が一致したものだけ置き換わる。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(evalRoot, '..');

const args = process.argv.slice(2);
const langIdx = args.indexOf('--lang');
const lang = langIdx !== -1 ? args[langIdx + 1] : 'ja';
const overlayIdx = args.indexOf('--overlay');
const overlayDir = overlayIdx !== -1 ? args[overlayIdx + 1] : undefined;

const facetsDir = join(repoRoot, 'builtins', lang ?? 'ja', 'facets');

function readFacet(relPath: string, overlay?: string): string {
  if (overlay !== undefined) {
    const overlayPath = join(evalRoot, overlay, relPath);
    if (existsSync(overlayPath)) {
      return readFileSync(overlayPath, 'utf-8');
    }
  }
  return readFileSync(join(facetsDir, relPath), 'utf-8');
}

function buildHeader(overlay?: string): string {
  const persona = readFacet('personas/architecture-reviewer.md', overlay);
  const policy = readFacet('policies/review.md', overlay);
  const knowledge = readFacet('knowledge/architecture.md', overlay);
  const instruction = readFacet('instructions/review-arch.md', overlay)
    .replaceAll('{step_iteration}', '2');
  const contract = readFacet('output-contracts/architecture-review.md', overlay);

  return [
    'あなたは TAKT ワークフローのレビューステップを実行するエージェントです。',
    'ツールは使えません。以下に与えられたコードと差分情報だけを根拠にレビューしてください。',
    '',
    '# エージェント定義（ペルソナ）',
    persona,
    '',
    '# Policy',
    policy,
    '',
    '# Knowledge',
    knowledge,
    '',
    '# Instructions',
    instruction,
    '',
    '# 出力契約（この形式でレポート全文を出力すること）',
    contract,
  ].join('\n');
}

const ROUND2_BLOCK = `
# 前回のレビュー（これは 2 回目のレビューです）
あなたの前回レポートと、コーダーの修正結果は以下の通り。指摘は修正済みであることを前回根拠で確認済み。

{{previous_report}}
`;

const CODE_BLOCK = `
# レビュー対象
今回のタスク: README.md の仕様に従いイベントソーシングの在庫管理ライブラリを実装する。
テスト（tests/、変更禁止）は全 51 件成功、型チェックも通過している。
変更差分はベース（スケルトン）からの累積で、実装の全体が以下の1ファイル。

## src/index.ts（新規実装・全文）
\`\`\`typescript
{{code}}
\`\`\`
`;

const outDir = join(evalRoot, 'prompts');
mkdirSync(outDir, { recursive: true });

writeFileSync(join(outDir, 'round1.txt'), buildHeader() + CODE_BLOCK);
writeFileSync(join(outDir, 'round2-base.txt'), buildHeader() + ROUND2_BLOCK + CODE_BLOCK);
if (overlayDir !== undefined) {
  writeFileSync(join(outDir, 'round2-overlay.txt'), buildHeader(overlayDir) + ROUND2_BLOCK + CODE_BLOCK);
}

console.log(`prompts generated (lang=${lang}${overlayDir !== undefined ? `, overlay=${overlayDir}` : ''})`);
