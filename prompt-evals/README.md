# prompt-evals — ファセットの断面評価（promptfoo）

builtin ファセット（レビュー系）の品質を、固定の欠陥コード fixture に対する
単発レビューで測る。ワークフローのループ動態は測れない（そちらは実走で測る）。
CI には乗せない。実プロバイダの認証（opencode / codex CLI）が必要な開発者ローカル向け。

## 使い方

```bash
# 1. ファセットからプロンプトを生成（ファセットを編集したら再実行）
node prompt-evals/build-prompts.ts --overlay overlays/rescan-evidence

# 2. 評価を実行
cd prompt-evals/configs
npx promptfoo@latest eval -c round2-rescan-ab.yaml --no-cache --repeat 3

# 3. 結果
npx promptfoo@latest view   # ブラウザ UI
```

## 構成

- `build-prompts.ts` — builtins/{lang}/facets から評価プロンプトを組み立てる。
  `--overlay <dir>` で実験的ファセット変種を重ねられる（同名ファイルだけ置換）
- `overlays/rescan-evidence/` — 再走査証跡（2周目に照合章と根拠の表を必須化）の変種
- `fixtures/flawed-index.ts.txt` — 既知欠陥入りの固定コード
  （T1: 出荷時に全予約分を減算する在庫破壊バグ / T3: version 二重管理 /
    T5: モノリス / T6: mutable な公開 initialState。テスト 51 件は通過する = レビューだけが検出できる）
- `fixtures/previous-report.md` — 2周目断面用の「前回レポート + 修正完了報告」
- `providers/` — exec プロバイダ（opencode run 経由のローカル系モデル）

## 測定の限界

- 単発断面のみ。セッション記憶を持った複数周のループ挙動（例: 実走で観測された
  証跡表の「該当なし」潰し）は再現しない
- 検出判定はキーワード正規表現なので言い回しに敏感。判定を変えたら実出力で校正すること
