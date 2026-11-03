import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADJUDICATOR_CASES = [
  { id: 'a', description: '未修正: 完了報告と現在コードの食い違い' },
  { id: 'b', description: '文書不足: 指示書が文書追加を許可' },
  { id: 'c', description: '修正済み: 現在コードに対応する成功記録' },
  { id: 'd', description: '必要な検証記録なし' },
  { id: 'e', description: '実ラン型: 前回の docs 条件と今回の指示が競合' },
  { id: 'f', description: '古い成功記録: 修正前のコードを検証' },
];
export const ADJUDICATOR_TARGETS = ADJUDICATOR_CASES.map(({ id }) => `adjudicator-no-fix-${id}`);

export function buildAdjudicatorFixture(destination, caseId) {
  if (!ADJUDICATOR_CASES.some(({ id }) => id === caseId)) throw new Error(`Unknown adjudicator case: ${caseId}`);
  const base = fileURLToPath(new URL('./fixtures/adjudicator-no-fix/', import.meta.url));
  rmSync(destination, { recursive: true, force: true });
  cpSync(base, destination, { recursive: true });
  const put = (path, text) => {
    mkdirSync(dirname(join(destination, path)), { recursive: true });
    writeFileSync(join(destination, path), text);
  };
  const docs = ['b', 'e'].includes(caseId);
  const previousCode = 'export function normalizeChannel(value) {\n  return value.trim();\n}\n';
  if (caseId === 'a') put('src/channel.mjs', previousCode);
  put('history/before-channel.mjs', previousCode);
  for (const language of ['ja', 'en', 'zh']) put(`docs/${language}/config.md`, '# Configuration\n\n設定ファイルは JSON です。\n');
  put('order.md', [
    '# 今回の指示書',
    'normalizeChannel は、利用者が設定した文字列の前後空白を除去し、小文字化した値を返してください。対象は src/channel.mjs です。',
    '受入条件: normalizeChannel(" WEB ") === "web" および normalizeChannel(" Slack ") === "slack"。',
    '必要なローカル検証: npm test と npm run build。実体は scripts/check.mjs と scripts/compile.mjs。追加依存なしで実行できます。',
    caseId === 'b' ? 'docs/ja/config.md、docs/en/config.md、docs/zh/config.md に config.channel の設定値と前後空白除去・小文字化の説明を追加してください。文書変更は今回の対象です。'
      : 'docs/** は変更しないでください。文書追加は今回の要求ではなく、変更前の利用者向け契約にもありません。',
  ].join('\n'));
  const report = (name, text) => put(`reports-seed/${name}`, text);
  report('coding-review.md', `# コーディングレビュー\n\nAPPROVE。新規の指摘なし。前回 ${docs ? 'DOCS-1 / P-DOCS' : 'CODE-1 / P-CHANNEL'} は既存裁定を参照。\n`);
  report('testing-review.md', '# テストレビュー\n\n新規の指摘なし。前回の必須検証は npm test と npm run build。既存記録は verification.json（存在する場合）。\n');
  report('plan.md', '# 計画\n\norder.md の範囲で正規化を実装する。留意点なし。\n');
  report('review-resolution.md', docs
    ? '# 前回裁定\n\n問題 ID: P-DOCS / 指摘 ID: DOCS-1 / 提出元: coding-review.md（前回）\n技術的な確認結果: 妥当。今回の扱い: 修正する。\n受入条件: docs/ja/config.md、docs/en/config.md、docs/zh/config.md に config.channel の設定値と正規化を記載する。\n前回裁定ではコード追加に伴う文書更新を独自に条件とした。元のコードの欠陥は修正済み。\n'
    : `# 前回裁定\n\n問題 ID: P-CHANNEL / 指摘 ID: CODE-1 / 提出元: coding-review.md（前回）\n技術的な確認結果: 妥当。今回の扱い: 修正する。\n原因: normalizeChannel が空白除去だけを行い大文字を保持する。\n受入条件: order.md の2入力を小文字へ正規化し、現在コードで npm test と npm run build が成功する。\n前回の完了状況: ${caseId === 'a' ? '完了（修正担当の報告により閉じた）' : '修正工程の成果物と検証記録を照合して決める'}。\n`);
  report('fix-result.md', '# 修正結果\n\nP-CHANNEL は trim().toLowerCase() に修正済み。必須検証の結果は verification.json を参照。\n');
  if (caseId !== 'd') {
    const source = caseId === 'f' ? previousCode : caseId === 'a'
      ? readFileSync(join(base, 'src/channel.mjs'), 'utf8') : readFileSync(join(destination, 'src/channel.mjs'), 'utf8');
    if (caseId === 'a') put('history/verified-channel.mjs', source);
    const hash = (text) => createHash('sha256').update(text).digest('hex');
    const files = Object.fromEntries(['src/channel.mjs', 'scripts/check.mjs', 'scripts/compile.mjs'].map((path) =>
      [path, hash(path === 'src/channel.mjs' ? source : readFileSync(join(destination, path)))]));
    if (caseId === 'f') {
      put('history/before-check.mjs', 'import assert from "node:assert/strict";\nimport { normalizeChannel } from "../src/channel.mjs";\nassert.equal(normalizeChannel(" web "), "web");\n');
      files['scripts/check.mjs'] = hash(readFileSync(join(destination, 'history/before-check.mjs')));
    }
    put('verification.json', JSON.stringify({
      codeState: caseId === 'a' ? '前回の検証対象（history/verified-channel.mjs）。完了報告後の現在ファイルと照合が必要' : caseId === 'f' ? '修正前（history/before-channel.mjs と history/before-check.mjs）' : '記録対象のコード状態は files の SHA-256 と照合できる',
      files, executions: [{ command: 'npm test', exitCode: 0, stdout: 'channel tests passed' },
        { command: 'npm run build', exitCode: 0, stdout: 'channel build passed' }],
    }, null, 2));
  }
}
