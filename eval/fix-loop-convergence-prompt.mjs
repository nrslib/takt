// promptfoo prompt function: fix ループ収束規則の挙動評価。
// builtins/ja/facets の実ファセットを実行時に include 展開してロール別ヘッダを作り、
// cases/fix-loop-convergence/<scenario>.md のシナリオ本文と合成する。
// ファセットを変更すると、この評価は変更後の文面をそのまま対象にする。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandFacetIncludes } from 'faceted-prompting/cli/facet-includes';

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const FACETS_ROOT = join(EVAL_DIR, '../builtins/ja/facets');

function expandFacet(relativePath) {
  const body = readFileSync(join(FACETS_ROOT, relativePath), 'utf-8');
  return expandFacetIncludes({
    body,
    facetsRoots: [FACETS_ROOT],
    repertoireDirs: [],
    allowedRoots: [FACETS_ROOT],
  }).body;
}

const DRY_RUN_NOTE = 'これは机上評価環境であり、実際のコード編集・コマンド実行はできない。編集内容は方針レベルの記述でよい。環境制約（編集・実行ができないこと）を「作業結果」や判定の選択理由にしてはならない。方針が修正境界内で実行可能なら、編集と対象テストが完了したものとみなして判定すること。instruction の判定手順と必須出力は厳密に守ること。レポート参照 {report:...} は本文中に実体を与える。';

const ROLES = {
  'fix-retry': () => [
    'あなたは TAKT ワークフローの fix-retry ステップを実行する coder エージェントである。次の instruction 全文に従うこと。',
    '--- INSTRUCTION（全文） ---',
    expandFacet('instructions/apply-fix-verification.md'),
    '--- INSTRUCTION ここまで ---',
    DRY_RUN_NOTE,
  ].join('\n\n'),
  fix: () => [
    'あなたは TAKT ワークフローの fix ステップを実行する coder エージェントである。次の instruction 全文に従うこと。',
    '--- INSTRUCTION（全文） ---',
    expandFacet('instructions/apply-fix-plan.md'),
    '--- INSTRUCTION ここまで ---',
    DRY_RUN_NOTE,
  ].join('\n\n'),
  verifier: () => [
    'あなたは TAKT ワークフローの fix-verifier ステップを実行する coding-reviewer エージェントである。次の instruction 全文に従うこと。',
    '--- INSTRUCTION（全文） ---',
    expandFacet('instructions/verify-fix.md'),
    '--- INSTRUCTION ここまで ---',
    '出力は次の output contract に従うこと。',
    '--- OUTPUT CONTRACT（全文） ---',
    expandFacet('output-contracts/fix-verification.md'),
    '--- OUTPUT CONTRACT ここまで ---',
    'これは机上評価環境であり、コード実行はできない。シナリオ中の「観測事実」を独立検証の結果として扱ってよい。',
  ].join('\n\n'),
  monitor: () => [
    'あなたは TAKT ワークフローの loop_monitor 判定を行う supervisor エージェントである。fix-retry と fix-verifier のサイクルが閾値 4 回に達した（{cycle_count}=4）。次の instruction 全文に従うこと。',
    '--- INSTRUCTION（全文） ---',
    expandFacet('instructions/loop-monitor-reviewers-fix.md'),
    '--- INSTRUCTION ここまで ---',
    [
      '判定の選択肢は次の4つである。ちょうど1つを選ぶこと。',
      '1. 健全（修正進捗があり、報告内容も収束している）→ fix-retry へ継続',
      '2. 修正未完了または報告未収束だが、次の修正が実行可能である → fix-retry へ継続',
      '3. 修正方針の前提を変える必要があり、再計画が実行可能である → fix-plan へ',
      '4. 要件を満たす実現可能な打開手段がない → ABORT',
    ].join('\n'),
  ].join('\n\n'),
};

export default async function ({ vars }) {
  const buildHeader = ROLES[vars.role];
  if (buildHeader === undefined) throw new Error(`Unknown role: ${vars.role}`);
  const scenario = readFileSync(
    join(EVAL_DIR, 'cases', 'fix-loop-convergence', `${vars.scenario}.md`),
    'utf-8',
  );
  return `${buildHeader()}\n\n${scenario}`;
}
