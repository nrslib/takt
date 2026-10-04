# High 条件の凍結評価入力

2026-10-02 の実モデル評価に使ったプロンプト、インライン入力・rubric を持つ config、manifest を保存する。通常 suite の `low` 設定とは独立し、対象と grader はどちらも `gpt-6-sol` / `high`、`read-only`、approval `never`、ネットワークツール・Web 検索無効を維持する。

| ディレクトリ | 保存した条件 | config |
|---|---|---|
| `initial-comparison/` | 修正前と初版candidate、日英各6ケース | `before-{ja,en}.frozen.yaml`、`after-{ja,en}.frozen.yaml` |
| `mixed-planning/` | 初版candidateと最終r1、日英各1ケース | `initial-candidate-{ja,en}.frozen.yaml`、`r1-{ja,en}.frozen.yaml` |
| `final-regression/` | 最終r1、日英各6ケース。混在表ケースは除外 | `final-{ja,en}.frozen.yaml` |

プロンプトと facet は元のファイルのバイト列を保持している。本文に含まれる評価時の絶対パスは、当時モデルへ渡した文面の一部であり、再実行時のファイル参照先ではない。Phase 2 はツール使用を禁止し、これらのパスにあるファイルを必要としない。

config の `prompts` は同じディレクトリの保存済み本文へ、`working_dir` はリポジトリ内の `eval/.work/` へ相対化した。入力と rubric、その他の provider 設定は元のまま。manifest の `config` は相対化した凍結 config と一致させ、`configFile` を追加した。元の入力・rubric・本文・実行プロンプトの hash は変更していない。最終回帰の baseline 参照も保存先へ相対化した。未対応モデルの失敗記録は同梱せず、再実行の依存から除外した。

リポジトリのルートから実行する。`npm ci` と build 後、prepare で対象 cwd の fixture を作成する。prepare が生成する通常 suite 用プロンプトは、以下の凍結 config からは参照しない。

```sh
npm ci
npm run build
npm run eval:prompts:prepare -- implementation-report-contract-traceability implementation-report-contract-traceability-en
mkdir -p eval/.results/implementation-report-source-agnostic
PROMPTFOO_CONFIG_DIR=.tmp/promptfoo npm exec -- promptfoo eval \
  -c eval/results/implementation-report-source-agnostic/final-regression/final-en.frozen.yaml \
  --no-cache --repeat 3 --max-concurrency 2 \
  --output eval/.results/implementation-report-source-agnostic/final-en.rerun.json
```

日本語や修正前・初版・混在表の再実行は、表にある config へ `-c` と出力名を変更する。同じ比較では修正前または初版の評価を終えてから、比較対象の評価を開始する。日英を並行実行する場合、同時実行数は合計4になる。認証済み Codex SDK と対象モデルへのアクセスが必要で、対象と grader のモデル呼び出しに費用がかかる。

これは実行条件を保存した入力であり、再採点や新たな実モデル評価の結果ではない。元の応答、採点理由、runtime 監査はローカル成果物に保持する。元の結果と採点上の制約は [評価記録](../implementation-report-source-agnostic.md) を参照。
