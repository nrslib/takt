# guard final review v3 evidence

準備:

```sh
node eval/scripts/prepare.mjs frontend-review frontend-review-react
```

Luna max（Reactなし/あり、先に実行）:

```sh
PROMPTFOO_CONFIG_DIR=/private/tmp/takt-guard-final-review-v3/promptfoo-luna npx promptfoo eval -c /private/tmp/takt-guard-final-review-v3/frontend-luna.yaml --no-cache --no-progress-bar -o /private/tmp/takt-guard-final-review-v3/luna-results.json
```

結果: 2/2 PASS。guard-a=REJECT、guard-b=OK。厳密JSON scorerで判定し、抽出はしていない。

Opus（同じtask/config条件）:

```sh
PROMPTFOO_CONFIG_DIR=/private/tmp/takt-guard-final-review-v3/promptfoo-opus npx promptfoo eval -c /private/tmp/takt-guard-final-review-v3/frontend-opus.yaml --no-cache --no-progress-bar -o /private/tmp/takt-guard-final-review-v3/opus-results.json
```

結果: 2 errors。`claude exited with code 1: Not logged in · Please run /login`。Opusの成功結果として扱わない。

この証跡はguard-a/b 2件だけの入力、最新版prepare後のprompt/snapshot、fixture、config、hash、Luna出力、Opus実行エラー出力を保存する。旧v2の32件評価結果と混同しない。

## 認証情報へアクセスできる環境での再試行

同じコマンドを権限を拡張して実行し、出力先とPROMPTFOO_CONFIG_DIRを別にした。元の起動エラーは保持している。`outputs/opus-results-escalated.json` は両構成2/2 PASS。前後の説明文やフェンスを除去せず、出力全体がJSON形式検査を通過した。
