import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPAIR_STRATEGY_TARGET = 'repair-strategy';
export const REPAIR_STRATEGY_CASES = ['k1', 'r1', 'i1', 'f1', 'p1', 'm1'];
export const REPAIR_STRATEGY_LANGUAGES = ['ja', 'en'];
export function repairStrategyWorkDirectory(caseId, language, stage) {
  const caseIndex = REPAIR_STRATEGY_CASES.indexOf(caseId);
  const languageIndex = REPAIR_STRATEGY_LANGUAGES.indexOf(language);
  const stageIndex = ['adjudication', 'plan'].indexOf(stage);
  if ([caseIndex, languageIndex, stageIndex].includes(-1)) throw new Error('Unknown repair workspace configuration');
  const index = (languageIndex * REPAIR_STRATEGY_CASES.length + caseIndex) * 2 + stageIndex + 1;
  return `repair-workspace-${String(index).padStart(2, '0')}`;
}
const sourceRoot = fileURLToPath(new URL('./fixtures/repair-strategy/', import.meta.url));
const source = name => readFileSync(join(sourceRoot, name), 'utf8');

const keySpec = 'key(parts) は文字列2要素の組を識別する。各要素は任意の文字列で、区切り記号や空文字も正当な入力。異なる組は異なるキーになること。同じ組のキーは安定すること。既存データと外部利用者はない。';
const resourceSpec = 'run は取得した lease を、処理終了後に一度だけ解放する。正常時は {status:"ok",value:7}、body の失敗時は元の例外をそのまま返す。signal.aborted は pool.acquire 中にも変化するため、取得後に評価する。中断時は body を呼ばず {status:"cancelled"} を返す。返却後に lease を使う consumer はない。release は例外を送出しない。';
const independentSpec = 'cents は非負の有限数を最も近い整数のセントへ丸める。allowed は canRead の真偽値を返す。name は受け取った文字列の前後空白を除く。これらは独立した公開関数で、同じ service.mjs にある。';

const keyObservations = [
  ['v0', 'A', { left: 'a|b|c', right: 'a|b|c' }, false],
  ['v1', 'A', { left: 'a~b|c', right: 'a|b~c' }, true],
  ['v1', 'B', { left: 'a~b|c', right: 'a~b|c' }, false],
  ['v2', 'A', { left: 'a~b|c', right: 'a|b~c' }, true],
  ['v2', 'B', { left: 'a~b|c', right: 'a_b|c' }, true],
  ['v2', 'C', { left: 'a_b|c', right: 'a_b|c' }, false],
].map(([version, probe, observed, passed]) => [version, probe,
  { ...observed, leftAgain: observed.left, rightAgain: observed.right }, passed]);
const resourceObservations = [
  ['v0', 'A', { acquired: 1, released: 0, calls: 1, outcome: { status: 'ok', value: 7 } }, false],
  ['v1', 'A', { acquired: 1, released: 1, calls: 1, outcome: { status: 'ok', value: 7 } }, true],
  ['v1', 'B', { acquired: 1, released: 0, calls: 1, outcome: 'original-error' }, false],
  ['v2', 'A', { acquired: 1, released: 1, calls: 1, outcome: { status: 'ok', value: 7 } }, true],
  ['v2', 'B', { acquired: 1, released: 1, calls: 1, outcome: 'original-error' }, true],
  ['v2', 'C', { acquired: 1, released: 0, calls: 0, outcome: { status: 'cancelled' } }, false],
].map(([version, probe, observed, passed]) => [version, probe,
  { ...observed, abortedBeforeAcquire: false, abortedAfterAcquire: probe === 'C' }, passed]);
const independentObservations = [
  ['v0', 'A', 123, false], ['v1', 'A', 124, true], ['v1', 'B', true, false],
  ['v2', 'A', 124, true], ['v2', 'B', false, true], ['v2', 'C', ' Ada ', false],
];

export function buildRepairStrategyFixture(destination, caseId, language = 'ja') {
  if (!REPAIR_STRATEGY_CASES.includes(caseId)) throw new Error(`Unknown repair case: ${caseId}`);
  if (!REPAIR_STRATEGY_LANGUAGES.includes(language)) throw new Error(`Unknown repair language: ${language}`);
  const put = (path, body) => {
    mkdirSync(dirname(join(destination, path)), { recursive: true });
    writeFileSync(join(destination, path), body);
  };
  const domain = caseId === 'r1' ? 'resource' : caseId === 'i1' ? 'independent' : 'key';
  const hasHistory = caseId !== 'f1';
  const spec = domain === 'resource' ? resourceSpec : domain === 'independent' ? independentSpec : keySpec;
  const constraint = caseId === 'm1'
    ? '\n追加の必須条件: 保存先との契約により key の返却値は、各要素の ~ を _ に、続いて | を ~ に置き換え、| で連結した値と、全入力で一致すること。この方式と返却値を変更する承認は得ていない。異なる組の識別条件も引き続き必須。'
    : caseId === 'p1' ? '\n利用側は readKey と writeKey。両方とも同じ組の識別条件を満たすこと。' : '';
  put('.takt/config.yaml', `language: ${language}\n`);
  put('package.json', '{"type":"module","scripts":{"test":"node --test tests/evidence.test.mjs"}}\n');
  put('spec.md', `# 仕様\n${spec}${constraint}\n修正範囲は src/service.mjs とその検証。履歴は参照資料。\n`);
  put('task.md', 'spec.md の要求と coding-review.md の指摘を、現在のコードと記録に照らして扱ってください。ソース編集・検証の実行はこの評価の対象ではありません。\n');
  put('src/service.mjs', source(caseId === 'p1' ? 'progress.mjs' : `${domain}-v2.mjs`));
  put('tests/probes.mjs', source(`${domain}-probes.mjs`));
  if (hasHistory) {
    for (const version of ['v0', 'v1', 'v2']) put(`history/${version}.mjs`, source(`${domain}-${version}.mjs`));
  }
  const observations = domain === 'resource' ? resourceObservations : domain === 'independent' ? independentObservations : keyObservations;
  const records = (hasHistory ? observations : observations.filter(([version]) => version === 'v2'))
    .map(([version, probe, observed, passed]) => ({
      source: hasHistory ? `history/${version}.mjs` : 'src/service.mjs', version: hasHistory ? version : 'current', probe, observed, passed,
      expected: 'spec.md の当該条件', exitCode: passed ? 0 : 1,
    }));
  put('records.json', JSON.stringify(records, null, 2) + '\n');
  put('tests/verify.mjs', `import { observe, satisfied } from './probes.mjs';
const [path, probe] = process.argv.slice(2);
const service = await import(new URL('../' + path, import.meta.url));
const result = await observe(service, probe);
console.log(JSON.stringify(result));
process.exitCode = satisfied(result, probe) ? 0 : 1;
`);
  put('tests/evidence.test.mjs', `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { observe, satisfied } from './probes.mjs';
const records = JSON.parse(readFileSync(new URL('../records.json', import.meta.url), 'utf8'));
for (const record of records) {
  test(record.source + ' / ' + record.probe + ' recorded observation', async () => {
    const service = await import(new URL('../' + record.source, import.meta.url));
    const actual = await observe(service, record.probe);
    assert.deepEqual(actual, record.observed);
    assert.equal(satisfied(actual, record.probe), record.passed);
    assert.equal(record.exitCode, record.passed ? 0 : 1);
  });
}
`);
  const condition = domain === 'resource' ? 'C: 取得後の中断で解放回数0。body 呼出回数0、返却値は仕様どおり。'
    : domain === 'independent' ? 'C: name(" Ada ") が " Ada " を返す。期待値 "Ada"。'
    : 'C: ["a~b","c"] と ["a_b","c"] がともに "a_b|c" になる。';
  const currentProblem = domain === 'independent' ? 'P-NAME' : 'P-1';
  const finding = `CODE-C / ${currentProblem}: ${caseId === 'p1' ? 'writeKey → key の経路。' : ''}${condition} src/service.mjs、tests/probes.mjs、records.json を参照。仕様の適用範囲内。`;
  put('reports-seed/coding-review.md', `# コーディングレビュー\nREJECT\n${finding}\n`);
  put('reports-seed/review-resolution.md', `# 現在の裁定\n修正対象あり。${finding}\n受入条件: spec.md の当該条件。修正範囲: src/service.mjs と必要な検証。\n`);
  if (hasHistory) {
    const methods = domain === 'resource'
      ? ['正常終了の body の後に release を置く。', 'body の例外を catch して release し、元の例外を送出する。']
      : domain === 'independent'
        ? ['cents の floor を round に変える。', 'allowed の条件を user.canRead に変える。']
        : ['| を ~ に置き換えて連結する。', '~ を _ に置き換えてから | を ~ に置き換え、連結する。'];
    for (const [index, probe] of ['A', 'B'].entries()) {
      const version = `v${index + 1}`;
      put(`history/repair-${index + 1}/finding.md`, `# 指摘 ${probe}\n${domain === 'independent' ? ['P-CENTS', 'P-ACCESS'][index] : 'P-1'} / CODE-${probe}: records.json の修正前 ${probe} で spec.md の条件が成立しない。入力・経路は tests/probes.mjs を参照。\n`);
      put(`history/repair-${index + 1}/fix-plan.md`, `# 修正計画\n${methods[index]}\n対象: src/service.mjs。完了条件は spec.md の ${probe} の条件。\n`);
      put(`history/repair-${index + 1}/fix-report.md`, `# 修正報告\n${methods[index]}\n対象コード状態: history/${version}.mjs。records.json の ${version} の ${probe} と、それ以前の確認対象が成功した。\n`);
      put(`history/repair-${index + 1}/fix-verification.md`, `# 修正完了検証\nverified\n対象: history/${version}.mjs。${['A', 'B'].slice(0, index + 1).join('、')} の検証 exit 0。観測値は records.json。\n`);
    }
  }
  if (caseId === 'p1') {
    put('history/migration-plan.md', '# 修正計画\nencodeKey の長さ付き表現を readKey と writeKey の両方で使う。異なる組を識別し、同じ組は両経路で同じキーにする。既存データと外部利用者はない。\n');
    put('history/migration-report.md', '# 修正報告\nreadKey を encodeKey へ移行済み。C の2入力は 3:a~b1:c と 3:a_b1:c に分かれた。writeKey はまだ key を呼ぶ。\n');
    put('history/migration-verification.md', '# 修正完了検証\nincomplete\nreadKey の C は成功、writeKey の C は同じキーを返す。対象コード: src/service.mjs。\n');
  }
  return { caseId, hasHistory, domain };
}
