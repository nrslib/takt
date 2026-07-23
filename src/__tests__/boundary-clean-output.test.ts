import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import assertBoundaryContractClean from '../../eval/asserts/boundary-contract-clean.mjs';
import assertBoundaryResourceClean from '../../eval/asserts/boundary-resource-clean.mjs';
import assertBoundaryRobustnessClean from '../../eval/asserts/boundary-robustness-clean.mjs';

const ASSERTION_CASES = [
  {
    config: 'promptfooconfig.boundary-contract-precision.yaml',
    assertionPath: 'file://asserts/boundary-contract-clean.mjs',
    assertion: assertBoundaryContractClean,
    positive: [
      'src/cli-import.ts:14 document.previews are persisted through store.save',
      'src/system-enqueue.ts:14 document.previews are persisted through store.save',
      'src/interactive-import.ts:17 document.previews are persisted through store.save',
    ].join('\n'),
    japanesePositive: [
      'src/cli-import.ts:14 document.previews のプレビューは store.save へ保存される',
      'src/system-enqueue.ts:14 document.previews のプレビューは store.save へ引き渡される',
      'src/interactive-import.ts:17 document.previews のプレビューは store.save へ伝播する',
    ].join('\n'),
    targetLine: 'src/cli-import.ts:14 document.previews are persisted through store.save',
    withoutLossTargetLine: 'src/cli-import.ts:14 document.previews are persisted through store.save without loss',
    negatedTargetLines: [
      'src/cli-import.ts:14 document.previews are not persisted through store.save',
      'src/cli-import.ts:14 document.previews are never persisted through store.save',
      'src/cli-import.ts:14 store.save does not preserve document.previews',
      'src/cli-import.ts:14 document.previews is not preserved by store.save',
      'src/cli-import.ts:14 document.previews のプレビューは store.save で保存されない',
      'src/cli-import.ts:14 document.previews は欠落するが store.save で保存する',
    ],
    contradictedTargetLines: [
      'src/cli-import.ts:14 the defect claim is false; document.previews are persisted through store.save',
      'src/cli-import.ts:14 document.previews fail to persist through store.save',
      'src/cli-import.ts:14 document.previews are persisted through store.save on the success path only',
      'src/cli-import.ts:14 document.previews are persisted through store.save except when enqueue fails',
      'src/cli-import.ts:14 document.previews are persisted through store.save unless enqueue fails',
      'src/cli-import.ts:14 the document is persisted through store.save without previews',
      'src/cli-import.ts:14 指摘は誤りだが document.previews のプレビューは store.save へ保存される',
      'src/cli-import.ts:14 document.previews のプレビューは store.save への保存に失敗する',
      'src/cli-import.ts:14 成功経路のみ document.previews のプレビューは store.save へ保存される',
      'src/cli-import.ts:14 失敗時を除き document.previews のプレビューは store.save へ保存される',
      'src/cli-import.ts:14 enqueue が失敗しない限り document.previews のプレビューは store.save へ保存される',
    ],
    citation: 'src/cli-import.ts:15',
  },
  {
    config: 'promptfooconfig.boundary-resource-precision.yaml',
    assertionPath: 'file://asserts/boundary-resource-clean.mjs',
    assertion: assertBoundaryResourceClean,
    positive: [
      'src/cli-import.ts:18 finally releasePreviews always runs on success and failure',
      'src/system-enqueue.ts:18 finally releasePreviews always runs on success and failure',
      'src/interactive-import.ts:21 finally releasePreviews always runs on success and failure',
    ].join('\n'),
    japanesePositive: [
      'src/cli-import.ts:18 finally で成功・失敗の全経路において必ず releasePreviews で解放する',
      'src/system-enqueue.ts:18 finally で成功・失敗の全経路において必ず releasePreviews で解放する',
      'src/interactive-import.ts:21 finally で成功・失敗の全経路において必ず releasePreviews で解放する',
    ].join('\n'),
    targetLine: 'src/cli-import.ts:18 finally releasePreviews always runs on success and failure',
    withoutLossTargetLine: 'src/cli-import.ts:18 finally releasePreviews always runs on success and failure without loss of resource ownership',
    negatedTargetLines: [
      'src/cli-import.ts:18 finally releasePreviews not always runs on success and failure',
      'src/cli-import.ts:18 finally releasePreviews never runs on success or failure',
      'src/cli-import.ts:18 finally releasePreviews does not always run on success and failure',
      'src/cli-import.ts:18 finally releasePreviews is not guaranteed on success and failure',
      'src/cli-import.ts:18 finally の releasePreviews は成功・失敗の全経路で解放されない',
      'src/cli-import.ts:18 finally で成功・失敗の全経路を releasePreviews で処理するが未解放になる',
    ],
    contradictedTargetLines: [
      'src/cli-import.ts:18 the leak finding is false; finally releasePreviews always runs on success and failure',
      'src/cli-import.ts:18 finally releasePreviews fails to run on success and failure',
      'src/cli-import.ts:18 finally releasePreviews runs on the success path only',
      'src/cli-import.ts:18 finally releasePreviews runs except on failure',
      'src/cli-import.ts:18 finally releasePreviews always runs on success and failure unless an exception occurs',
      'src/cli-import.ts:18 finally releasePreviews always runs on success and failure without cleanup',
      'src/cli-import.ts:18 未解放という指摘は誤りだが finally で成功・失敗時に releasePreviews を解放する',
      'src/cli-import.ts:18 finally で成功・失敗時に releasePreviews の解放に失敗する',
      'src/cli-import.ts:18 finally の releasePreviews は成功経路のみ解放する',
      'src/cli-import.ts:18 finally の releasePreviews は失敗時を除き解放する',
      'src/cli-import.ts:18 例外が発生しない限り finally で成功・失敗時に releasePreviews を解放する',
    ],
    citation: 'src/interactive-import.ts:20',
  },
  {
    config: 'promptfooconfig.boundary-robustness-precision.yaml',
    assertionPath: 'file://asserts/boundary-robustness-clean.mjs',
    assertion: assertBoundaryRobustnessClean,
    positive: [
      'src/import-document.ts:12 catch isolates preview failure and continues',
      'src/import-document.ts:15 warning is reported and visible',
      'src/import-document.ts:19 primary result body is preserved',
    ].join('\n'),
    japanesePositive: [
      'src/import-document.ts:12 catch でプレビュー失敗を捕捉して隔離し処理を継続する',
      'src/import-document.ts:15 warning の警告は利用者へ報告され可視になる',
      'src/import-document.ts:19 主結果の本文は保持されて返される',
    ].join('\n'),
    targetLine: 'src/import-document.ts:12 catch isolates preview failure and continues',
    withoutLossTargetLine: 'src/import-document.ts:12 catch isolates preview failure and continues without loss of the primary result',
    negatedTargetLines: [
      'src/import-document.ts:12 catch not isolates preview failure and continues',
      'src/import-document.ts:12 catch never isolates preview failure and continues',
      'src/import-document.ts:12 catch does not isolate preview failure and continues',
      'src/import-document.ts:12 catch is not isolating preview failure but continues',
      'src/import-document.ts:12 catch でプレビュー失敗を捕捉しないが処理は継続する',
      'src/import-document.ts:12 catch でプレビュー失敗を捕捉して隔離するが本文は失われ処理を継続する',
    ],
    contradictedTargetLines: [
      'src/import-document.ts:12 the failure finding is false; catch isolates preview failure and continues',
      'src/import-document.ts:12 catch fails to isolate preview failure and continues',
      'src/import-document.ts:12 catch isolates preview failure and continues on the success path only',
      'src/import-document.ts:12 catch isolates preview failure and continues except when downloadPreview rejects',
      'src/import-document.ts:12 catch isolates preview failure and continues unless downloadPreview rejects',
      'src/import-document.ts:12 catch continues preview failure without isolated handling',
      'src/import-document.ts:12 指摘は誤りだが catch でプレビュー失敗を捕捉して隔離し処理を継続する',
      'src/import-document.ts:12 catch でプレビュー失敗の隔離に失敗するが処理を継続する',
      'src/import-document.ts:12 成功経路のみ catch でプレビュー失敗を捕捉して隔離し処理を継続する',
      'src/import-document.ts:12 downloadPreview が拒否された場合を除き catch でプレビュー失敗を捕捉して隔離し処理を継続する',
      'src/import-document.ts:12 downloadPreview が失敗しない限り catch でプレビュー失敗を捕捉して隔離し処理を継続する',
    ],
    citation: 'src/import-document.ts:14',
  },
] as const;

function japaneseFindingContract(citation: string): string {
  return [
    '## 結果: REJECT',
    '## 観測した指摘',
    '| # | family_tag | 重大度 | 場所 | 欠陥 |',
    '|---|------------|--------|------|------|',
    `| 1 | boundary | high | \`${citation}\` | 未解消の欠陥 |`,
  ].join('\n');
}

function englishFindingContract(citation: string): string {
  return [
    '## Result: REJECT',
    '## Observed Findings',
    '| # | family_tag | Severity | Location | Defect |',
    '|---|------------|----------|----------|--------|',
    `| 1 | boundary | high | \`${citation}\` | unresolved defect |`,
  ].join('\n');
}

describe('boundary clean output assertions', () => {
  it.each(ASSERTION_CASES)('$config は肯定証跡を維持し選択済みREJECTをfinding表なしでも拒否する', ({
    config,
    assertionPath,
    assertion,
    positive,
  }) => {
    const evalConfig = parseYaml(
      readFileSync(join(process.cwd(), 'eval', config), 'utf-8'),
    ) as { tests: Array<{ assert: Array<{ value: string }> }> };
    const rejectedOutputs = [
      '## **Result:** **REJECT**',
      '## Result: **REJECT.**',
      '**結果：REJECT**',
      '| **Result** | **REJECT** |',
      '| Result | **REJECT** | extra |',
      '## _Result_ — _REJECT_',
      'REJECT (1 issue)',
      'REJECT — 1 finding',
      'REJECT（1件）',
      '## Result: REJECT (2 issues)',
      '## Result: REJECT [1 issue]',
      '## Result: REJECT (blocking defect remains)',
      '## Result: REJECT — unresolved boundary defect',
      '| Result | REJECT (1 issue) |',
      '| Result | REJECT (blocking defect remains) |',
      '| 結果 | REJECT（1件） |',
      '| 結果 | REJECT（未解消の欠陥あり） |',
      '| Result | REJECT | 1 finding |',
      '| 結果 | REJECT | 2件 |',
    ];

    expect(evalConfig.tests[0]?.assert[0]?.value).toBe(assertionPath);
    expect(assertion(positive)).toBe(true);
    for (const rejectedOutput of rejectedOutputs) {
      expect(assertion(`${positive}\n${rejectedOutput}`)).toBe(false);
    }
  });

  it.each(ASSERTION_CASES)('$config は引用と肯定証跡が同一行にある英日表現だけを通す', ({
    assertion,
    positive,
    japanesePositive,
    targetLine,
    withoutLossTargetLine,
  }) => {
    expect(assertion(positive)).toBe(true);
    expect(assertion(japanesePositive)).toBe(true);
    expect(assertion(positive.replace(targetLine, withoutLossTargetLine))).toBe(true);

    const separatedEvidence = positive.replace(
      targetLine,
      targetLine.replace(/^(\S+)\s+/, '$1\n'),
    );
    expect(assertion(separatedEvidence)).toBe(false);
  });

  it.each(ASSERTION_CASES)('$config は肯定語を含んでも否定された英日証跡を拒否する', ({
    assertion,
    positive,
    targetLine,
    negatedTargetLines,
    contradictedTargetLines,
  }) => {
    for (const rejectedTargetLine of [...negatedTargetLines, ...contradictedTargetLines]) {
      expect(assertion(positive.replace(targetLine, rejectedTargetLine))).toBe(false);
    }
  });

  it.each(ASSERTION_CASES)('$config はAPPROVEでもObserved Findingsの実データ行を拒否する', ({
    assertion,
    positive,
    citation,
  }) => {
    const rejectedOutputs = [
      japaneseFindingContract(citation).replace('結果: REJECT', '結果: APPROVE'),
      englishFindingContract(citation).replace('Result: REJECT', 'Result: APPROVE'),
      [
        '## **Result:** **APPROVE**',
        '## Observed Findings:',
        '| # | family_tag | Severity | Location | Defect |',
        '|---|------------|----------|----------|--------|',
        '| F-7 | boundary | high | N/A | unresolved defect without a citation |',
      ].join('\n'),
    ];

    for (const rejectedOutput of rejectedOutputs) {
      expect(assertion(`${positive}\n${rejectedOutput}`)).toBe(false);
    }
  });

  it.each(ASSERTION_CASES)('$config は2つ目以降のObserved Findings表の実データ行も拒否する', ({
    assertion,
    positive,
    citation,
  }) => {
    const output = [
      positive,
      '## Observed Findings',
      '| # | family_tag | Severity | Location | Defect |',
      '|---|------------|----------|----------|--------|',
      '## Notes',
      'No finding was selected in the first table.',
      '## Observed Findings',
      '| # | family_tag | Severity | Location | Defect |',
      '|---|------------|----------|----------|--------|',
      `| 2 | boundary | high | ${citation} | unresolved defect |`,
    ].join('\n');

    expect(assertion(output)).toBe(false);
  });

  it.each(ASSERTION_CASES)('$config は架空・複数引用を含む行頭compact REJECTを拒否する', ({
    assertion,
    positive,
  }) => {
    const rejectedOutputs = [
      'REJECT | src/imaginary.ts:999 | fabricated defect',
      'REJECT | fabricated defect | src/ghost.ts:777',
      '**REJECT** — `src/ghost.ts:777` — 架空の欠陥',
      '- **REJECT** – `src/ghost.ts:777`, `src/other.ts:888` – unresolved defect',
      'REJECT: src/a.ts:1 and src/b.ts:2 both demonstrate defects',
    ];

    for (const rejectedOutput of rejectedOutputs) {
      expect(assertion(`${positive}\n${rejectedOutput}`)).toBe(false);
    }
  });

  it.each(ASSERTION_CASES)('$config は未選択の判定テンプレートだけでは誤検出しない', ({
    assertion,
    positive,
  }) => {
    expect(assertion(`${positive}\n## Result: APPROVE / REJECT`)).toBe(true);
    expect(assertion(`${positive}\n## 結果: APPROVE / REJECT`)).toBe(true);
    expect(assertion(`${positive}\n## **Result:** **APPROVE / REJECT**`)).toBe(true);
    expect(assertion(`${positive}\n## Result: REJECT / APPROVE`)).toBe(true);
    expect(assertion(`${positive}\n| Result | APPROVE / REJECT |`)).toBe(true);
    expect(assertion([
      positive,
      '## **Observed Findings**',
      '| # | family_tag | Severity | Location | Defect |',
      '|---|------------|----------|----------|--------|',
    ].join('\n'))).toBe(true);
    expect(assertion([
      positive,
      '## Observed Findings:',
      '| # | family_tag | Severity | Location | Defect |',
      '|---|------------|----------|----------|--------|',
      '| 1 | contract-wiring | high / medium / low | `file:line` | {value or behavior propagation defect} |',
    ].join('\n'))).toBe(true);
    expect(assertion([
      positive,
      '## Observed Findings',
      '| # | family_tag | Severity | Location | Defect |',
      '|---|------------|----------|----------|--------|',
      '| 1 | ... | ... | ... | ... |',
    ].join('\n'))).toBe(true);
    expect(assertion([
      positive,
      '## Observed Findings',
      '| # | family_tag | Severity | Location | Defect |',
      '|---|------------|----------|----------|--------|',
      '| 1 | | | | |',
    ].join('\n'))).toBe(true);
  });
});
