# tools/

TAKT の開発・運用に使うツールです。

## token-usage.sh

ワークフロー実行のトークン使用量を集計・表示します。

```bash
./tools/token-usage.sh              # 直近10件（mock除外）
./tools/token-usage.sh --top 20     # 直近20件
./tools/token-usage.sh --csv        # CSV出力
./tools/token-usage.sh --all        # mock/0トークンのランも含む
./tools/token-usage.sh /path/to/dir # 指定ディレクトリをスキャン
```

デフォルトでは `../takt-worktrees/` と `.takt/runs/` の両方を調べます。
使用前に `~/.takt/config.yaml` またはプロジェクトの `.takt/config.yaml` で `observability.usage_events_phase: true` を設定してください。

CSV 出力には `persona` と `tags` の列が含まれます。tags は `|` で連結し、persona または tags が異なる記録は別の行に集計します。

出力例:

```
============================================================================
  TAKT Token Usage Summary
============================================================================
  Total: 7.2B tokens (cached: 6.5B, 91% of input)
  Input: 7.1B  Output: 36.4M  Runs: 45
============================================================================

  2026-06-20  add-provider-base-url  ·································  167.8M
  codex/gpt-5.5  98 calls  cached: 92%
      ai-antipattern-fix (x10)  ·······································  41.4M
      ai-antipattern-review-1st (x18)  ································  15.9M
      arch-review (x6)  ···············································  11.2M
      ...
```

依存: `node`, `jq`

## debug-log-viewer.html

デバッグログ（`.takt/runs/*/logs/*.log`）をブラウザで閲覧できます。

## jsonl-viewer.html

JSONL ファイル（セッションログ、イベントログなど）をブラウザで閲覧できます。

## prompt-log-viewer.html

プロンプトログ（`*-prompts.jsonl`）をブラウザで閲覧できます。
