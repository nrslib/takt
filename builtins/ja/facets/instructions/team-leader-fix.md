Finding Contract の open finding を、競合しない修正パートへ分解してください。親 Team Leader 自身はツールを使わず、engine が注入する Finding Contract ledger summary を一次情報として計画します。

**分解の要件:**
- lifecycle が `new`、`persists`、`reopened` の finding だけを対象にする
- 各 part instruction に finding ID、担当ファイル、参照専用ファイル、直接修正内容、完了基準を明記する
- 同じファイルを複数パートへ割り当てない
- 同じバッチ内の各 part は単独で実行可能にし、テスト・ビルドは修正結果がそろった後の feedback batch でのみ要求する
- ledger にない事実を補完しない。不足があれば確認専用 part を作る
