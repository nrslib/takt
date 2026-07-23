import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import assertBoundaryContractRecall from '../../eval/asserts/boundary-contract-recall.mjs';
import assertBoundaryResourceRecall from '../../eval/asserts/boundary-resource-recall.mjs';
import assertBoundaryRobustnessRecall from '../../eval/asserts/boundary-robustness-recall.mjs';

const RECALL_CASES = [
  {
    config: 'promptfooconfig.boundary-contract.yaml',
    assertionPath: 'file://asserts/boundary-contract-recall.mjs',
    assertion: assertBoundaryContractRecall,
    matchingFindings: [
      '| 1 | contract-wiring | critical | src/system-enqueue.ts:12 | drops the previews before store.save | stored task receives empty previews | pass document.previews |',
      '| 1 | contract-wiring | high | src/system-enqueue.ts:12 | drops the previews before store.save | stored task receives empty previews | pass document.previews |',
      '| 1 | contract-wiring | medium | src/system-enqueue.ts:12 | previews are not propagated to persistence | consumer receives none | forward document.previews |',
      '| 1 | contract-wiring | high | src/system-enqueue.ts:12 | preview data never reaches store.save | persisted document is missing previews | save document.previews |',
      '| 1 | contract-wiring | high | src/system-enqueue.ts:12 | プレビューが保存先へ渡されず欠落する | 永続化先のプレビューが空になる | document.previews を渡す |',
      '| 1 | contract-wiring | high | src/system-enqueue.ts:12 | プレビューを空配列で上書き | System Enqueue 経路のプレビュー保持 | document.previews を保存する |',
      '| 1 | contract-wiring | critical | src/system-enqueue.ts:12 | 取得した previews を無視して空配列 [] を保存している | System Enqueue 経路でのプレビュー保持 | previews: document.previews に修正する |',
    ],
    invalidFixes: [
      'impact unknown',
      'no fix',
      'N/A',
      'inspect only',
      'do not pass document.previews',
    ],
    deniedFindings: [
      '| 1 | contract-wiring | high | src/system-enqueue.ts:12 | claim that previews are dropped before store.save is false | stored task receives empty previews | no fix |',
      '| 1 | contract-wiring | high | src/system-enqueue.ts:12 | persistence behavior is correct although previews are not propagated | stored task receives empty previews | no fix |',
      '| 1 | contract-wiring | high | src/system-enqueue.ts:12 | previews are preserved and retained when store.save would otherwise drop them | stored task receives empty previews | no fix |',
      '| 1 | contract-wiring | high | src/system-enqueue.ts:12 | store.save does not fail to propagate previews despite the alleged drop | stored task receives empty previews | no fix |',
      '| 1 | contract-wiring | high | src/system-enqueue.ts:12 | プレビューは保持されるため保存先で欠落するという指摘は誤り | 永続化先のプレビューが空になる | 修正不要 |',
    ],
    fixOnlyFinding: '| 1 | contract-wiring | high | src/system-enqueue.ts:12 | equivalent entry requires inspection | impact unknown | forward previews to store.save because they are not propagated and the consumer receives empty previews |',
    adjacentFindings: [
      '| 1 | contract-wiring | high | src/system-enqueue.ts:12 | equivalent entry point requires inspection | impact unknown | inspect |',
      '| 2 | contract-wiring | high | src/cli-import.ts:14 | drops the previews before store.save | stored task receives empty previews | pass document.previews |',
    ].join('\n'),
  },
  {
    config: 'promptfooconfig.boundary-resource.yaml',
    assertionPath: 'file://asserts/boundary-resource-recall.mjs',
    assertion: assertBoundaryResourceRecall,
    matchingFindings: [
      '| 1 | resource-ownership | critical | src/interactive-import.ts:11 | chooseDestination is outside the try/finally cleanup boundary | previews leak | move it inside |',
      '| 1 | resource-ownership | high | src/interactive-import.ts:11 | chooseDestination is outside the try/finally cleanup boundary | previews leak | move it inside |',
      '| 1 | resource-ownership | medium | src/interactive-import.ts:11 | chooseDestination occurs before the releasePreviews scope | previews remain unreleased | move it inside |',
      '| 1 | resource-ownership | high | src/interactive-import.ts:12 | chooseDestination precedes the cleanup scope | releasePreviews never runs on rejection | move it inside |',
      '| 1 | resource-ownership | high | src/interactive-import.ts:11 | chooseDestination は後始末の範囲外にある | プレビューが未解放になる | 範囲内へ移す |',
    ],
    invalidFixes: [
      'impact unknown',
      'no fix',
      'N/A',
      'inspect only',
      'do not move chooseDestination inside',
    ],
    deniedFindings: [
      '| 1 | resource-ownership | high | src/interactive-import.ts:11 | claim that chooseDestination is outside cleanup is incorrect | previews leak | no fix |',
      '| 1 | resource-ownership | high | src/interactive-import.ts:11 | chooseDestination is before cleanup but does not leak previews | previews remain unreleased | no fix |',
      '| 1 | resource-ownership | high | src/interactive-import.ts:11 | chooseDestination is outside finally but cleanup still runs | releasePreviews never runs on rejection | no fix |',
      '| 1 | resource-ownership | high | src/interactive-import.ts:11 | chooseDestination は後始末の範囲外ではない | プレビューが未解放になる | 修正不要 |',
      '| 1 | resource-ownership | high | src/interactive-import.ts:11 | chooseDestination は後始末より前にある | プレビューは未解放ではないため漏れるという指摘は誤り | 修正不要 |',
    ],
    fixOnlyFinding: '| 1 | resource-ownership | high | src/interactive-import.ts:11 | ownership requires inspection | impact unknown | move chooseDestination inside try/finally because releasePreviews never runs and previews leak |',
    adjacentFindings: [
      '| 1 | resource-ownership | high | src/interactive-import.ts:11 | cleanup boundary requires inspection | impact unknown | inspect |',
      '| 2 | resource-ownership | high | src/cli-import.ts:11 | chooseDestination is outside the try/finally cleanup boundary | previews leak | move it inside |',
    ].join('\n'),
  },
  {
    config: 'promptfooconfig.boundary-robustness.yaml',
    assertionPath: 'file://asserts/boundary-robustness-recall.mjs',
    assertion: assertBoundaryRobustnessRecall,
    matchingFindings: [
      '| 1 | failure-boundary | critical | src/import-document.ts:11 | downloadPreview throws an uncaught exception | primary result body is lost | isolate the failure |',
      '| 1 | failure-boundary | high | src/import-document.ts:11 | downloadPreview throws an uncaught exception | primary result body is lost | isolate the failure |',
      '| 1 | failure-boundary | high | src/import-document.ts:11 | preview rejection propagates as an error | prevents the body from being returned | isolate the failure |',
      '| 1 | failure-boundary | medium | src/import-document.ts:11 | preview download failure bubbles up | primary result is not returned | isolate the failure |',
      '| 1 | failure-boundary | high | src/import-document.ts:11 | プレビュー取得の失敗が伝播する | 本文を返せない | 失敗を分離する |',
    ],
    invalidFixes: [
      'impact unknown',
      'no fix',
      'N/A',
      'inspect only',
      'do not isolate the failure',
    ],
    deniedFindings: [
      '| 1 | failure-boundary | high | src/import-document.ts:11 | claim that preview rejection propagates as an error is false | primary result body is lost | no fix |',
      '| 1 | failure-boundary | high | src/import-document.ts:11 | preview failure does not throw, abort, or propagate | primary result body is lost | no fix |',
      '| 1 | failure-boundary | high | src/import-document.ts:11 | preview error is caught and continues with the import | primary result is not returned | no fix |',
      '| 1 | failure-boundary | high | src/import-document.ts:11 | preview rejection propagates as an error | primary result body is preserved and retained instead of lost | no fix |',
      '| 1 | failure-boundary | high | src/import-document.ts:11 | プレビュー取得の失敗が伝播することはない | 本文を返せない | 修正不要 |',
      '| 1 | failure-boundary | high | src/import-document.ts:11 | プレビュー取得の失敗が伝播する | 本文を返せないことはない | 修正不要 |',
      '| 1 | failure-boundary | high | src/import-document.ts:11 | プレビュー取得の例外は捕捉され処理が継続する | 主結果が失われる | 修正不要 |',
      '| 1 | failure-boundary | high | src/import-document.ts:11 | プレビュー取得の失敗が伝播する | 本文は保持されるため失われるという指摘は誤り | 修正不要 |',
    ],
    fixOnlyFinding: '| 1 | failure-boundary | high | src/import-document.ts:11 | failure handling requires inspection | impact unknown | catch the downloadPreview exception so it does not propagate and the primary result is not returned |',
    adjacentFindings: [
      '| 1 | failure-boundary | high | src/import-document.ts:11 | auxiliary failure handling requires inspection | impact unknown | inspect |',
      '| 2 | failure-boundary | high | src/cli-import.ts:11 | downloadPreview throws an uncaught exception | primary result body is lost | isolate the failure |',
    ].join('\n'),
  },
] as const;

describe('boundary buggy recall assertions', () => {
  it.each(RECALL_CASES)('$config は対象citationと欠陥説明が同じfinding行にある場合だけpassする', ({
    config,
    assertionPath,
    assertion,
    matchingFindings,
    invalidFixes,
    deniedFindings,
    fixOnlyFinding,
    adjacentFindings,
  }) => {
    const evalConfig = parseYaml(
      readFileSync(join(process.cwd(), 'eval', config), 'utf-8'),
    ) as { tests: Array<{ assert: Array<{ value: string }> }> };

    expect(evalConfig.tests[0]?.assert[0]?.value).toBe(assertionPath);
    for (const matchingFinding of matchingFindings) {
      expect(assertion(matchingFinding)).toBe(true);
    }
    for (const deniedFinding of deniedFindings) {
      expect(assertion(deniedFinding)).toBe(false);
    }
    for (const invalidFix of invalidFixes) {
      expect(assertion(matchingFindings[0].replace(
        /\| [^|]+ \|$/,
        `| ${invalidFix} |`,
      ))).toBe(false);
    }
    expect(assertion(fixOnlyFinding)).toBe(false);
    expect(assertion(adjacentFindings)).toBe(false);
    expect(assertion([
      matchingFindings[0],
      '| 2 | other-family | high | src/other.ts:1 | unrelated defect | unrelated impact | unrelated fix |',
    ].join('\n'))).toBe(false);
    expect(assertion(matchingFindings[0].replace(
      /(src\/[^| ]+:\d+)/,
      '$1 and src/other.ts:99',
    ))).toBe(false);
    expect(assertion(matchingFindings[0].replace(
      /\| (src\/[^| ]+:\d+) \| ([^|]+) \|/,
      '| N/A | $1 $2 |',
    ))).toBe(false);
    expect(assertion(matchingFindings[0].replace(
      /\| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/,
      '| requires inspection | impact unknown | $1 $2 $3 |',
    ))).toBe(false);
    expect(assertion(`${matchingFindings[0].slice(0, -1)}| extra column |`)).toBe(false);
    const findingCells = matchingFindings[0]
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    expect(assertion(`| ${findingCells.slice(0, 6).join(' | ')} |`)).toBe(false);
    for (const cellIndex of [4, 5, 6]) {
      const citedOutsideLocation = findingCells.map((cell, index) => (
        index === cellIndex ? `${cell} cites src/other.ts:99` : cell
      ));
      expect(assertion(`| ${citedOutsideLocation.join(' | ')} |`)).toBe(false);
    }
    const emptyFix = findingCells.map((cell, index) => (index === 6 ? '' : cell));
    expect(assertion(`| ${emptyFix.join(' | ')} |`)).toBe(false);
  });
});
